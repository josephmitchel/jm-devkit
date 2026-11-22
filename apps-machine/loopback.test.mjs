import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkLoopbackOnly } from './loopback.mjs';
import { run as realRun } from './run.mjs';
import { commandLines, fakeRun, listening, machine, machinePrograms, standInUid } from './test-helpers.mjs';

const SAMPLE = standInUid('sample');
const OTHER_APP = standInUid('example_app');

// As `ss -H -ltne` printed them on a machine with Tailscale Serve, ssh, a resolver and Postgres: root's sockets have no uid.
const OTHERS = [
  'LISTEN 0      4096                 100.64.0.7%tailscale0:8443  0.0.0.0:* ino:46158 sk:1 cgroup:/system.slice/tailscaled.service <->',
  'LISTEN 0      4096                                  0.0.0.0:22    0.0.0.0:* ino:11093 sk:3 cgroup:/system.slice/ssh.socket <->',
  'LISTEN 0      4096                            127.0.0.53%lo:53    0.0.0.0:* uid:990 ino:4809 sk:5 cgroup:/system.slice/systemd-resolved.service <->',
  'LISTEN 0      200                                 127.0.0.1:5432  0.0.0.0:* uid:982 ino:28286 sk:7 cgroup:/system.slice/system-postgresql.slice/postgresql@16-main.service <->',
  'LISTEN 0      4096                                     [::]:22       [::]:* ino:14700 sk:8 cgroup:/system.slice/ssh.socket v6only:1 <->',
  'LISTEN 0      4096   [fd7a:115c:a1e0::7d4b:bc2d]%tailscale0:8443     [::]:* ino:41564 sk:b cgroup:/system.slice/tailscaled.service v6only:1 <->',
  `LISTEN 0      511                                         *:13000       *:* uid:${OTHER_APP} ino:5 sk:c cgroup:/system.slice/app-example_app.service <->`,
];

function check(port, listeners) {
  const programs = machinePrograms({ users: ['sample', 'example_app'] });
  const { run, calls } = fakeRun((program, args) => (program === 'ss' ? { stdout: [...OTHERS, ...listeners].map((line) => `${line}\n`).join('') } : programs(program, args)));
  checkLoopbackOnly({ run, paths: machine() }, 'sample', port);
  return commandLines(calls);
}

test('an app that listens at loopback alone passes, whatever other users of the machine listen on', () => {
  assert.deepEqual(check(3000, [listening('127.0.0.1', 3000, SAMPLE)]), ['id -u sample', 'ss -H -ltne']);
  check(3000, [listening('[::1]', 3000, SAMPLE)]);
  check(3000, [listening('127.0.0.1', 3000, SAMPLE), listening('[::1]', 3000, SAMPLE)]);
  check(3000, [listening('127.0.0.53%lo', 3000, SAMPLE)]);
  check(3000, [listening('[::ffff:127.0.0.1]', 3000, SAMPLE)]);
  check(3000, [listening('127.0.0.1', 3000, SAMPLE), listening('127.0.0.1', 9229, SAMPLE)]);
});

test('the port open on every address, or on any address that is not loopback, is refused by that address', () => {
  for (const address of ['0.0.0.0', '*', '[::]', '192.168.1.20', '100.64.0.7%tailscale0', '[fe80::1]%eth0', '127.0.0.1%eth0']) {
    assert.throws(() => check(3000, [listening('127.0.0.1', 3000, SAMPLE), listening(address, 3000, SAMPLE)]), {
      message: `sample listens on ${address}, port 3000: an app listens on loopback only (127.0.0.1)`,
    });
  }
});

test('an app that listens anywhere but loopback on any other port is refused too', () => {
  assert.throws(() => check(3000, [listening('127.0.0.1', 3000, SAMPLE), listening('0.0.0.0', 9229, SAMPLE)]), {
    message: 'sample listens on 0.0.0.0, port 9229: an app listens on loopback only (127.0.0.1)',
  });
});

test('a port nothing listens on is refused', () => {
  assert.throws(() => check(3000, []), { message: 'nothing is listening on port 3000' });
  assert.throws(() => check(300, [listening('127.0.0.1', 3000, SAMPLE)]), { message: 'nothing is listening on port 300' });
});

test('a port another user of the machine listens on is refused: another app has it, and would answer for this one', () => {
  assert.throws(() => check(3000, [listening('127.0.0.1', 3000, OTHER_APP)]), {
    message: 'port 3000 is listened on by another user of this machine (uid ' + OTHER_APP + '), not by sample: two apps cannot have the same port',
  });
  assert.throws(() => check(3000, [listening('127.0.0.1', 3000, SAMPLE), listening('[::1]', 3000, OTHER_APP)]), /^Error: port 3000 is listened on by another user/);
  assert.throws(() => check(22, []), { message: 'port 22 is listened on by another user of this machine (uid 0), not by sample: two apps cannot have the same port' });
});

test('a machine whose listeners cannot be read, or read as something else, is not passed', () => {
  const programs = machinePrograms({ users: ['sample'] });
  const failing = fakeRun((program, args) => (program === 'ss' ? { code: 1, stderr: 'ss: not permitted\n' } : programs(program, args)));
  assert.throws(() => checkLoopbackOnly({ run: failing.run, paths: machine() }, 'sample', 3000), { message: 'could not list what the machine listens on: ss: not permitted' });
  assert.throws(() => check(3000, ['tcp LISTEN 127.0.0.1:3000']), /could not read a line of ss's output/);
  assert.throws(() => check(3000, ['LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*']), /could not read a line of ss's output/);
  const nobody = fakeRun(() => ({ code: 1, stderr: 'id: sample: no such user\n' }));
  assert.throws(() => checkLoopbackOnly({ run: nobody.run, paths: machine() }, 'sample', 3000), { message: 'could not tell which listeners are sample\'s: id: sample: no such user' });
});

test('every line the machine\'s own ss prints is read', () => {
  const { run } = fakeRun((program, args) => (program === 'ss' ? realRun(program, args) : { stdout: '4294967294\n' }));
  assert.throws(() => checkLoopbackOnly({ run, paths: machine() }, 'sample', 1), { message: 'nothing is listening on port 1' });
});
