import { pool } from './db/client.js';
import { LOCK_CLASS } from './migrate.js';

/**
 * The machine's locks. Jobs that run agents run one at a time on the machine, and these are how a
 * job knows whether it may: Postgres advisory locks, each held on a connection of its own, so a
 * holder that dies lets go. Who may take which, and when, is decided in queue.ts (`machineFor`).
 *
 * Only the commands that start agent jobs on the machine take them: the nightly run and the
 * queue. `sweep` and `run` themselves do not, because a project still on GitHub Actions runs them
 * against the same database and must not wait for this machine.
 *
 * They are session locks: they do not hold through a pooler that shares sessions.
 */

/** Held by whoever is running an agent job on the machine: a review, or the nightly run for its sweeps. */
export const MACHINE_LOCK = 3;
/** Held by a nightly run from its start to its end, its wait for the machine included. */
export const NIGHTLY_LOCK = 4;

export interface Held {
  release(): Promise<void>;
}

// A connection idle for hours is one a network drops, and a dropped connection drops its lock
// unseen. Asked something every minute it is kept, and its loss is at least said.
const KEPT_ALIVE_EVERY_MS = 60_000;

/** Take a lock if nobody holds it. It is held until released, or until this process ends. */
export async function tryLock(key: number): Promise<Held | null> {
  const client = await pool.connect();
  const lost = (err: unknown) =>
    console.warn(`the connection holding lock ${key} was lost (${err instanceof Error ? err.message : String(err)}): the lock is no longer held`);
  // Without a listener a connection dropped while it is checked out ends the process.
  client.on('error', lost);
  const letGo = (broken: boolean) => {
    client.off('error', lost);
    client.release(broken);
  };
  try {
    const { rows } = await client.query('select pg_try_advisory_lock($1, $2) as held', [LOCK_CLASS, key]);
    if (!rows[0].held) {
      letGo(false);
      return null;
    }
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
        await client.query('select pg_advisory_unlock($1, $2)', [LOCK_CLASS, key]);
        letGo(false);
      } catch {
        // A connection that cannot unlock is closed, which unlocks.
        letGo(true);
      }
    },
  };
}

/** Which of the machine's locks are held right now, by any process. Reading takes none of them. */
export async function locksHeld(): Promise<Set<number>> {
  const { rows } = await pool.query(
    `select objid::int8 as key from pg_locks
      where locktype = 'advisory' and granted and classid = $1::oid and objsubid = 2
        and database = (select oid from pg_database where datname = current_database())`,
    [LOCK_CLASS],
  );
  return new Set(rows.map((row) => Number(row.key)));
}
