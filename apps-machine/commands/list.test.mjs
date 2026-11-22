import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { appsMachine, machine, registered } from '../test-helpers.mjs';

test('on a new machine, list says no app is registered', async () => {
  assert.deepEqual(await appsMachine(['list']), { code: 0, out: 'No app is registered.\n', err: '' });
});

test('list names each registered app, in order of name', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  registered(paths, { name: 'example-app' });
  assert.deepEqual(await appsMachine(['list'], { paths }), { code: 0, out: 'example-app\nsample\n', err: '' });
});

test('list takes no arguments', async () => {
  assert.deepEqual(await appsMachine(['list', 'sample']), { code: 2, out: '', err: 'usage: apps-machine list\n' });
});

test('a registration that cannot be read fails the command, naming the file', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  fs.writeFileSync(paths.registration('sample'), 'not json');
  const result = await appsMachine(['list'], { paths });
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  assert.match(result.err, /^error: .*etc\/apps-machine\/apps\/sample\.json is not a registration/);
});
