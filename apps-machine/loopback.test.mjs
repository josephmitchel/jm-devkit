import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkLoopbackOnly } from './loopback.mjs';
import { commandLines, fakeRun, machine } from './test-helpers.mjs';

const OTHERS = [
  'LISTEN 0      4096                 100.64.0.7%tailscale0:8443  0.0.0.0:*',
  'LISTEN 0      4096                                 0.0.0.0:22    0.0.0.0:*',
  'LISTEN 0      200                                127.0.0.1:5432  0.0.0.0:*',
  'LISTEN 0      4096                                    [::]:22       [::]:*',
  'LISTEN 0      511                                        *:13000       *:*',
];

function check(port, listeners) {
  const { run, calls } = fakeRun(() => ({ stdout: [...OTHERS, ...listeners].map((line) => `${line}\n`).join('') }));
  checkLoopbackOnly({ run, paths: machine() }, port);
  return commandLines(calls);
}

test('a port listened on at loopback alone passes, whatever else the machine listens on', () => {
  assert.deepEqual(check(3000, ['LISTEN 0      511                                127.0.0.1:3000  0.0.0.0:*']), ['ss -H -ltn']);
  check(3000, ['LISTEN 0 511 [::1]:3000 [::]:*']);
  check(3000, ['LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*', 'LISTEN 0 511 [::1]:3000 [::]:*']);
  check(3000, ['LISTEN 0 511 127.0.0.53%lo:3000 0.0.0.0:*']);
  check(3000, ['LISTEN 0 511 [::ffff:127.0.0.1]:3000 *:*']);
});

test('a port open on every address, or on any address that is not loopback, is refused by that address', () => {
  const refused = {
    '0.0.0.0': 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*',
    '*': 'LISTEN 0 511 *:3000 *:*',
    '[::]': 'LISTEN 0 511 [::]:3000 [::]:*',
    '192.168.1.20': 'LISTEN 0 511 192.168.1.20:3000 0.0.0.0:*',
    '100.64.0.7%tailscale0': 'LISTEN 0 4096 100.64.0.7%tailscale0:3000 0.0.0.0:*',
    '[fe80::1]%eth0': 'LISTEN 0 511 [fe80::1]%eth0:3000 [::]:*',
    '127.0.0.1%eth0': 'LISTEN 0 511 127.0.0.1%eth0:3000 0.0.0.0:*',
  };
  for (const [address, line] of Object.entries(refused)) {
    assert.throws(() => check(3000, ['LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*', line]), {
      message: `port 3000 is open on ${address}: an app listens on loopback only (127.0.0.1)`,
    });
  }
});

test('a port nothing listens on is refused', () => {
  assert.throws(() => check(3000, []), { message: 'nothing is listening on port 3000' });
  assert.throws(() => check(300, ['LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*']), { message: 'nothing is listening on port 300' });
});

test('a machine whose listeners cannot be read, or read as something else, is not passed', () => {
  const failing = fakeRun(() => ({ code: 1, stderr: 'ss: not permitted\n' }));
  assert.throws(() => checkLoopbackOnly({ run: failing.run, paths: machine() }, 3000), { message: 'could not list what the machine listens on: ss: not permitted' });
  assert.throws(() => check(3000, ['tcp LISTEN 127.0.0.1:3000']), /could not read a line of ss's output/);
});
