/**
 * One agent job at a time is a rule only if a second session is really refused, which a stand-in
 * with one session cannot show. Not part of `npm test`; run it with
 * `REVIEWER_TEST_DATABASES_URL=<server> npm run test:postgres`, as a role that may create
 * databases. State is kept in a scratch database made on that server and dropped afterwards;
 * `DATABASE_URL` is never opened. No test here starts a review.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const given = process.env.REVIEWER_TEST_DATABASES_URL?.trim();
if (!given) {
  throw new Error('REVIEWER_TEST_DATABASES_URL is not set: give this suite a Postgres server, as a role that may create databases');
}
const serverUrl: string = given;
const stateDatabase = `reviewer_selftest_${randomBytes(6).toString('hex')}`;

async function onServer(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

// Imported once the scratch database exists: the code reviewer's client reads DATABASE_URL on import.
let locks: typeof import('./locks.js');
let queue: typeof import('./queue-run.js');
let state: typeof import('./db/client.js');

beforeAll(async () => {
  await onServer(`CREATE DATABASE ${pg.escapeIdentifier(stateDatabase)} TEMPLATE template0`);
  const address = new URL(serverUrl);
  address.pathname = `/${stateDatabase}`;
  process.env.DATABASE_URL = address.href;
  state = await import('./db/client.js');
  await (await import('./migrate.js')).runMigrations();
  locks = await import('./locks.js');
  queue = await import('./queue-run.js');
}, 60_000);

afterAll(async () => {
  await state?.pool.end();
  await onServer(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(stateDatabase)} WITH (FORCE)`);
});

beforeEach(async () => {
  await state.pool.query('delete from poller_events');
});

describe("the machine's lock", () => {
  it('is held by one taker at a time, and can be taken again once it is let go', async () => {
    const first = await locks.tryLock(locks.MACHINE_LOCK);
    expect(first).not.toBeNull();
    expect(await locks.tryLock(locks.MACHINE_LOCK)).toBeNull();
    await first!.release();
    const next = await locks.tryLock(locks.MACHINE_LOCK);
    expect(next).not.toBeNull();
    await next!.release();
  });

  it('is shown to hold on a direct address: tried from a second connection while it is held, it is refused', async () => {
    const held = await locks.tryLock(locks.MACHINE_LOCK);
    const probe = await held!.probe();
    expect(probe.secondTook).toBe(false);
    expect(probe.secondSession).not.toBe(probe.holderSession);
    expect(probe.holderSessionAfter).toBe(probe.holderSession);
    expect(await locks.lockFault(held!)).toBeNull();
    // The proof took nothing and let go of nothing.
    expect(await locks.locksHeld()).toEqual(new Set([locks.MACHINE_LOCK]));
    expect(held!.lost()).toBe(false);
    await held!.release();
    expect(await locks.locksHeld()).toEqual(new Set());
  });

  it('can be waited for: a taker that waits has the lock once its holder lets go, and not before', async () => {
    const first = await locks.tryLock(locks.MIGRATE_LOCK);
    let got = false;
    const waiting = locks.takeLock(locks.MIGRATE_LOCK).then((held) => {
      got = true;
      return held;
    });
    await new Promise((later) => setTimeout(later, 300));
    expect(got).toBe(false);
    await first!.release();
    const second = await waiting;
    expect(got).toBe(true);
    await second.release();
    expect(await locks.locksHeld()).toEqual(new Set());
  });

  it("is apart from the nightly run's: holding one does not take the other", async () => {
    const night = await locks.tryLock(locks.NIGHTLY_LOCK);
    const job = await locks.tryLock(locks.MACHINE_LOCK);
    expect(night).not.toBeNull();
    expect(job).not.toBeNull();
    await job!.release();
    await night!.release();
  });

  it("is apart from a project's checks lock, which is held by one run at a time and stands in no other project's way", async () => {
    const widgets = locks.checksLockKey('acme/widgets');
    const first = await locks.tryLock(widgets, locks.CHECKS_LOCK_CLASS);
    expect(first).not.toBeNull();
    expect(await locks.tryLock(widgets, locks.CHECKS_LOCK_CLASS)).toBeNull();
    expect(await locks.locksHeld(locks.CHECKS_LOCK_CLASS)).toEqual(new Set([widgets]));
    expect(await locks.locksHeld()).toEqual(new Set());
    const gadgets = await locks.tryLock(locks.checksLockKey('acme/gadgets'), locks.CHECKS_LOCK_CLASS);
    const job = await locks.tryLock(locks.MACHINE_LOCK);
    expect(gadgets).not.toBeNull();
    expect(job).not.toBeNull();
    await job!.release();
    await gadgets!.release();
    await first!.release();
    expect(await locks.locksHeld(locks.CHECKS_LOCK_CLASS)).toEqual(new Set());
  });

  it('can be seen to be held without being taken, and is seen free once it is let go', async () => {
    expect(await locks.locksHeld()).toEqual(new Set());
    const night = await locks.tryLock(locks.NIGHTLY_LOCK);
    expect(await locks.locksHeld()).toEqual(new Set([locks.NIGHTLY_LOCK]));
    const job = await locks.tryLock(locks.MACHINE_LOCK);
    expect(await locks.locksHeld()).toEqual(new Set([locks.NIGHTLY_LOCK, locks.MACHINE_LOCK]));
    // Looking took nothing: both are still refused to a second taker, and both come free.
    expect(await locks.tryLock(locks.NIGHTLY_LOCK)).toBeNull();
    await job!.release();
    await night!.release();
    expect(await locks.locksHeld()).toEqual(new Set());
  });

  it('is let go when the connection holding it is lost, as when its process dies', async () => {
    const dying = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await dying.connect();
    await dying.query('select pg_advisory_lock($1, $2)', [locks.LOCK_CLASS, locks.MACHINE_LOCK]);
    expect(await locks.tryLock(locks.MACHINE_LOCK)).toBeNull();
    await dying.end();
    // The server lets go as it closes the session, a moment after the client has gone.
    let taken = null;
    for (let tries = 0; taken === null && tries < 50; tries++) {
      taken = await locks.tryLock(locks.MACHINE_LOCK);
      if (taken === null) await new Promise((again) => setTimeout(again, 100));
    }
    expect(taken).not.toBeNull();
    await taken!.release();
  });
});

describe('a turn of the queue with a review on record', () => {
  const lines: string[] = [];
  const say = (line: string) => void lines.push(line);
  const event = async () => (await state.pool.query('select event, attempts, run_id, handled_at from poller_events')).rows;

  // What a pass keeps of a project it found handled: the queue starts nothing for any other.
  const handled = async (slug: string) => {
    const { inDatabase } = await import('./poller-pass.js');
    const config = JSON.stringify({ modules: ['process'], reviewer: { tests: [{ name: 'unit', command: 'npm test' }] } });
    await inDatabase.keep('app/installations?page=1', { etag: null, answer: { list: [11], full: false } });
    await inDatabase.keep('installation/11/repositories?page=1', { etag: null, answer: { list: [slug], full: false } });
    await inDatabase.keep(`repos/${slug}/default-branch`, { etag: null, answer: { head: 'a'.repeat(40), observed: { config, sweepWorkflow: false } } });
  };

  beforeEach(async () => {
    lines.length = 0;
    await state.pool.query('delete from github_answers');
    await handled('acme/widgets');
    await state.pool.query("insert into poller_events (project, event) values ('acme/widgets', 'labelled:12')");
  });

  it('starts nothing for a project the last pass no longer found, and leaves its review queued with the reason', async () => {
    await state.pool.query('delete from github_answers');
    expect(await queue.runQueueTurn(say)).toBe('nothing started');
    expect(lines).toEqual([
      "1 job(s) left queued: acme/widgets labelled:12 (the machine no longer handles its project (the code reviewer's App is no longer installed on it))",
    ]);
    expect(await event()).toEqual([{ event: 'labelled:12', attempts: 0, run_id: null, handled_at: null }]);
  });

  it('starts nothing while another agent job has the machine, and leaves the review queued as it was', async () => {
    const other = await locks.tryLock(locks.MACHINE_LOCK);
    try {
      expect(await queue.runQueueTurn(say)).toBe('nothing started');
    } finally {
      await other!.release();
    }
    expect(lines).toEqual(['1 job(s) left queued: acme/widgets labelled:12 (another agent job is running)']);
    expect(await event()).toEqual([{ event: 'labelled:12', attempts: 0, run_id: null, handled_at: null }]);
  });

  it('starts nothing while a nightly run is going, though nothing is running at that moment, and does not touch the machine', async () => {
    const night = await locks.tryLock(locks.NIGHTLY_LOCK);
    try {
      expect(await queue.runQueueTurn(say)).toBe('nothing started');
      // The nightly run, waiting, finds the machine free: the turn did not take it.
      expect(await locks.locksHeld()).toEqual(new Set([locks.NIGHTLY_LOCK]));
    } finally {
      await night!.release();
    }
    expect(lines).toEqual(['1 job(s) left queued: acme/widgets labelled:12 (the nightly run has the machine)']);
    expect(await event()).toEqual([{ event: 'labelled:12', attempts: 0, run_id: null, handled_at: null }]);
  });

  it('shows the same in status: what holds the machine, and the review waiting for it', async () => {
    const night = await locks.tryLock(locks.NIGHTLY_LOCK);
    const job = await locks.tryLock(locks.MACHINE_LOCK);
    try {
      const facts = await queue.queueStatusFacts();
      expect(facts.machine).toEqual({ agentJobRunning: true, nightlyGoing: true });
      expect(facts.decision.start).toBeNull();
      expect(facts.decision.waiting.map(({ job: waiting, why }) => `${waiting.event}: ${why}`)).toEqual(['labelled:12: the nightly run has the machine']);
    } finally {
      await job!.release();
      await night!.release();
    }
  });
});
