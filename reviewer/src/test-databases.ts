/**
 * One empty Postgres database per variable in `reviewer.databases`, created before setup and
 * dropped after the run.
 *
 * Every database is recorded before it is created, under its owner: a review, a sweep, or a
 * project's nightly checks. Only a recorded database is ever dropped. Its owner drops it when the
 * run ends, when the same review or sweep is resumed, at the project's next run of its checks, and
 * at `reset`. What a run that never comes back left is dropped by the next nightly run, once it
 * holds the machine.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';

import { db, schema } from './db/client.js';
import { CHECKS_LOCK_CLASS, checksLockKey, tryLock } from './locks.js';
import type { ProjectSetup } from './project-config.js';

export interface PlannedDatabase {
  variable: string;
  name: string;
  address: string;
}

/**
 * As a role that may create databases. Never the code reviewer's `DATABASE_URL`: the project's
 * commands are handed addresses made from this one.
 */
export const TEST_DATABASES_SETTING = 'REVIEWER_TEST_DATABASES_URL';

/**
 * `run` is a token unique to this run, so two runs never plan the same name. Throws, saying what is
 * missing, when databases are named and there is no server to create them on.
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

// A Postgres address as it appears in a command's output, up to the space or quote that ends it.
const POSTGRES_ADDRESS = /postgres(?:ql)?:\/\/[^\s"'`<>]+/g;
// Punctuation of the sentence an address sits in, not of the address.
const AFTER_ADDRESS = /[),.;:\]}]+$/;
const OWN_NAME_IN_ADDRESS = /\/reviewer_test_[0-9a-f]{16}_[0-9]+(?:[?#]|$)/;

/**
 * For text that leaves the machine: an address holds the password of the role that creates every
 * project's test databases. Any Postgres address on the server at `serverUrl`, or naming a database
 * this code made, is replaced whole, and the password is removed wherever else it stands, since a
 * command can print the parts of an address apart.
 */
export function withoutTestDatabaseAddresses(text: string, serverUrl: string | undefined): string {
  let server: URL;
  try {
    server = serverAddress(serverUrl ?? '');
  } catch {
    return text;
  }
  const onServer = (address: string) => {
    try {
      return new URL(address).host === server.host;
    } catch {
      return false;
    }
  };
  let safe = text.replace(POSTGRES_ADDRESS, (found) => {
    const after = AFTER_ADDRESS.exec(found)?.[0] ?? '';
    const address = found.slice(0, found.length - after.length);
    return onServer(address) || OWN_NAME_IN_ADDRESS.test(address) ? `[test database address]${after}` : found;
  });
  for (const password of new Set([server.password, decoded(server.password)])) {
    if (password !== '') safe = safe.replaceAll(password, '[redacted]');
  }
  return safe;
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** A resumed review or sweep has the same owner, and so has the next run of a project's checks. */
export type RunOwner = `review:${number}` | `sweep:${number}` | `checks:${string}`;

export interface DatabaseRecord {
  name: string;
  owner: string;
}

/**
 * Its own, from this process or from an earlier one that was interrupted. Never another run's,
 * which may be using them right now.
 */
export function leftBehind(records: DatabaseRecord[], owner: RunOwner): string[] {
  return records.filter((record) => record.owner === owner).map((record) => record.name);
}

/**
 * As a nightly run that has just taken the machine sorts them. No agent job is running then, so
 * every review's and sweep's were left by a run that died. A project's checks run outside the
 * machine's lock: theirs are dropped only while that project's checks lock can be had. An owner in
 * no known form is not listed.
 */
export function ownersLeftBehind(records: DatabaseRecord[]): { agentJobs: RunOwner[]; checks: Array<{ project: string; owner: RunOwner }> } {
  const owners = [...new Set(records.map((record) => record.owner))];
  return {
    agentJobs: owners.filter((owner): owner is RunOwner => /^(?:review|sweep):\d+$/.test(owner)),
    checks: owners.flatMap((owner) => {
      const project = /^checks:(.+)$/.exec(owner)?.[1];
      return project ? [{ project, owner: owner as RunOwner }] : [];
    }),
  };
}

/** The addresses travel in `env`, to the project's commands only, never in the code reviewer's own environment. */
export function withAddresses(project: ProjectSetup, planned: PlannedDatabase[]): ProjectSetup {
  const addresses = Object.fromEntries(planned.map(({ variable, address }) => [variable, address]));
  return { ...project, env: { ...project.env, ...addresses } };
}

/**
 * Called each time a checkout is about to be set up. What `owner` created before is dropped first,
 * so setup always meets empty databases.
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
 * A drop that fails is reported and never replaces the run's own result or error. Its databases
 * stay recorded, and are dropped when the same owner next runs or by the next nightly run.
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

/**
 * For a nightly run that holds the machine: the databases of runs that will never drop their own.
 * Returns a line for each thing done or left; a drop that fails is a line too and stops nothing.
 */
export async function dropDatabasesLeftBehind(): Promise<string[]> {
  if (!process.env[TEST_DATABASES_SETTING]?.trim()) return [];
  const lines: string[] = [];
  const drop = async (owner: RunOwner) => {
    try {
      await dropTestDatabases(owner);
      lines.push(`dropped the test databases ${owner} left behind`);
    } catch (err) {
      lines.push(`could not drop the test databases ${owner} left behind (${String(err).split('\n')[0]}); they stay recorded`);
    }
  };
  const left = ownersLeftBehind(await db.select().from(schema.testDatabases));
  for (const owner of left.agentJobs) await drop(owner);
  for (const { project, owner } of left.checks) {
    // Held while they go, so a run of the checks cannot start on databases that are being dropped.
    const lock = await tryLock(checksLockKey(project), CHECKS_LOCK_CLASS);
    if (!lock) {
      lines.push(`${project}'s nightly checks are running: their test databases are left to that run`);
      continue;
    }
    try {
      await drop(owner);
    } finally {
      await lock.release();
    }
  }
  return lines;
}

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
