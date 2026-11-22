import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readRegistry, registrationOf, writeRegistration } from './registry.mjs';
import { machine } from './test-helpers.mjs';
import { UsageError } from './usage.mjs';

const sample = { name: 'sample', repository: 'git@github.com:example/sample.git', servePort: 8443 };
const example = { name: 'example_app', repository: 'git@github.com:example/example-app.git', servePort: 8444 };

test('a machine nothing was registered on has no registrations', () => {
  assert.deepEqual(readRegistry(machine()), []);
});

test('each registration comes back as it was written, in order of name', () => {
  const paths = machine();
  assert.deepEqual(writeRegistration(paths, sample), sample);
  writeRegistration(paths, example);
  assert.deepEqual(readRegistry(paths), [example, sample]);
});

test('a registration is root\'s alone, and so is the directory of them', () => {
  const paths = machine();
  writeRegistration(paths, sample);
  assert.equal(fs.statSync(paths.appsDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.registration('sample')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(paths.appsDir), ['sample.json']);
});

test('writing a registration again as it is leaves the file untouched', () => {
  const paths = machine();
  writeRegistration(paths, sample);
  const before = fs.statSync(paths.registration('sample'));
  writeRegistration(paths, { ...sample });
  const after = fs.statSync(paths.registration('sample'));
  assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs]);
});

test('a registration holds a name, a repository and a Serve port, and nothing else', () => {
  const paths = machine();
  writeRegistration(paths, { ...sample, made: 'up' });
  assert.deepEqual(readRegistry(paths), [sample]);
});

test('a name that is not safe as a Linux user and a database is refused', () => {
  const paths = machine();
  for (const name of ['', 'Sample', '1sample', 'sam ple', 'sample-app', 'sample;drop', '../sample', 'pg_sample', 'a'.repeat(32), undefined]) {
    assert.throws(() => writeRegistration(paths, { ...sample, name }), (e) => e instanceof UsageError && /name/.test(e.message), String(name));
  }
  writeRegistration(paths, { ...sample, name: 'a'.repeat(31) });
  writeRegistration(paths, { ...sample, name: 's2_x', servePort: 8445 });
});

test('a repository that is not a GitHub SSH address is refused', () => {
  const paths = machine();
  const others = ['https://github.com/example/sample.git', 'git@gitlab.com:example/sample.git', 'git@github.com:example/sample',
    'git@github.com:sample.git', 'git@github.com:example/sample.git --upload-pack=x', 'example/sample', undefined];
  for (const repository of others) {
    assert.throws(() => writeRegistration(paths, { ...sample, repository }), (e) => e instanceof UsageError && /git@github\.com:/.test(e.message), String(repository));
  }
});

test('a Serve port that is not a port number is refused', () => {
  const paths = machine();
  for (const servePort of [0, 65536, 8443.5, '8443', -1, NaN, undefined]) {
    assert.throws(() => writeRegistration(paths, { ...sample, servePort }), (e) => e instanceof UsageError && /port/.test(e.message), String(servePort));
  }
});

test('a Serve port already given to another app is refused, naming the app', () => {
  const paths = machine();
  writeRegistration(paths, sample);
  assert.throws(() => writeRegistration(paths, { ...example, servePort: 8443 }), /^Error: Serve port 8443 is already sample's$/);
  assert.deepEqual(readRegistry(paths), [sample]);
});

test('the registration of an app is found by its name, and an app that is not registered is refused', () => {
  const paths = machine();
  writeRegistration(paths, sample);
  assert.deepEqual(registrationOf(paths, 'sample'), sample);
  assert.throws(() => registrationOf(paths, 'example_app'), /^Error: no app named example_app is registered on this machine$/);
  assert.throws(() => registrationOf(paths, '../sample'), /^Error: no app named \.\.\/sample is registered on this machine$/);
});

test('a file beside the registrations that is not one is passed over', () => {
  const paths = machine();
  writeRegistration(paths, sample);
  fs.writeFileSync(path.join(paths.appsDir, 'sample.json.new'), '{');
  assert.deepEqual(readRegistry(paths), [sample]);
});

test('a registration under another app\'s name is refused, naming the file', () => {
  const paths = machine();
  writeRegistration(paths, sample);
  fs.renameSync(paths.registration('sample'), paths.registration('example_app'));
  assert.throws(() => readRegistry(paths), /example_app\.json is not the registration of an app named example_app/);
});
