import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createDatabase, databaseNameTaken, dumpDatabase, setDatabasePassword } from './database.mjs';
import { run as realRun } from './run.mjs';
import { fakeRun, machine, tempDir } from './test-helpers.mjs';

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
  const umask = process.umask(0o022);
  try {
    dumpDatabase({ run: withStubbedRunuser(), paths }, 'sample', file);
  } finally {
    process.umask(umask);
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
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

test('a dump runs where the postgres user can be', () => {
  const paths = machine();
  const { run, calls } = fakeRun();
  dumpDatabase({ run, paths }, 'sample', path.join(paths.backupDir, 'sample.dump'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, paths.root);
});
