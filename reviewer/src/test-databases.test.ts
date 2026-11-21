import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectSetup } from './project-config.js';
import {
  createStatement,
  dropStatement,
  droppingTestDatabases,
  leftBehind,
  ownersLeftBehind,
  planDatabases,
  provideTestDatabases,
  withAddresses,
  withoutTestDatabaseAddresses,
} from './test-databases.js';
import { repoCommandEnv, runRepoCommand } from './workspace.js';

const SERVER = 'postgres://tests:s3cret@db.example:5433/postgres?sslmode=require';
const RUN = '0123456789abcdef';

describe('planDatabases', () => {
  it('gives each variable a database of its own on the server, at an address that keeps the server\'s options', () => {
    expect(planDatabases(['APP_DATABASE_URL', 'AUDIT_DATABASE_URL'], SERVER, RUN)).toEqual([
      {
        variable: 'APP_DATABASE_URL',
        name: 'reviewer_test_0123456789abcdef_0',
        address: 'postgres://tests:s3cret@db.example:5433/reviewer_test_0123456789abcdef_0?sslmode=require',
      },
      {
        variable: 'AUDIT_DATABASE_URL',
        name: 'reviewer_test_0123456789abcdef_1',
        address: 'postgres://tests:s3cret@db.example:5433/reviewer_test_0123456789abcdef_1?sslmode=require',
      },
    ]);
  });

  it('socket-style server addresses keep their host option', () => {
    const [planned] = planDatabases(['APP_DATABASE_URL'], 'postgresql:///postgres?host=/var/run/postgresql', RUN);
    expect(planned.address).toBe('postgresql:///reviewer_test_0123456789abcdef_0?host=/var/run/postgresql');
  });

  it('refuses a project that names databases when the machine has no server to create them on', () => {
    for (const missing of [undefined, '', '  ']) {
      expect(() => planDatabases(['APP_DATABASE_URL', 'AUDIT_DATABASE_URL'], missing, RUN)).toThrow(
        'devkit.json names reviewer.databases (APP_DATABASE_URL, AUDIT_DATABASE_URL), but this machine cannot ' +
          'create them: REVIEWER_TEST_DATABASES_URL is not set. Set it to the address of a Postgres server, ' +
          'as a role that may create databases.',
      );
    }
  });

  it('asks for no server when the project names no databases', () => {
    expect(planDatabases([], undefined, RUN)).toEqual([]);
  });

  it('says the setting is not an address without repeating it, since it holds a password', () => {
    const attempt = () => planDatabases(['APP_DATABASE_URL'], 'tests:s3cret@db.example', RUN);
    expect(attempt).toThrow('REVIEWER_TEST_DATABASES_URL is not a Postgres address');
    expect(attempt).not.toThrow(/s3cret/);
  });
});

describe('the statements that create and drop a database', () => {
  it('quote the name, start from the empty template, and drop past a connection left open', () => {
    expect(createStatement('reviewer_test_0123456789abcdef_0')).toBe(
      'CREATE DATABASE "reviewer_test_0123456789abcdef_0" TEMPLATE template0',
    );
    expect(dropStatement('reviewer_test_0123456789abcdef_12')).toBe(
      'DROP DATABASE IF EXISTS "reviewer_test_0123456789abcdef_12" WITH (FORCE)',
    );
  });

  it('refuse any name this code would not have made', () => {
    for (const name of [
      'reviewer',
      'postgres',
      'reviewer_test_',
      'reviewer_test_0123456789abcdef',
      'reviewer_test_0123456789ABCDEF_0',
      'reviewer_test_0123456789abcdef_0 ',
      'reviewer_test_0123456789abcdef_0"; DROP DATABASE reviewer; --',
      'x_reviewer_test_0123456789abcdef_0',
      'reviewer_test_0123456789abcdef_0\nreviewer',
    ]) {
      expect(() => dropStatement(name), name).toThrow('is not a database the code reviewer created');
      expect(() => createStatement(name), name).toThrow('is not a database the code reviewer created');
    }
  });

  it('never get a name from a run token that is not one', () => {
    expect(() => planDatabases(['APP_DATABASE_URL'], SERVER, 'x"; DROP DATABASE reviewer; --')).toThrow(
      'is not a database the code reviewer created',
    );
  });
});

describe('leftBehind', () => {
  const records = [
    { name: 'reviewer_test_aaaaaaaaaaaaaaaa_0', owner: 'review:7' },
    { name: 'reviewer_test_aaaaaaaaaaaaaaaa_1', owner: 'review:7' },
    { name: 'reviewer_test_bbbbbbbbbbbbbbbb_0', owner: 'sweep:7' },
    { name: 'reviewer_test_cccccccccccccccc_0', owner: 'review:70' },
  ];

  it('is every database recorded for this run, and none recorded for another', () => {
    expect(leftBehind(records, 'review:7')).toEqual([
      'reviewer_test_aaaaaaaaaaaaaaaa_0',
      'reviewer_test_aaaaaaaaaaaaaaaa_1',
    ]);
    expect(leftBehind(records, 'sweep:7')).toEqual(['reviewer_test_bbbbbbbbbbbbbbbb_0']);
  });

  it('is nothing for a run with no record', () => {
    expect(leftBehind(records, 'sweep:8')).toEqual([]);
    expect(leftBehind([], 'review:7')).toEqual([]);
  });
});

describe('whose databases a nightly run drops as it starts, with the machine in hand', () => {
  const records = [
    { name: 'reviewer_test_aaaaaaaaaaaaaaaa_0', owner: 'review:7' },
    { name: 'reviewer_test_aaaaaaaaaaaaaaaa_1', owner: 'review:7' },
    { name: 'reviewer_test_bbbbbbbbbbbbbbbb_0', owner: 'sweep:12' },
    { name: 'reviewer_test_cccccccccccccccc_0', owner: 'checks:acme/widgets' },
    { name: 'reviewer_test_dddddddddddddddd_0', owner: 'checks:acme/widgets' },
    { name: 'reviewer_test_eeeeeeeeeeeeeeee_0', owner: 'checks:Zenith/anvils' },
  ];

  it('are those of every review and sweep on record, each owner once: no agent job is running, so each was left by a run that died', () => {
    expect(ownersLeftBehind(records).agentJobs).toEqual(['review:7', 'sweep:12']);
  });

  it("names a project's checks apart, by project: they run outside the machine's lock, so each is asked of its own", () => {
    expect(ownersLeftBehind(records).checks).toEqual([
      { project: 'acme/widgets', owner: 'checks:acme/widgets' },
      { project: 'Zenith/anvils', owner: 'checks:Zenith/anvils' },
    ]);
  });

  it('leaves alone a record whose owner it does not know', () => {
    const odd = [
      { name: 'reviewer_test_ffffffffffffffff_0', owner: 'review:seven' },
      { name: 'reviewer_test_ffffffffffffffff_1', owner: 'by hand' },
      { name: 'reviewer_test_ffffffffffffffff_2', owner: 'checks:' },
    ];
    expect(ownersLeftBehind(odd)).toEqual({ agentJobs: [], checks: [] });
  });

  it('is nothing with nothing on record', () => {
    expect(ownersLeftBehind([])).toEqual({ agentJobs: [], checks: [] });
  });
});

describe('withAddresses', () => {
  const project: ProjectSetup = {
    source: 'devkit.json',
    setupCommand: 'npm ci',
    testCommands: [{ name: 'db', command: 'npm run test:db' }],
    redundancy: 1,
    harnessNotes: null,
    extraContext: null,
    env: { APP_DATABASE_URL: 'postgres://localhost:5432/app_test', LOG_LEVEL: 'error' },
    databases: ['APP_DATABASE_URL', 'DATABASE_URL'],
    nightlyChecks: [],
  };
  const planned = planDatabases(project.databases, SERVER, RUN);

  it('puts each address in its variable for the project\'s commands, over a value env gave the name', () => {
    expect(withAddresses(project, planned)).toEqual({
      ...project,
      env: {
        APP_DATABASE_URL: 'postgres://tests:s3cret@db.example:5433/reviewer_test_0123456789abcdef_0?sslmode=require',
        DATABASE_URL: 'postgres://tests:s3cret@db.example:5433/reviewer_test_0123456789abcdef_1?sslmode=require',
        LOG_LEVEL: 'error',
      },
    });
    expect(project.env.APP_DATABASE_URL).toBe('postgres://localhost:5432/app_test');
  });

  it('reaches a project command, which sees neither the server setting nor the code reviewer\'s own database', async () => {
    const reviewerEnv = {
      PATH: process.env.PATH,
      DATABASE_URL: 'postgres://reviewer:pw@db.example/reviewer',
      REVIEWER_TEST_DATABASES_URL: SERVER,
    };
    const env = repoCommandEnv(reviewerEnv, withAddresses(project, planned).env);
    expect(env.DATABASE_URL).toBe('postgres://tests:s3cret@db.example:5433/reviewer_test_0123456789abcdef_1?sslmode=require');
    expect(env).not.toHaveProperty('REVIEWER_TEST_DATABASES_URL');
    expect(reviewerEnv.DATABASE_URL).toBe('postgres://reviewer:pw@db.example/reviewer');

    const before = process.env.APP_DATABASE_URL;
    const command = 'test "$APP_DATABASE_URL" = "postgres://tests:s3cret@db.example:5433/reviewer_test_0123456789abcdef_0?sslmode=require"';
    expect((await runRepoCommand('/tmp', command, withAddresses(project, planned).env, 10_000)).passed).toBe(true);
    expect(process.env.APP_DATABASE_URL).toBe(before);
  });
});

/**
 * A project's command can print the address it was handed, and the end of a failed run's output
 * is posted to the project's failure issue. The address holds the password of the role that
 * creates every project's test databases.
 */
describe("keeping a test database's address out of what is posted to GitHub", () => {
  const [app] = planDatabases(['APP_DATABASE_URL'], SERVER, RUN);

  it('replaces the address wherever the output holds it', () => {
    const output = `connecting to ${app.address}\nError: connect ECONNREFUSED (url="${app.address}"), giving up`;
    expect(withoutTestDatabaseAddresses(output, SERVER)).toBe(
      'connecting to [test database address]\nError: connect ECONNREFUSED (url="[test database address]"), giving up',
    );
  });

  it('replaces the address of any other database on that server, which carries the same password', () => {
    const output = 'tried postgresql://tests:s3cret@db.example:5433/app_test?schema=public then postgres://tests@db.example:5433/postgres';
    expect(withoutTestDatabaseAddresses(output, SERVER)).toBe('tried [test database address] then [test database address]');
  });

  it('replaces the address of a database the code reviewer made, however the server is spelled', () => {
    const output = 'DATABASE_URL=postgres://tests@127.0.0.1/reviewer_test_0123456789abcdef_1';
    expect(withoutTestDatabaseAddresses(output, SERVER)).toBe('DATABASE_URL=[test database address]');
  });

  it("removes the role's password where it stands alone, as the setting spells it and as a driver decodes it", () => {
    const server = 'postgres://tests:p%40ss%2Fw0rd@db.example:5433/postgres';
    const output = 'PGPASSWORD=p@ss/w0rd psql -h db.example\npassword "p%40ss%2Fw0rd" was refused';
    expect(withoutTestDatabaseAddresses(output, server)).toBe('PGPASSWORD=[redacted] psql -h db.example\npassword "[redacted]" was refused');
  });

  it("leaves another server's address alone, such as one the project's own config gives", () => {
    const output = 'connecting to postgres://postgres:postgres@localhost:5432/app_test';
    expect(withoutTestDatabaseAddresses(output, SERVER)).toBe(output);
  });

  it('changes nothing on a machine with no server for test databases, where none was handed out', () => {
    const output = `connecting to ${app.address}`;
    for (const none of [undefined, '', '  ', 'not an address']) expect(withoutTestDatabaseAddresses(output, none)).toBe(output);
  });
});

/**
 * A machine with no server for test databases: GitHub Actions, or a machine not yet given one.
 * Nothing here reaches a database: DATABASE_URL in this suite points nowhere, so a query would fail.
 */
describe('on a machine with no way to create databases', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.REVIEWER_TEST_DATABASES_URL;
    delete process.env.REVIEWER_TEST_DATABASES_URL;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.REVIEWER_TEST_DATABASES_URL = saved;
  });

  const project: ProjectSetup = {
    source: 'devkit.json',
    setupCommand: null,
    testCommands: [{ name: 'unit', command: 'npm test' }],
    redundancy: 1,
    harnessNotes: null,
    extraContext: null,
    env: { LOG_LEVEL: 'error' },
    databases: [],
    nightlyChecks: [],
  };

  it('a project that names databases fails the run, saying what is missing', async () => {
    await expect(provideTestDatabases('sweep:1', { ...project, databases: ['APP_DATABASE_URL'] })).rejects.toThrow(
      'devkit.json names reviewer.databases (APP_DATABASE_URL), but this machine cannot create them: ' +
        'REVIEWER_TEST_DATABASES_URL is not set.',
    );
  });

  it('a project that names none runs as before', async () => {
    expect(await provideTestDatabases('review:1', project)).toEqual(project);
    expect(await droppingTestDatabases('review:1', async () => 'passed')).toBe('passed');
  });

  it("a run's own failure is the one reported", async () => {
    await expect(
      droppingTestDatabases('review:1', async () => {
        throw new Error('setup command failed');
      }),
    ).rejects.toThrow('setup command failed');
  });
});
