/**
 * The machine's locks and the queue's turn, against a real Postgres: one agent job at a time is a
 * rule only if a second session is really refused, which a stand-in with one session cannot show.
 * Not part of `npm test`: run it with `REVIEWER_TEST_DATABASES_URL=<server> npm run test:postgres`,
 * the address being a role that may create databases. It keeps the code reviewer's state in a
 * scratch database it creates on that server and drops afterwards, so whatever `DATABASE_URL`
 * holds is never opened. No test here starts a review: every turn it takes finds the machine taken.
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
let machine: typeof import('./machine.js');
let queue: typeof import('./queue-run.js');
let state: typeof import('./db/client.js');

beforeAll(async () => {
  await onServer(`CREATE DATABASE ${pg.escapeIdentifier(stateDatabase)} TEMPLATE template0`);
  const address = new URL(serverUrl);
  address.pathname = `/${stateDatabase}`;
  process.env.DATABASE_URL = address.href;
  state = await import('./db/client.js');
  await (await import('./migrate.js')).runMigrations();
  machine = await import('./machine.js');
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
    const first = await machine.tryLock(machine.MACHINE_LOCK);
    expect(first).not.toBeNull();
    expect(await machine.tryLock(machine.MACHINE_LOCK)).toBeNull();
    await first!.release();
    const next = await machine.tryLock(machine.MACHINE_LOCK);
    expect(next).not.toBeNull();
    await next!.release();
  });

  it('is shown to hold on a direct address: tried from a second connection while it is held, it is refused', async () => {
    const held = await machine.tryLock(machine.MACHINE_LOCK);
    const probe = await held!.probe();
    expect(probe.secondTook).toBe(false);
    expect(probe.secondSession).not.toBe(probe.holderSession);
    expect(probe.holderSessionAfter).toBe(probe.holderSession);
    expect(await machine.lockFault(held!)).toBeNull();
    // The proof took nothing and let go of nothing.
    expect(await machine.locksHeld()).toEqual(new Set([machine.MACHINE_LOCK]));
    expect(held!.lost()).toBe(false);
    await held!.release();
    expect(await machine.locksHeld()).toEqual(new Set());
  });

  it("is apart from the nightly run's: holding one does not take the other", async () => {
    const night = await machine.tryLock(machine.NIGHTLY_LOCK);
    const job = await machine.tryLock(machine.MACHINE_LOCK);
    expect(night).not.toBeNull();
    expect(job).not.toBeNull();
    await job!.release();
    await night!.release();
  });

  it('can be seen to be held without being taken, and is seen free once it is let go', async () => {
    expect(await machine.locksHeld()).toEqual(new Set());
    const night = await machine.tryLock(machine.NIGHTLY_LOCK);
    expect(await machine.locksHeld()).toEqual(new Set([machine.NIGHTLY_LOCK]));
    const job = await machine.tryLock(machine.MACHINE_LOCK);
    expect(await machine.locksHeld()).toEqual(new Set([machine.NIGHTLY_LOCK, machine.MACHINE_LOCK]));
    // Looking took nothing: both are still refused to a second taker, and both come free.
    expect(await machine.tryLock(machine.NIGHTLY_LOCK)).toBeNull();
    await job!.release();
    await night!.release();
    expect(await machine.locksHeld()).toEqual(new Set());
  });

  it('is let go when the connection holding it is lost, as when its process dies', async () => {
    const dying = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await dying.connect();
    await dying.query('select pg_advisory_lock($1, $2)', [0x636f6465, machine.MACHINE_LOCK]);
    expect(await machine.tryLock(machine.MACHINE_LOCK)).toBeNull();
    await dying.end();
    // The server lets go as it closes the session, a moment after the client has gone.
    let taken = null;
    for (let tries = 0; taken === null && tries < 50; tries++) {
      taken = await machine.tryLock(machine.MACHINE_LOCK);
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

  beforeEach(async () => {
    lines.length = 0;
    await state.pool.query("insert into poller_events (project, event) values ('acme/widgets', 'labelled:12')");
  });

  it('starts nothing while another agent job has the machine, and leaves the review queued as it was', async () => {
    const other = await machine.tryLock(machine.MACHINE_LOCK);
    try {
      expect(await queue.runQueueTurn(say)).toBe('nothing started');
    } finally {
      await other!.release();
    }
    expect(lines).toEqual(['1 job(s) left queued: acme/widgets labelled:12 (another agent job is running)']);
    expect(await event()).toEqual([{ event: 'labelled:12', attempts: 0, run_id: null, handled_at: null }]);
  });

  it('starts nothing while a nightly run is going, though nothing is running at that moment, and does not touch the machine', async () => {
    const night = await machine.tryLock(machine.NIGHTLY_LOCK);
    try {
      expect(await queue.runQueueTurn(say)).toBe('nothing started');
      // The nightly run, waiting, finds the machine free: the turn did not take it.
      expect(await machine.locksHeld()).toEqual(new Set([machine.NIGHTLY_LOCK]));
    } finally {
      await night!.release();
    }
    expect(lines).toEqual(['1 job(s) left queued: acme/widgets labelled:12 (the nightly run has the machine)']);
    expect(await event()).toEqual([{ event: 'labelled:12', attempts: 0, run_id: null, handled_at: null }]);
  });

  it('shows the same in status: what holds the machine, and the review waiting for it', async () => {
    const night = await machine.tryLock(machine.NIGHTLY_LOCK);
    const job = await machine.tryLock(machine.MACHINE_LOCK);
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
