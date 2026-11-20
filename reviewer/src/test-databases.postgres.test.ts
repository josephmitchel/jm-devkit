/**
 * Creating and dropping a project's test databases, against a real Postgres. Not part of
 * `npm test`: run it with `REVIEWER_TEST_DATABASES_URL=<server> npm run test:postgres`, the
 * address being a role that may create databases. It keeps the code reviewer's own state in a
 * scratch database it creates on that server and drops afterwards, so whatever `DATABASE_URL`
 * holds is never opened.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ProjectSetup } from './project-config.js';
import type { RunOwner } from './test-databases.js';

const given = process.env.REVIEWER_TEST_DATABASES_URL?.trim();
if (!given) {
  throw new Error('REVIEWER_TEST_DATABASES_URL is not set: give this suite a Postgres server, as a role that may create databases');
}
const serverUrl: string = given;

const stateDatabase = `reviewer_selftest_${randomBytes(6).toString('hex')}`;

function addressOf(database: string): string {
  const address = new URL(serverUrl);
  address.pathname = `/${database}`;
  return address.href;
}

function nameOf(address: string): string {
  return new URL(address).pathname.slice(1);
}

/** Run one statement at `address` on a connection of its own, returning the first row. */
async function query(address: string, sql: string, values: unknown[] = []): Promise<Record<string, unknown> | undefined> {
  const client = new pg.Client({ connectionString: address });
  await client.connect();
  try {
    return (await client.query(sql, values)).rows[0];
  } finally {
    await client.end();
  }
}

async function exists(database: string): Promise<boolean> {
  return (await query(serverUrl, 'select 1 as found from pg_database where datname = $1', [database])) !== undefined;
}

function projectNaming(databases: string[]): ProjectSetup {
  return {
    source: 'devkit.json',
    setupCommand: null,
    testCommands: [{ name: 'db', command: 'true' }],
    redundancy: 1,
    harnessNotes: null,
    extraContext: null,
    env: {},
    databases,
  };
}

// Imported once the scratch database exists: the code reviewer's client reads DATABASE_URL on import.
let databases: typeof import('./test-databases.js');
let state: typeof import('./db/client.js');

beforeAll(async () => {
  await query(serverUrl, `CREATE DATABASE ${pg.escapeIdentifier(stateDatabase)} TEMPLATE template0`);
  process.env.DATABASE_URL = addressOf(stateDatabase);
  state = await import('./db/client.js');
  await (await import('./migrate.js')).runMigrations();
  databases = await import('./test-databases.js');
}, 60_000);

const owners: RunOwner[] = [];
/** A run of its own for each test, cleaned up after it whatever the test did. */
function run(owner: RunOwner): RunOwner {
  owners.push(owner);
  return owner;
}

afterEach(async () => {
  for (const owner of owners.splice(0)) await databases.dropTestDatabases(owner);
});

afterAll(async () => {
  await state?.pool.end();
  await query(serverUrl, `DROP DATABASE IF EXISTS ${pg.escapeIdentifier(stateDatabase)} WITH (FORCE)`);
}, 60_000);

describe("a project's test databases, on a real Postgres", () => {
  it('gives each named variable the address of its own empty database', async () => {
    const owner = run('review:1');
    const provided = await databases.provideTestDatabases(owner, projectNaming(['APP_DATABASE_URL', 'AUDIT_DATABASE_URL']));

    const app = provided.env.APP_DATABASE_URL;
    const audit = provided.env.AUDIT_DATABASE_URL;
    expect(nameOf(app)).not.toBe(nameOf(audit));
    for (const address of [app, audit]) {
      const facts = await query(
        address,
        `select current_database() as name,
                (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname !~ '^pg_' and n.nspname <> 'information_schema') as relations`,
      );
      expect(facts).toEqual({ name: nameOf(address), relations: 0 });
    }

    await query(app, 'create table marker (id integer)');
    expect(await query(audit, "select to_regclass('public.marker')::text as marker")).toEqual({ marker: null });
  });

  it('leaves no database after a run that passed', async () => {
    const owner = run('sweep:2');
    let name = '';
    const outcome = await databases.droppingTestDatabases(owner, async () => {
      const provided = await databases.provideTestDatabases(owner, projectNaming(['APP_DATABASE_URL']));
      name = nameOf(provided.env.APP_DATABASE_URL);
      expect(await exists(name)).toBe(true);
      return 'swept';
    });

    expect(outcome).toBe('swept');
    expect(await exists(name)).toBe(false);
  });

  it('leaves no database after a run that failed, and fails with the run\'s own error', async () => {
    const owner = run('review:3');
    let name = '';
    const failing = databases.droppingTestDatabases(owner, async () => {
      const provided = await databases.provideTestDatabases(owner, projectNaming(['APP_DATABASE_URL']));
      name = nameOf(provided.env.APP_DATABASE_URL);
      throw new Error('setup command failed');
    });

    await expect(failing).rejects.toThrow('setup command failed');
    expect(name).not.toBe('');
    expect(await exists(name)).toBe(false);
  });

  it('leaves no database after a run that was interrupted and later resumed', async () => {
    const owner = run('review:4');
    // Interrupted: the databases were created and the process died before dropping them.
    const interrupted = await databases.provideTestDatabases(owner, projectNaming(['APP_DATABASE_URL', 'AUDIT_DATABASE_URL']));
    const before = [interrupted.env.APP_DATABASE_URL, interrupted.env.AUDIT_DATABASE_URL].map(nameOf);
    await query(interrupted.env.APP_DATABASE_URL, 'create table half_migrated (id integer)');

    let after = '';
    await databases.droppingTestDatabases(owner, async () => {
      const resumed = await databases.provideTestDatabases(owner, projectNaming(['APP_DATABASE_URL']));
      after = nameOf(resumed.env.APP_DATABASE_URL);
      for (const name of before) expect(await exists(name)).toBe(false);
      expect(await query(resumed.env.APP_DATABASE_URL, "select to_regclass('public.half_migrated')::text as left_over")).toEqual({
        left_over: null,
      });
    });

    expect(await exists(after)).toBe(false);
  });

  it('leaves no database when the resumed run names none any more', async () => {
    const owner = run('review:5');
    const interrupted = await databases.provideTestDatabases(owner, projectNaming(['APP_DATABASE_URL']));

    const resumed = await databases.provideTestDatabases(owner, projectNaming([]));

    expect(resumed.env).toEqual({});
    expect(await exists(nameOf(interrupted.env.APP_DATABASE_URL))).toBe(false);
  });

  it("never drops another run's databases", async () => {
    const review = run('review:6');
    const sweep = run('sweep:6');
    const theirs = await databases.provideTestDatabases(review, projectNaming(['APP_DATABASE_URL']));

    await databases.droppingTestDatabases(sweep, async () => {
      await databases.provideTestDatabases(sweep, projectNaming(['APP_DATABASE_URL']));
    });

    expect(await exists(nameOf(theirs.env.APP_DATABASE_URL))).toBe(true);
  });

  it('drops a database a project command left a connection open to', async () => {
    const owner = run('sweep:7');
    const provided = await databases.provideTestDatabases(owner, projectNaming(['APP_DATABASE_URL']));
    const lingering = new pg.Client({ connectionString: provided.env.APP_DATABASE_URL });
    // The server ends this connection when the database goes; that is the point, not a fault.
    lingering.on('error', () => {});
    await lingering.connect();

    await databases.dropTestDatabases(owner);

    expect(await exists(nameOf(provided.env.APP_DATABASE_URL))).toBe(false);
    await lingering.end().catch(() => {});
  });
});
