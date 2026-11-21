import { createHash } from 'node:crypto';

import { pool } from './db/client.js';

/**
 * Every Postgres advisory lock the code reviewer takes: the keys, and the one way a lock is taken,
 * tried, seen and let go. Each is held on a connection of its own, so a holder that dies lets go.
 *
 * They are session locks: they do not hold through a pooler that shares sessions, so whoever takes
 * one to start agent jobs under it first shows that it holds ({@link lockFault}).
 */

// 'code': arbitrary but stable, so every process picks the same locks.
export const LOCK_CLASS = 0x636f6465;
/** Held while migrations are applied, so two processes that start together do not both apply one. */
export const MIGRATE_LOCK = 1;
/** Held for the whole of a pass of the poller: passes do not overlap. */
export const PASS_LOCK = 2;
/**
 * Held by whoever is running an agent job on the machine: a review, or the nightly run for its
 * sweeps. With the next, it keeps agent jobs to one at a time; `machineFor` in queue.ts says who
 * may take which. Only the `nightly` and `queue` commands take them. `sweep` and `run` do not: a
 * project still on GitHub Actions runs them against the same database and must not wait.
 */
export const MACHINE_LOCK = 3;
/** Held by a nightly run from its start to its end, its wait for the machine included. */
export const NIGHTLY_LOCK = 4;

// A class of its own for the locks that are one per project, so no project's key can be a lock above.
export const CHECKS_LOCK_CLASS = 0x63686b73; // 'chks'

/**
 * The key of the lock held by a run of one project's nightly checks, in {@link CHECKS_LOCK_CLASS}.
 * Two runs share a checkout and the project's test databases, so one goes at a time. Two projects
 * whose names hash alike (one chance in two thousand million) could not run their checks at once.
 */
export function checksLockKey(slug: string): number {
  return createHash('sha256').update(slug.toLowerCase()).digest().readUInt32BE(0) >>> 1;
}

export interface Held {
  release(): Promise<void>;
  /** Whether the connection holding the lock has been lost, and the lock with it. */
  lost(): boolean;
  /** Try the lock from a second connection while it is held here. Takes and lets go of nothing. */
  probe(): Promise<LockProbe>;
}

/** What was seen when a held lock was tried from a second connection. A session is a backend's pid. */
export interface LockProbe {
  holderSession: number;
  /** The holder's session when asked again afterwards. */
  holderSessionAfter: number;
  secondSession: number;
  secondTook: boolean;
}

/**
 * Whether a lock held on this database address keeps a second taker out. It does not through a
 * pooler that shares sessions: there two connections can be one session, which is given the same
 * lock twice, and one connection's statements can run in different sessions.
 */
export function lockHolds(probe: LockProbe): { holds: true } | { holds: false; why: string } {
  if (probe.secondTook) return { holds: false, why: 'a second connection was given the lock while it was held' };
  if (probe.secondSession === probe.holderSession) return { holds: false, why: 'two connections share one database session' };
  if (probe.holderSessionAfter !== probe.holderSession) return { holds: false, why: 'the connection holding the lock changed database session' };
  return { holds: true };
}

/** The machine's lock does not hold, so "one agent job at a time" cannot be kept on this address. */
export class MachineLockError extends Error {
  constructor(why: string) {
    super(`the machine's lock does not hold on this database (${why}): DATABASE_URL must be a direct address, not a pooled one`);
    this.name = 'MachineLockError';
  }
}

/** The fault in a lock that is held, or null when it holds. To be asked before any agent job is started under it. */
export async function lockFault(held: Held): Promise<MachineLockError | null> {
  const proof = lockHolds(await held.probe());
  return proof.holds ? null : new MachineLockError(proof.why);
}

// A connection idle for hours is one a network drops, and a dropped connection drops its lock
// unseen. Asked something every minute it is kept, and its loss is seen.
const KEPT_ALIVE_EVERY_MS = 60_000;

/** Take a lock if nobody holds it. It is held until released, or until this process ends. */
export function tryLock(key: number, lockClass: number = LOCK_CLASS): Promise<Held | null> {
  return hold(key, lockClass, false);
}

/** Take a lock, waiting for whoever holds it to let go. */
export async function takeLock(key: number, lockClass: number = LOCK_CLASS): Promise<Held> {
  return (await hold(key, lockClass, true))!;
}

async function hold(key: number, lockClass: number, wait: boolean): Promise<Held | null> {
  const client = await pool.connect();
  let isLost = false;
  const lost = (err: unknown) => {
    isLost = true;
    console.warn(`the connection holding lock ${key} was lost (${err instanceof Error ? err.message : String(err)}): the lock is no longer held`);
  };
  // Without a listener a connection dropped while it is checked out ends the process.
  client.on('error', lost);
  const letGo = (broken: boolean) => {
    client.off('error', lost);
    client.release(broken);
  };
  const session = async () => Number((await client.query('select pg_backend_pid() as session')).rows[0].session);
  let holderSession: number;
  try {
    const { rows } = await client.query(
      wait ? 'select pg_advisory_lock($1, $2), true as held' : 'select pg_try_advisory_lock($1, $2) as held',
      [lockClass, key],
    );
    if (!rows[0].held) {
      letGo(false);
      return null;
    }
    holderSession = await session();
  } catch (err) {
    letGo(true);
    throw err;
  }
  const keptAlive = setInterval(() => client.query('select 1').catch(lost), KEPT_ALIVE_EVERY_MS);
  keptAlive.unref();
  return {
    async release() {
      clearInterval(keptAlive);
      try {
        await client.query('select pg_advisory_unlock($1, $2)', [lockClass, key]);
        letGo(false);
      } catch {
        // A connection that cannot unlock is closed, which unlocks.
        letGo(true);
      }
    },
    lost: () => isLost,
    async probe() {
      const second = await pool.connect();
      try {
        const { rows } = await second.query('select pg_try_advisory_lock($1, $2) as took, pg_backend_pid() as session', [lockClass, key]);
        if (rows[0].took) await second.query('select pg_advisory_unlock($1, $2)', [lockClass, key]);
        return { holderSession, holderSessionAfter: await session(), secondSession: Number(rows[0].session), secondTook: rows[0].took === true };
      } finally {
        second.release();
      }
    },
  };
}

/** Which locks of a class are held right now, by any process: the machine's unless said. Reading takes none of them. */
export async function locksHeld(lockClass: number = LOCK_CLASS): Promise<Set<number>> {
  const { rows } = await pool.query(
    `select objid::int8 as key from pg_locks
      where locktype = 'advisory' and granted and classid = $1::oid and objsubid = 2
        and database = (select oid from pg_database where datname = current_database())`,
    [lockClass],
  );
  return new Set(rows.map((row) => Number(row.key)));
}
