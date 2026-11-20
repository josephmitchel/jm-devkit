import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectSetup } from './project-config.js';
import {
  createStatement,
  dropStatement,
  droppingTestDatabases,
  leftBehind,
  planDatabases,
  provideTestDatabases,
  withAddresses,
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
