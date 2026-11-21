/**
 * The rules that keep an event from being handled twice hold in the database, not in the code that
 * asks. Run as locks.postgres.test.ts says.
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
let poller: typeof import('./poller-pass.js');
let state: typeof import('./db/client.js');

beforeAll(async () => {
  await onServer(`CREATE DATABASE ${pg.escapeIdentifier(stateDatabase)} TEMPLATE template0`);
  const address = new URL(serverUrl);
  address.pathname = `/${stateDatabase}`;
  process.env.DATABASE_URL = address.href;
  state = await import('./db/client.js');
  await (await import('./migrate.js')).runMigrations();
  poller = await import('./poller-pass.js');
}, 60_000);

afterAll(async () => {
  await state?.pool.end();
  await onServer(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(stateDatabase)} WITH (FORCE)`);
});

beforeEach(async () => {
  await state.pool.query('delete from poller_events');
  await state.pool.query('delete from poller_projects');
});

const at = (time: string) => new Date(`2026-11-20T${time}Z`);
const position = (seenTo: string, pullsEtag: string) => ({ startedAt: at('09:00:00'), seenTo: at(seenTo), pullsEtag, lastPassAt: at(seenTo) });
const events = async () => (await state.pool.query('select event, attempts, handled_at from poller_events order by event')).rows;

describe('the record of what the poller found', () => {
  it('holds an event once, however many passes find it', async () => {
    await poller.recordPass('acme/widgets', ['merged:12'], position('12:00:00', 'W/"one"'));
    await poller.recordPass('acme/widgets', ['merged:12', 'merged:13'], position('12:03:00', 'W/"two"'));
    expect(await events()).toEqual([
      { event: 'merged:12', attempts: 0, handled_at: null },
      { event: 'merged:13', attempts: 0, handled_at: null },
    ]);
    await expect(state.pool.query("insert into poller_events (project, event) values ('acme/widgets', 'merged:12')")).rejects.toThrow(/duplicate key/);
  });

  it('keeps the same event apart for two projects', async () => {
    await poller.recordPass('acme/widgets', ['merged:12'], position('12:00:00', 'W/"one"'));
    await poller.recordPass('acme/anvils', ['merged:12'], position('12:00:00', 'W/"one"'));
    expect(await events()).toHaveLength(2);
  });

  it("moves where the last pass got to, and keeps when the project's first pass was", async () => {
    await poller.recordPass('acme/widgets', [], position('12:00:00', 'W/"one"'));
    await poller.recordPass('acme/widgets', [], { ...position('12:03:00', 'W/"two"'), startedAt: at('11:11:11') });
    const { rows } = await state.pool.query('select started_at, seen_to, pulls_etag from poller_projects');
    expect(rows).toEqual([{ started_at: at('09:00:00'), seen_to: at('12:03:00'), pulls_etag: 'W/"two"' }]);
  });
});

describe('taking an event to run its command', () => {
  const command = { project: 'acme/widgets', event: 'merged:12', attempts: 0 };

  beforeEach(async () => {
    await poller.recordPass('acme/widgets', ['merged:12'], position('12:00:00', 'W/"one"'));
  });

  it('is won by one of two passes that decided the same command at the same moment', async () => {
    const taken = await Promise.all(Array.from({ length: 8 }, () => poller.takeEvent(command)));
    expect(taken.filter(Boolean)).toHaveLength(1);
    expect(await events()).toEqual([{ event: 'merged:12', attempts: 1, handled_at: null }]);
  });

  it('is refused to a pass that read the event before another took it', async () => {
    expect(await poller.takeEvent(command)).toBe(true);
    expect(await poller.takeEvent(command)).toBe(false);
    // The next pass reads one attempt and takes it from there.
    expect(await poller.takeEvent({ ...command, attempts: 1 })).toBe(true);
  });

  it('is refused once the event is handled', async () => {
    await state.pool.query("update poller_events set attempts = 1, handled_at = now() where event = 'merged:12'");
    expect(await poller.takeEvent({ ...command, attempts: 1 })).toBe(false);
  });
});

describe('two passes at once', () => {
  it('cannot be: the second does nothing while the first is going, and can once it is over', async () => {
    const order: string[] = [];
    const first = await poller.underPassLock(async () => {
      order.push('first started');
      const second = await poller.underPassLock(async () => 'second ran');
      order.push(`second: ${second}`);
      return 'first ran';
    });
    expect(first).toBe('first ran');
    expect(order).toEqual(['first started', 'second: not started']);
    expect(await poller.underPassLock(async () => 'third ran')).toBe('third ran');
  });
});
