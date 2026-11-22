import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { pointServiceAt } from '../service.mjs';
import { appsMachine, fakeRun, machine, registered } from '../test-helpers.mjs';

test('on a new machine, list says no app is registered', async () => {
  assert.deepEqual(await appsMachine(['list']), { code: 0, out: 'No app is registered.\n', err: '' });
});

test('list shows each registered app with its repository, its Serve port and whether it has been deployed, in order of name', async () => {
  const paths = machine();
  registered(paths, { name: 'sample', repository: 'git@github.com:example/sample.git', servePort: 8443 });
  registered(paths, { name: 'example_app', repository: 'git@github.com:example/example-app.git', servePort: 10000 });
  const release = path.join(paths.releasesDir('sample'), 'r1');
  fs.mkdirSync(release);
  pointServiceAt({ run: fakeRun().run, paths }, 'sample', { release, start: 'npm start' });
  assert.deepEqual(await appsMachine(['list'], { paths }), {
    code: 0,
    out: [
      'APP          REPOSITORY                              SERVE PORT  DEPLOYED',
      'example_app  git@github.com:example/example-app.git  10000       no',
      'sample       git@github.com:example/sample.git       8443        yes',
      '',
    ].join('\n'),
    err: '',
  });
});

test('list runs no program', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  const { run, calls } = fakeRun();
  await appsMachine(['list'], { paths, run });
  assert.deepEqual(calls, []);
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
