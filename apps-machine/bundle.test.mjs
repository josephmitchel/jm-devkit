import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { BUNDLE_FILES, bundleName, isBundle, makeBundle, openBundle, parseBundleName, publicKeyIsSet } from './bundle.mjs';
import { run as realRun } from './run.mjs';
import { archiveOf, machine, registered, tempDir } from './test-helpers.mjs';

test('a bundle is named for its app and its date, and the name reads back', () => {
  assert.equal(bundleName('sample', '2026-11-21'), 'sample-2026-11-21.tar.age');
  assert.deepEqual(parseBundleName('sample-2026-11-21.tar.age'), { name: 'sample-2026-11-21.tar.age', app: 'sample', date: '2026-11-21' });
  assert.deepEqual(parseBundleName('example_app2-2025-01-02.tar.age'), { name: 'example_app2-2025-01-02.tar.age', app: 'example_app2', date: '2025-01-02' });
});

test('a name that is not a bundle\'s reads back as nothing', () => {
  for (const name of ['sample-2026-11-21.tar', 'sample-2026-11-21.tar.age.new', 'sample.tar.age', 'sample-20261121.tar.age', '-2026-11-21.tar.age', 'Sample-2026-11-21.tar.age', 'notes.txt']) {
    assert.equal(parseBundleName(name), null, name);
  }
});

test('the public key is set once its file has a line that is not a comment', () => {
  const paths = machine();
  assert.equal(publicKeyIsSet(paths), false);
  fs.writeFileSync(paths.backupPublicKey, '# the owner\'s public key\n\n');
  assert.equal(publicKeyIsSet(paths), false);
  fs.writeFileSync(paths.backupPublicKey, '# the owner\'s public key\nage1madeup\n');
  assert.equal(publicKeyIsSet(paths), true);
});

/**
 * `run` with the machine's own `tar`, a `runuser` that writes bytes that are not text where pg_dump
 * would write the dump, and an `age` that takes the real one's options and writes its input out as it is.
 */
function withStubbedAge() {
  const stubs = tempDir();
  fs.writeFileSync(path.join(stubs, 'runuser'), '#!/bin/sh\nprintf \'\\377\\000\\376\'\n', { mode: 0o755 });
  const age = [
    '#!/bin/sh',
    '[ $# -eq 6 ] && [ "$1" = --encrypt ] && [ "$2" = --recipients-file ] && [ "$4" = --output ] || { echo "age: unexpected arguments: $*" >&2; exit 2; }',
    'grep -q "^age1" "$3" || { echo "age: no recipient in $3" >&2; exit 1; }',
    'cat "$6" > "$5"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(stubs, 'age'), age, { mode: 0o755 });
  return (program, args, options) => realRun(program, args, { ...options, env: { PATH: `${stubs}:/usr/bin:/bin` } });
}

test('a decrypted bundle is a tar archive of the manifest, the dump and the settings file, each at its top level', () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  fs.writeFileSync(paths.backupPublicKey, 'age1madeup\n');
  const settings = fs.readFileSync(paths.settingsFile('sample'));
  const workDir = tempDir();
  const run = withStubbedAge();
  const umask = process.umask(0o022);
  let file;
  try {
    file = makeBundle({ run, paths }, { app: 'sample', date: '2026-11-21', workDir });
  } finally {
    process.umask(umask);
  }
  assert.equal(file, path.join(paths.nightlyDir, 'sample-2026-11-21.tar.age'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.nightlyDir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(workDir), []);

  const listed = realRun('tar', ['--list', '--file', file]);
  assert.deepEqual(listed.stdout.trim().split('\n'), ['bundle.json', 'database.dump', 'settings.env']);
  assert.deepEqual(listed.stdout.trim().split('\n'), Object.values(BUNDLE_FILES));
  const opened = tempDir();
  assert.equal(realRun('tar', ['--extract', '--file', file, '--directory', opened]).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(opened, BUNDLE_FILES.manifest), 'utf8')), { format: 1, app: 'sample', date: '2026-11-21' });
  assert.deepEqual(fs.readFileSync(path.join(opened, BUNDLE_FILES.dump)), Buffer.from([0xff, 0x00, 0xfe]));
  assert.deepEqual(fs.readFileSync(path.join(opened, BUNDLE_FILES.settings)), settings);
});

test('a bundle that fails leaves nothing in the work directory and no bundle', () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  fs.writeFileSync(paths.backupPublicKey, 'not a public key\n');
  const workDir = tempDir();
  assert.throws(() => makeBundle({ run: withStubbedAge(), paths }, { app: 'sample', date: '2026-11-21', workDir }),
    /^Error: could not encrypt sample's bundle: age: no recipient in .*backup-public-key$/);
  assert.deepEqual(fs.readdirSync(workDir), []);
  assert.ok(!fs.existsSync(paths.nightlyDir));
});

const DUMP = Buffer.from([0x50, 0xff, 0x00, 0xfe]);
const SETTINGS = 'DATABASE_URL=postgres://sample:f00d@127.0.0.1:5432/sample\n';
const withTar = (paths) => ({ run: realRun, paths });

test('a bundle made on the machine, once decrypted, opens into its app, its date, its dump and its settings file', () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  fs.writeFileSync(paths.backupPublicKey, 'age1madeup\n');
  const settings = fs.readFileSync(paths.settingsFile('sample'));
  const decrypted = makeBundle({ run: withStubbedAge(), paths }, { app: 'sample', date: '2026-11-21', workDir: tempDir() });
  assert.equal(isBundle(withTar(paths), decrypted), true);
  const dir = tempDir();
  const opened = openBundle(withTar(paths), decrypted, dir);
  assert.deepEqual(opened, { app: 'sample', date: '2026-11-21', dump: path.join(dir, 'database.dump'), settings: path.join(dir, 'settings.env') });
  assert.deepEqual(fs.readFileSync(opened.dump), Buffer.from([0xff, 0x00, 0xfe]));
  assert.deepEqual(fs.readFileSync(opened.settings), settings);
});

test('a bundle opens whatever its file is called', () => {
  const paths = machine();
  const decrypted = archiveOf({ 'bundle.json': '{"format":1,"app":"sample","date":"2026-11-21"}\n', 'database.dump': DUMP, 'settings.env': SETTINGS }, 'from my-device:sample.tar');
  assert.equal(isBundle(withTar(paths), decrypted), true);
  assert.equal(openBundle(withTar(paths), decrypted, tempDir()).app, 'sample');
});

test('a file that is no archive, and an archive with no manifest, are not bundles', () => {
  const paths = machine();
  const dump = path.join(tempDir(), 'a.dump');
  fs.writeFileSync(dump, DUMP);
  assert.equal(isBundle(withTar(paths), dump), false);
  assert.equal(isBundle(withTar(paths), archiveOf({ 'notes.txt': 'notes\n', 'database.dump': DUMP })), false);
  assert.equal(isBundle(withTar(paths), path.join(tempDir(), 'missing.tar')), false);
});

test('a bundle without all three of its files is still a bundle, and does not open', () => {
  const paths = machine();
  const decrypted = archiveOf({ 'bundle.json': '{"format":1,"app":"sample","date":"2026-11-21"}\n', 'database.dump': DUMP });
  assert.equal(isBundle(withTar(paths), decrypted), true);
  assert.throws(() => openBundle(withTar(paths), decrypted, tempDir()), (e) => {
    assert.match(e.message, /^could not open the bundle .*sample-2026-11-21\.tar: tar: settings\.env: Not found in archive/);
    return true;
  });
});

test('a bundle whose settings are a link to another file does not open', () => {
  const paths = machine();
  const decrypted = archiveOf({ 'bundle.json': '{"format":1,"app":"sample","date":"2026-11-21"}\n', 'database.dump': DUMP, 'settings.env': { linkTo: '/etc/hostname' } });
  assert.throws(() => openBundle(withTar(paths), decrypted, tempDir()), /^Error: .*sample-2026-11-21\.tar is not a bundle: its settings\.env is not a file$/);
});

test('a bundle of a format this machine does not read, or whose manifest names no app, does not open', () => {
  const paths = machine();
  const rest = { 'database.dump': DUMP, 'settings.env': SETTINGS };
  assert.throws(() => openBundle(withTar(paths), archiveOf({ 'bundle.json': '{"format":2,"app":"sample","date":"2027-01-01"}\n', ...rest }), tempDir()),
    /^Error: .*sample-2026-11-21\.tar is a bundle of format 2, and these commands read format 1$/);
  for (const manifest of ['not json', '[]', 'null', '{"format":1}', '{"format":1,"app":7,"date":"2026-11-21"}']) {
    assert.throws(() => openBundle(withTar(paths), archiveOf({ 'bundle.json': manifest, ...rest }), tempDir()),
      /^Error: .*sample-2026-11-21\.tar is not a bundle: its bundle\.json does not say which app and date it is of$/, manifest);
  }
});
