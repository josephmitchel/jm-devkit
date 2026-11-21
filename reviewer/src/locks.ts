import { createHash } from 'node:crypto';

import { pool } from './db/client.js';
import { why } from './log.js';

/**
 * Every Postgres advisory lock the code reviewer takes. Each is held on a connection of its own, so
 * a holder that dies lets go.
 *
 * They are session locks: they do not hold through a pooler that shares sessions, so whoever takes
 * one to start agent jobs under it first shows that it holds ({@link lockFault}).
 */

// 'code': arbitrary but stable, so every process picks the same locks.
export const LOCK_CLASS = 0x636f6465;
/** So two processes that start together do not both apply a migration. */
export const MIGRATE_LOCK = 1;
/** Held for the whole of a pass of the poller. */
export const PASS_LOCK = 2;
/**
 * Held by whoever is running an agent job on the machine. Only the `nightly` and `queue` commands
 * take it and the next (`machineFor` in queue.ts says who may). `sweep` and `run` do not: a project
 * still on GitHub Actions runs them against the same database and must not wait.
 */
export const MACHINE_LOCK = 3;
/** Held by a nightly run from its start to its end, its wait for the machine included. */
export const NIGHTLY_LOCK = 4;

// A class of its own for the locks that are one per project, so no project's key can be a lock above.
export const CHECKS_LOCK_CLASS = 0x63686b73; // 'chks'

/**
 * Two runs of a project's checks share a checkout and its test databases, so one goes at a time.
 * Two projects whose names hash alike (one chance in two thousand million) could not run their
 * checks at once.
 */
export function checksLockKey(slug: string): number {
  return createHash('sha256').update(slug.toLowerCase()).digest().readUInt32BE(0) >>> 1;
}

export interface Held {
  release(): Promise<void>;
  lost(): boolean;
  /** Tries the lock from a second connection while it is held here. Takes and lets go of nothing. */
  probe(): Promise<LockProbe>;
}

/** A session is a backend's pid. */
export interface LockProbe {
  holderSession: number;
  holderSessionAfter: number;
  secondSession: number;
  secondTook: boolean;
}

/**
 * A lock does not hold through a pooler that shares sessions: two connections can be one session,
 * which is given the same lock twice, and one connection's statements can run in different
 * sessions.
 */
export function lockHolds(probe: LockProbe): { holds: true } | { holds: false; why: string } {
  if (probe.secondTook) return { holds: false, why: 'a second connection was given the lock while it was held' };
  if (probe.secondSession === probe.holderSession) return { holds: false, why: 'two connections share one database session' };
  if (probe.holderSessionAfter !== probe.holderSession) return { holds: false, why: 'the connection holding the lock changed database session' };
  return { holds: true };
}

export class MachineLockError extends Error {
  constructor(why: string) {
    super(`the machine's lock does not hold on this database (${why}): DATABASE_URL must be a direct address, not a pooled one`);
    this.name = 'MachineLockError';
  }
}

/** To be asked before any agent job is started under the lock. */
export async function lockFault(held: Held): Promise<MachineLockError | null> {
  const proof = lockHolds(await held.probe());
  return proof.holds ? null : new MachineLockError(proof.why);
}

// A connection idle for hours is one a network drops, and a dropped connection drops its lock
// unseen. Asked something every minute it is kept, and its loss is seen.
const KEPT_ALIVE_EVERY_MS = 60_000;

/** Null when somebody holds it. */
export function tryLock(key: number, lockClass: number = LOCK_CLASS): Promise<Held | null> {
  return hold(key, lockClass, false);
}

export async function takeLock(key: number, lockClass: number = LOCK_CLASS): Promise<Held> {
  return (await hold(key, lockClass, true))!;
}

async function hold(key: number, lockClass: number, wait: boolean): Promise<Held | null> {
  const client = await pool.connect();
  let isLost = false;
  const lost = (err: unknown) => {
    isLost = true;
    console.warn(`the connection holding lock ${key} was lost (${why(err)}): the lock is no longer held`);
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

/** By any process. Reading takes none of them. */
export async function locksHeld(lockClass: number = LOCK_CLASS): Promise<Set<number>> {
  const { rows } = await pool.query(
    `select objid::int8 as key from pg_locks
      where locktype = 'advisory' and granted and classid = $1::oid and objsubid = 2
        and database = (select oid from pg_database where datname = current_database())`,
    [lockClass],
  );
  return new Set(rows.map((row) => Number(row.key)));
}
