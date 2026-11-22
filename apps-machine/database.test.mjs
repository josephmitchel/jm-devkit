import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createDatabase, databaseNameTaken, databasePassword, dumpDatabase, dumpFault, restoreDatabase, setDatabasePassword } from './database.mjs';
import { Interrupted, run as realRun } from './run.mjs';
import { fakeRun, machine, mode, tempDir, withUmask } from './test-helpers.mjs';

const PSQL = ['-u', 'postgres', '--', 'psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres'];

test('an app gets a role and a database of its name that only that role may open', () => {
  const paths = machine();
  const { run, calls } = fakeRun();
  createDatabase({ run, paths }, 'sample');
  assert.equal(calls.length, 1);
  const [{ program, args, input, cwd }] = calls;
  assert.deepEqual({ program, args, cwd }, { program: 'runuser', args: PSQL, cwd: paths.root });
  assert.match(input, /CREATE ROLE "sample" LOGIN'? WHERE NOT EXISTS \(SELECT FROM pg_roles WHERE rolname = 'sample'\)/);
  assert.match(input, /CREATE DATABASE "sample" OWNER "sample"'? WHERE NOT EXISTS \(SELECT FROM pg_database WHERE datname = 'sample'\)/);
  assert.match(input, /^REVOKE CONNECT ON DATABASE "sample" FROM PUBLIC;$/m);
  assert.doesNotMatch(input, /SUPERUSER|CREATEDB|CREATEROLE|PASSWORD/);
});

test('a database that cannot be made fails with what psql said', () => {
  const { run } = fakeRun(() => ({ code: 3, stderr: 'psql: error: connection refused\n' }));
  assert.throws(() => createDatabase({ run, paths: machine() }, 'sample'), /^Error: psql failed: psql: error: connection refused$/);
});

test('a name a role or a database already has is found before anything is made for it', () => {
  const paths = machine();
  const free = fakeRun();
  assert.equal(databaseNameTaken({ run: free.run, paths }, 'sample'), false);
  assert.match(free.calls[0].input, /FROM pg_roles WHERE rolname = 'sample'/);
  assert.match(free.calls[0].input, /FROM pg_database WHERE datname = 'sample'/);
  assert.doesNotMatch(free.calls[0].input, /CREATE|ALTER|REVOKE|DROP/);
  const taken = fakeRun(() => ({ stdout: '1\n' }));
  assert.equal(databaseNameTaken({ run: taken.run, paths }, 'template1'), true);
});

test('a role\'s password reaches psql on its input, never in its arguments, and comes back in the database\'s address', () => {
  const paths = machine();
  const { run, calls } = fakeRun((program, args, { input }) => (/SHOW port/.test(input) ? { stdout: '5433\n' } : {}));
  const url = setDatabasePassword({ run, paths }, 'sample', 'f00dfeed');
  assert.equal(url, 'postgres://sample:f00dfeed@127.0.0.1:5433/sample');
  const setting = calls.find((call) => /PASSWORD/.test(call.input));
  assert.equal(setting.input, 'ALTER ROLE "sample" PASSWORD \'f00dfeed\';\n');
  for (const call of calls) assert.ok(!call.args.join(' ').includes('f00dfeed'));
});

test('a password that is not letters and digits is refused before psql sees it', () => {
  const { run, calls } = fakeRun();
  assert.throws(() => setDatabasePassword({ run, paths: machine() }, 'sample', 'it\'s'), /^Error: a database password is letters and digits$/);
  assert.deepEqual(calls, []);
});

/** `run`, with a `runuser` that writes its arguments and some bytes that are not text where pg_dump would write the dump. */
function withStubbedRunuser({ code = 0 } = {}) {
  const stubs = tempDir();
  const script = `#!/bin/sh\nprintf '%s\\n' "$@"\nprintf '\\377\\000\\376'\necho "pg_dump: said this" >&2\nexit ${code}\n`;
  fs.writeFileSync(path.join(stubs, 'runuser'), script, { mode: 0o755 });
  return (program, args, options) => realRun(program, args, { ...options, env: { PATH: `${stubs}:/usr/bin:/bin` } });
}

test('a dump is written by root to the file asked for, for root alone, as pg_dump made it', () => {
  const paths = machine();
  const file = path.join(paths.backupDir, 'sample with a space.dump');
  withUmask(0o022, () => dumpDatabase({ run: withStubbedRunuser(), paths }, 'sample', file));
  assert.equal(mode(file), 0o600);
  const expected = Buffer.concat([Buffer.from('-u\npostgres\n--\npg_dump\n--format=custom\n--dbname=sample\n'), Buffer.from([0xff, 0x00, 0xfe])]);
  assert.deepEqual(fs.readFileSync(file), expected);
});

test('a dump that fails leaves no file and says what pg_dump said', () => {
  const paths = machine();
  const file = path.join(paths.backupDir, 'sample.dump');
  assert.throws(() => dumpDatabase({ run: withStubbedRunuser({ code: 1 }), paths }, 'sample', file),
    /^Error: could not dump sample's database: pg_dump: said this$/);
  assert.ok(!fs.existsSync(file));
});

test('a dump that is interrupted leaves no file either', () => {
  const paths = machine();
  const file = path.join(paths.backupDir, 'sample.dump');
  const { run } = fakeRun(() => {
    fs.writeFileSync(file, 'PGDMP, cut short');
    throw new Interrupted('SIGINT');
  });
  assert.throws(() => dumpDatabase({ run, paths }, 'sample', file), Interrupted);
  assert.ok(!fs.existsSync(file));
});

test('a dump runs where the postgres user can be', () => {
  const paths = machine();
  const { run, calls } = fakeRun();
  dumpDatabase({ run, paths }, 'sample', path.join(paths.backupDir, 'sample.dump'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, paths.root);
});

test('a database is restored by dropping it, making it again for the app alone, and reading the dump into it', () => {
  const paths = machine();
  const { run, calls } = fakeRun();
  restoreDatabase({ run, paths }, 'sample', path.join(paths.backupDir, 'sample.dump'));
  const did = calls.map((call) => call.input ?? call.args[1]);
  assert.equal(did.length, 3);
  assert.equal(did[0], 'DROP DATABASE IF EXISTS "sample" WITH (FORCE);\n');
  assert.match(did[1], /CREATE DATABASE "sample" OWNER "sample"/);
  assert.match(did[1], /^REVOKE CONNECT ON DATABASE "sample" FROM PUBLIC;$/m);
  assert.match(did[2], /pg_restore/);
  for (const call of calls) assert.equal(call.cwd, paths.root);
});

/** `run`, with a `runuser` that writes its arguments, and what it was given to read, to the file `seen`. */
function withRecordingRunuser(seen, { code = 0 } = {}) {
  const stubs = tempDir();
  const script = `#!/bin/sh\n{ printf '%s\\n' "$@"; cat; } >> '${seen}'\necho "pg_restore: said this" >&2\nexit ${code}\n`;
  fs.writeFileSync(path.join(stubs, 'runuser'), script, { mode: 0o755 });
  return (program, args, options) => realRun(program, args, { ...options, env: { PATH: `${stubs}:/usr/bin:/bin` } });
}

const NOT_TEXT = Buffer.from([0x50, 0xff, 0x00, 0xfe]);

/** Only the shell that feeds pg_restore is real: psql's calls succeed without a Postgres. */
function withRealShell(real) {
  return (program, args, options) => (program === '/bin/sh' ? real(program, args, options) : { code: 0, stdout: '', stderr: '' });
}

test('a dump reaches pg_restore on its input, as it is, and what it holds comes to be the app\'s role\'s', () => {
  const paths = machine();
  const file = path.join(paths.backupDir, 'sample with a space.dump');
  fs.writeFileSync(file, NOT_TEXT);
  const seen = path.join(tempDir(), 'seen');
  restoreDatabase({ run: withRealShell(withRecordingRunuser(seen)), paths }, 'sample', file);
  const asked = '-u\npostgres\n--\npg_restore\n--exit-on-error\n--no-owner\n--role=sample\n--dbname=sample\n';
  assert.deepEqual(fs.readFileSync(seen), Buffer.concat([Buffer.from(asked), NOT_TEXT]));
});

test('a restore that pg_restore gives up on fails with what it said', () => {
  const paths = machine();
  const file = path.join(paths.backupDir, 'sample.dump');
  fs.writeFileSync(file, NOT_TEXT);
  const run = withRealShell(withRecordingRunuser(path.join(tempDir(), 'seen'), { code: 1 }));
  assert.throws(() => restoreDatabase({ run, paths }, 'sample', file), /^Error: could not restore sample's database: pg_restore: said this$/);
});

test('a database that cannot be dropped is not restored into', () => {
  const { run, calls } = fakeRun(() => ({ code: 3, stderr: 'psql: error: connection refused\n' }));
  assert.throws(() => restoreDatabase({ run, paths: machine() }, 'sample', '/a/dump'), /^Error: psql failed: psql: error: connection refused$/);
  assert.equal(calls.length, 1);
});

test('a file is a dump when pg_restore can list what it holds, and otherwise what pg_restore said is its fault', () => {
  const paths = machine();
  const file = path.join(paths.backupDir, 'a file.dump');
  fs.writeFileSync(file, NOT_TEXT);
  const seen = path.join(tempDir(), 'seen');
  assert.equal(dumpFault({ run: withRecordingRunuser(seen), paths }, file), null);
  assert.deepEqual(fs.readFileSync(seen), Buffer.concat([Buffer.from('-u\npostgres\n--\npg_restore\n--list\n'), NOT_TEXT]));
  assert.equal(dumpFault({ run: withRecordingRunuser(seen, { code: 1 }), paths }, file), 'pg_restore: said this');
});

test('a dump pg_restore refuses without a word still has a fault', () => {
  const { run } = fakeRun(() => ({ code: 1 }));
  assert.equal(dumpFault({ run, paths: machine() }, '/a/file'), 'pg_restore exited with 1');
});

test('a password is read back from a database address as register wrote it, and from nothing else', () => {
  assert.equal(databasePassword('postgres://sample:f00dfeed@127.0.0.1:5432/sample', 'sample'), 'f00dfeed');
  assert.equal(databasePassword('postgres://sample:F00dFeed9@127.0.0.1:5433/sample', 'sample'), 'F00dFeed9');
  const others = [
    undefined,
    '',
    'postgres://other:f00dfeed@127.0.0.1:5432/other',
    'postgres://sample:f00dfeed@127.0.0.1:5432/other',
    'postgres://sample:f00d\'feed@127.0.0.1:5432/sample',
    'postgres://sample:f00dfeed@db.example:5432/sample',
    'postgres://sample:f00dfeed@127.0.0.1:5432/sample?sslmode=require',
    'postgres://sample@127.0.0.1:5432/sample',
  ];
  for (const address of others) assert.equal(databasePassword(address, 'sample'), null, String(address));
});

test('the address a password is set with is one the password is read back from', () => {
  const { run } = fakeRun((program, args, { input }) => (/SHOW port/.test(input) ? { stdout: '5433\n' } : {}));
  for (const password of ['f00dfeed', 'AZaz09', '0'.repeat(48)]) {
    assert.equal(databasePassword(setDatabasePassword({ run, paths: machine() }, 'sample', password), 'sample'), password);
  }
});
