import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { machinePaths } from './paths.mjs';

test('on a real machine the registrations are in /etc/apps-machine/apps', () => {
  const paths = machinePaths();
  assert.equal(paths.configDir, '/etc/apps-machine');
  assert.equal(paths.registration('sample'), '/etc/apps-machine/apps/sample.json');
});

test('every path is under the root it was given', () => {
  const root = '/tmp/a-machine';
  for (const [name, value] of Object.entries(machinePaths(root))) {
    const at = typeof value === 'function' ? value('sample') : value;
    assert.ok(at === root || at.startsWith(root + path.sep), `${name} is ${at}`);
  }
});
