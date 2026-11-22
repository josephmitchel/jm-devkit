// An app's database: a role and a database of the app's name on the machine's Postgres, which only
// that role may open. Root acts on Postgres as the `postgres` user; SQL reaches psql on its input.

import fs from 'node:fs';

import { must } from './run.mjs';

const AS_POSTGRES = ['-u', 'postgres', '--'];

function psql({ run, paths }, sql) {
  const done = run('runuser', [...AS_POSTGRES, 'psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], { input: sql, cwd: paths.root });
  return must(done, 'psql failed').stdout.trim();
}

/** Run a Postgres tool as the postgres user from root's shell, which opens the files for it: `tool` is its command line and redirections, with `args` as "$1" and "$2". */
function postgresTool({ run, paths }, tool, args, first = '') {
  return run('/bin/sh', ['-c', `${first}exec runuser ${AS_POSTGRES.join(' ')} ${tool}`, 'sh', ...args], { cwd: paths.root });
}

/** Whether a role or a database of this name is already on the machine. */
export function databaseNameTaken(world, app) {
  return psql(world, `SELECT 1 FROM pg_roles WHERE rolname = '${app}' UNION ALL SELECT 1 FROM pg_database WHERE datname = '${app}';\n`) !== '';
}

/** Make the app's role and database if they are missing, and keep every other role out of the database. */
export function createDatabase(world, app) {
  psql(world, [
    `SELECT 'CREATE ROLE "${app}" LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${app}')\\gexec`,
    `SELECT 'CREATE DATABASE "${app}" OWNER "${app}"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${app}')\\gexec`,
    `REVOKE CONNECT ON DATABASE "${app}" FROM PUBLIC;`,
    '',
  ].join('\n'));
}

/** Give the app's role this password. Returns the database's address, as an app's `DATABASE_URL` has it. */
export function setDatabasePassword(world, app, password) {
  if (!/^[A-Za-z0-9]+$/.test(password)) throw new Error('a database password is letters and digits');
  psql(world, `ALTER ROLE "${app}" PASSWORD '${password}';\n`);
  const port = psql(world, 'SHOW port;\n');
  return `postgres://${app}:${password}@127.0.0.1:${port}/${app}`;
}

/**
 * Dump the app's database to `file`, root's alone, in pg_dump's custom format (pg_restore reads it).
 * A dump that fails leaves no file.
 */
export function dumpDatabase(world, app, file) {
  try {
    must(postgresTool(world, 'pg_dump --format=custom --dbname="$1" > "$2"', [app, file], 'umask 077 && '), `could not dump ${app}'s database`);
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
}

/** What keeps `file` from being a dump pg_restore can read, in pg_restore's words, or null when it is one. */
export function dumpFault(world, file) {
  const done = postgresTool(world, 'pg_restore --list < "$1" > /dev/null', [file]);
  return done.code === 0 ? null : done.stderr.trim() || `pg_restore exited with ${done.code}`;
}

/**
 * Put the dump in `file` in place of the app's database: the database is dropped, whoever is
 * connected, made again, and the dump read into it with the app's role owning what it holds.
 * A restore that fails leaves the database as far as it got.
 */
export function restoreDatabase(world, app, file) {
  psql(world, `DROP DATABASE IF EXISTS "${app}" WITH (FORCE);\n`);
  createDatabase(world, app);
  must(postgresTool(world, 'pg_restore --exit-on-error --no-owner --role="$1" --dbname="$1" < "$2"', [app, file]), `could not restore ${app}'s database`);
}

/** The password in `address` when it is the address of the app's database as `setDatabasePassword` gives it, and null otherwise. */
export function databasePassword(address, app) {
  const [, user, password, database] = /^postgres:\/\/([^:@/]+):([A-Za-z0-9]+)@127\.0\.0\.1:\d+\/([^/?#]+)$/.exec(address ?? '') ?? [];
  return user === app && database === app ? password : null;
}
