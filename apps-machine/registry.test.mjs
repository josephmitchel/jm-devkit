import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readRegistry } from './registry.mjs';
import { machine, registered } from './test-helpers.mjs';

test('a machine nothing was registered on has no registrations', () => {
  assert.deepEqual(readRegistry(machine()), []);
});

test('each registration comes back as it was written, in order of name', () => {
  const paths = machine();
  const sample = registered(paths, { name: 'sample', made: 'up' });
  const example = registered(paths, { name: 'example-app' });
  assert.deepEqual(readRegistry(paths), [example, sample]);
});

test('a file beside the registrations that is not one is passed over', () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  fs.writeFileSync(path.join(paths.appsDir, 'sample.json.new'), '{');
  assert.deepEqual(readRegistry(paths), [{ name: 'sample' }]);
});

test('a registration under another app\'s name is refused, naming the file', () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  fs.renameSync(paths.registration('sample'), paths.registration('example-app'));
  assert.throws(() => readRegistry(paths), /example-app\.json is not the registration of an app named example-app/);
});
