// An app's database: a role and a database of the app's name on the machine's Postgres, which only
// that role may open. Root acts on Postgres as the `postgres` user; SQL reaches psql on its input.

import fs from 'node:fs';

const AS_POSTGRES = ['-u', 'postgres', '--'];

function psql({ run, paths }, sql) {
  const done = run('runuser', [...AS_POSTGRES, 'psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], { input: sql, cwd: paths.root });
  if (done.code !== 0) throw new Error(`psql failed: ${done.stderr.trim()}`);
  return done.stdout.trim();
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
export function dumpDatabase({ run, paths }, app, file) {
  const script = 'umask 077 && exec runuser -u postgres -- pg_dump --format=custom --dbname="$1" > "$2"';
  const done = run('/bin/sh', ['-c', script, 'sh', app, file], { cwd: paths.root });
  if (done.code === 0) return;
  fs.rmSync(file, { force: true });
  throw new Error(`could not dump ${app}'s database: ${done.stderr.trim()}`);
}
