/**
 * The databases a project's tests need (`reviewer.databases` in its project config): one empty
 * Postgres database per named variable, created before setup and dropped after the run.
 *
 * Every database is recorded in the code reviewer's own database before it is created, and only a
 * recorded database is ever dropped, by the run it was recorded for. A run that is killed leaves
 * its record, and drops what it left when it is resumed.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';

import { db, schema } from './db/client.js';
import type { ProjectSetup } from './project-config.js';

/** One database a run is to create, and the variable its address goes in. */
export interface PlannedDatabase {
  variable: string;
  name: string;
  address: string;
}

/**
 * The server the databases are created on, as a role that may create databases. Never the code
 * reviewer's `DATABASE_URL`: the project's commands are handed addresses made from this one.
 */
export const TEST_DATABASES_SETTING = 'REVIEWER_TEST_DATABASES_URL';

/**
 * The databases to create for `variables` on the server at `serverUrl`, one each. `run` is a token
 * unique to this run, so two runs never plan the same name whatever projects they are for. Throws,
 * saying what is missing, when databases are named and there is no server to create them on.
 */
export function planDatabases(variables: string[], serverUrl: string | undefined, run: string): PlannedDatabase[] {
  if (variables.length === 0) return [];
  if (!serverUrl?.trim()) {
    throw new Error(
      `devkit.json names reviewer.databases (${variables.join(', ')}), but this machine cannot create them: ` +
        `${TEST_DATABASES_SETTING} is not set. Set it to the address of a Postgres server, as a role that ` +
        'may create databases.',
    );
  }
  return variables.map((variable, index) => {
    const name = ownName(`reviewer_test_${run}_${index}`);
    const address = serverAddress(serverUrl);
    address.pathname = `/${name}`;
    return { variable, name, address: address.href };
  });
}

function serverAddress(serverUrl: string): URL {
  // The value is never put in the message: it holds the role's password.
  const invalid = new Error(`${TEST_DATABASES_SETTING} is not a Postgres address (postgres://role:password@host:port/database)`);
  let address: URL;
  try {
    address = new URL(serverUrl.trim());
  } catch {
    throw invalid;
  }
  if (address.protocol !== 'postgres:' && address.protocol !== 'postgresql:') throw invalid;
  return address;
}

/** The shape of every name planDatabases gives: the prefix, a run's 16 hex digits, an index. */
const OWN_NAME = /^reviewer_test_[0-9a-f]{16}_[0-9]+$/;

/** `name`, or a refusal: no statement names a database this code did not make, whatever a record holds. */
function ownName(name: string): string {
  if (!OWN_NAME.test(name)) throw new Error(`${JSON.stringify(name)} is not a database the code reviewer created`);
  return name;
}

/** From `template0`, so the database is empty whatever the server's `template1` has been given. */
export function createStatement(name: string): string {
  return `CREATE DATABASE "${ownName(name)}" TEMPLATE template0`;
}

/** Forced, so a connection a project's command left open does not keep the database alive. */
export function dropStatement(name: string): string {
  return `DROP DATABASE IF EXISTS "${ownName(name)}" WITH (FORCE)`;
}

/** The run that databases belong to: a review or a sweep, by its id. A resumed run has the same owner. */
export type RunOwner = `review:${number}` | `sweep:${number}`;

/** A database recorded as created, and the run it was created for. */
export interface DatabaseRecord {
  name: string;
  owner: string;
}

/**
 * The recorded databases that are `owner`'s to drop: its own, from this process or from an earlier
 * one that was interrupted. Never another run's, which may be using them right now.
 */
export function leftBehind(records: DatabaseRecord[], owner: RunOwner): string[] {
  return records.filter((record) => record.owner === owner).map((record) => record.name);
}

/**
 * `project` with each database's address in its variable, over a value `env` gave the name. They
 * travel in `env`, to the project's commands only, never in the code reviewer's own environment.
 */
export function withAddresses(project: ProjectSetup, planned: PlannedDatabase[]): ProjectSetup {
  const addresses = Object.fromEntries(planned.map(({ variable, address }) => [variable, address]));
  return { ...project, env: { ...project.env, ...addresses } };
}

/**
 * Create the databases `project` names and return it with their addresses in its env. Called each
 * time a checkout is about to be set up; what `owner` created before, in this process or one that
 * was killed, is dropped first, so setup always meets empty databases.
 */
export async function provideTestDatabases(owner: RunOwner, project: ProjectSetup): Promise<ProjectSetup> {
  // Planned before anything is touched: a machine that cannot create the databases says so first.
  const planned = planDatabases(project.databases, process.env[TEST_DATABASES_SETTING], randomBytes(8).toString('hex'));
  await dropTestDatabases(owner);
  if (planned.length === 0) return project;
  await onServer(async (statement) => {
    for (const { name } of planned) {
      // Recorded first: a run killed between the two leaves a record with no database, which
      // dropping tolerates, and never a database with no record.
      await db.insert(schema.testDatabases).values({ name, owner });
      await statement(createStatement(name));
    }
  });
  console.log(`created ${planned.length} empty database(s) for: ${planned.map((p) => p.variable).join(', ')}`);
  return withAddresses(project, planned);
}

/** Drop every database recorded for `owner`, forgetting each once it is gone. */
export async function dropTestDatabases(owner: RunOwner): Promise<void> {
  // No server, so nothing was created here: a run on such a machine never reads the table.
  if (!process.env[TEST_DATABASES_SETTING]?.trim()) return;
  const names = leftBehind(await db.select().from(schema.testDatabases), owner);
  if (names.length === 0) return;
  await onServer(async (statement) => {
    for (const name of names) {
      await statement(dropStatement(name));
      await db.delete(schema.testDatabases).where(eq(schema.testDatabases.name, name));
    }
  });
  console.log(`dropped ${names.length} test database(s)`);
}

/**
 * Do `run`, then drop `owner`'s databases whichever way it ended. A drop that fails is reported
 * and never replaces the run's own result or error; its databases stay recorded, and are dropped
 * when the same review or sweep next runs.
 */
export async function droppingTestDatabases<T>(owner: RunOwner, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    await dropTestDatabases(owner).catch((err) => {
      console.error(`could not drop the test databases of ${owner} (${String(err).split('\n')[0]}); they stay recorded`);
    });
  }
}

/** Run `work` on one connection to the server the databases live on. */
async function onServer(work: (statement: (sql: string) => Promise<void>) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: serverAddress(process.env[TEST_DATABASES_SETTING] ?? '').href });
  await client.connect();
  try {
    await work(async (sql) => {
      await client.query(sql);
    });
  } finally {
    await client.end();
  }
}
