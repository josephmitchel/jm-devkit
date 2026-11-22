import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readRegistry } from '../registry.mjs';
import { renderUnit, servicePointsAt } from '../service.mjs';
import { readSettings } from '../settings.mjs';
import { appsMachine, commandLines, fakeRun, machine, machinePrograms, mode, withUmask } from '../test-helpers.mjs';

const SAMPLE = ['register', 'sample', 'git@github.com:example/sample.git', '8443'];
const EXAMPLE = ['register', 'example_app', 'git@github.com:example/example-app.git', '8444'];
const USAGE = 'usage: apps-machine register <name> <repository> <serve-port>\n';

const everythingUnder = (dir) => fs.readdirSync(dir, { recursive: true }).sort();

/** A machine, the programs on it, and `register(argv)` run there. */
function world(programs = machinePrograms()) {
  const paths = machine();
  const { run, calls } = fakeRun(programs);
  return { paths, calls, register: (argv) => appsMachine(argv, { run, paths }) };
}

test('registering an app records its name, repository and Serve port', async () => {
  const { paths, register } = world();
  const done = await register(SAMPLE);
  assert.equal(done.err, '');
  assert.equal(done.code, 0);
  assert.deepEqual(readRegistry(paths), [{ name: 'sample', repository: 'git@github.com:example/sample.git', servePort: 8443 }]);
});

test('the app gets a Linux user of its own with no shell, no password and no group but its own', async () => {
  const { paths, calls, register } = world();
  await register(SAMPLE);
  assert.deepEqual(commandLines(calls).filter((line) => line.startsWith('useradd')),
    [`useradd --system --user-group --no-create-home --home-dir ${paths.appHome('sample')} --shell /usr/sbin/nologin sample`]);
  assert.deepEqual(commandLines(calls).filter((line) => /^(usermod|adduser|gpasswd|passwd|chpasswd)\b/.test(line)), []);
});

test('the app\'s directories are closed to every other app: root\'s, with the app\'s group let in, and a home of its own', async () => {
  const { paths, calls, register } = world();
  await withUmask(0o077, () => register(SAMPLE));
  assert.equal(mode(path.dirname(paths.appDir('sample'))), 0o755);
  assert.deepEqual([mode(paths.appDir('sample')), mode(paths.appHome('sample')), mode(paths.releasesDir('sample'))], [0o750, 0o700, 0o750]);
  assert.deepEqual(commandLines(calls).filter((line) => line.startsWith('chown')), [
    `chown root:sample ${paths.appDir('sample')}`,
    `chown sample:sample ${paths.appHome('sample')}`,
    `chown root:sample ${paths.releasesDir('sample')}`,
  ]);
  assert.equal(servicePointsAt(paths, 'sample'), null);
});

test('the app gets a role and a database of its name, and a password only the settings file holds', async () => {
  const { paths, calls, register } = world(machinePrograms({ port: 5433 }));
  const done = await register(SAMPLE);
  const sql = calls.filter((call) => call.args.includes('psql')).map((call) => call.input).join('');
  assert.match(sql, /CREATE ROLE "sample" LOGIN/);
  assert.match(sql, /CREATE DATABASE "sample" OWNER "sample"/);
  assert.match(sql, /REVOKE CONNECT ON DATABASE "sample" FROM PUBLIC/);
  const [, password] = /ALTER ROLE "sample" PASSWORD '([0-9a-f]{48})'/.exec(sql);
  assert.deepEqual(readSettings(paths, 'sample'), { DATABASE_URL: `postgres://sample:${password}@127.0.0.1:5433/sample` });
  assert.ok(!done.out.includes(password));
  assert.ok(!commandLines(calls).join('\n').includes(password));
});

test('the settings file is root\'s, mode 0600, in a directory only root can enter', async () => {
  const { paths, calls, register } = world();
  await withUmask(0o022, () => register(SAMPLE));
  const file = fs.statSync(paths.settingsFile('sample'));
  assert.equal(file.mode & 0o777, 0o600);
  assert.equal(file.uid, process.getuid());
  assert.equal(mode(paths.settingsDir), 0o700);
  assert.deepEqual(commandLines(calls).filter((line) => /^(chown|chmod|setfacl)\b/.test(line) && line.includes(paths.configDir)), []);
});

test('the app gets a deploy key whose private half is root\'s alone and is not printed', async () => {
  const { paths, calls, register } = world();
  const done = await register(SAMPLE);
  const key = paths.deployKey('sample');
  assert.deepEqual(commandLines(calls).filter((line) => line.startsWith('ssh-keygen')), [`ssh-keygen -q -t ed25519 -N  -C apps-machine: sample -f ${key}`]);
  assert.equal(mode(key), 0o600);
  assert.equal(mode(paths.keysDir), 0o700);
  assert.match(done.out, /^ {2}ssh-ed25519 AAAAmadeupsample apps-machine: sample$/m);
  assert.ok(!done.out.includes('PRIVATE HALF'));
});

test('the app gets a service from the template, on for the next boot and not started', async () => {
  const { paths, calls, register } = world();
  await register(SAMPLE);
  assert.equal(fs.readFileSync(paths.unitFile('sample'), 'utf8'), renderUnit(paths, 'sample'));
  const systemctl = commandLines(calls).filter((line) => line.startsWith('systemctl'));
  assert.ok(systemctl.includes('systemctl enable app-sample.service'));
  assert.deepEqual(systemctl.filter((line) => /start|--now/.test(line)), []);
  assert.deepEqual(commandLines(calls).filter((line) => line.startsWith('tailscale')), []);
});

test('the command says what the owner does next', async () => {
  const { paths, register } = world();
  const done = await register(SAMPLE);
  assert.equal(done.out, [
    'sample is registered: git@github.com:example/sample.git, Serve port 8443.',
    '',
    'The public half of its deploy key:',
    '',
    '  ssh-ed25519 AAAAmadeupsample apps-machine: sample',
    '',
    'Left to do:',
    '  1. On GitHub, add that key to example/sample under Settings, Deploy keys, without write access.',
    `  2. Add the app's other settings to its settings file, which has its DATABASE_URL: sudoedit ${paths.settingsFile('sample')}`,
    '  3. Deploy it: sudo apps-machine deploy sample',
    '     The deploy maps Serve port 8443 to the port in the project\'s deploy section.',
    '',
  ].join('\n'));
});

test('registering again with the same arguments changes nothing', async () => {
  const { paths, calls, register } = world();
  const first = await register(SAMPLE);
  const kept = [paths.registration('sample'), paths.settingsFile('sample'), paths.deployKey('sample'), `${paths.deployKey('sample')}.pub`, paths.unitFile('sample')];
  const state = () => kept.map((file) => [fs.readFileSync(file, 'utf8'), fs.statSync(file).ino, fs.statSync(file).mtimeMs, mode(file)]);
  const before = { state: state(), files: everythingUnder(paths.root) };
  calls.length = 0;
  assert.deepEqual(await register(SAMPLE), first);
  assert.deepEqual({ state: state(), files: everythingUnder(paths.root) }, before);
  assert.deepEqual(commandLines(calls).filter((line) => /^(useradd|ssh-keygen|systemctl (daemon-reload|enable))/.test(line)), []);
  assert.deepEqual(calls.filter((call) => /PASSWORD/.test(call.input ?? '')), []);
});

test('a second app gets everything of its own, and the first is left as it was', async () => {
  const { paths, calls, register } = world();
  await register(SAMPLE);
  const before = fs.readFileSync(paths.settingsFile('sample'), 'utf8');
  calls.length = 0;
  assert.equal((await register(EXAMPLE)).code, 0);
  assert.deepEqual(readRegistry(paths).map((app) => app.name), ['example_app', 'sample']);
  assert.equal(fs.readFileSync(paths.settingsFile('sample'), 'utf8'), before);
  assert.notEqual(readSettings(paths, 'example_app').DATABASE_URL.replace(/example_app/g, 'sample'), readSettings(paths, 'sample').DATABASE_URL);
  assert.deepEqual(commandLines(calls).filter((line) => /\bsample\b/.test(line)), []);
  assert.equal(mode(paths.appDir('example_app')), 0o750);
});

test('a name, repository or port that cannot be one is refused with a message, and nothing is made', async () => {
  const refused = [
    [['register', 'Sample-App', SAMPLE[2], '8443'], /^error: an app's name is /],
    [['register', 'root; rm -rf', SAMPLE[2], '8443'], /^error: an app's name is /],
    [['register', 'sample', 'https://github.com/example/sample.git', '8443'], /^error: a repository is given by its GitHub SSH address: git@github\.com:<owner>\/<name>\.git\n/],
    [['register', 'sample', SAMPLE[2], 'https'], /^error: a Serve port is a whole number from 1 to 65535\n/],
    [['register', 'sample', SAMPLE[2], '0'], /^error: a Serve port is a whole number from 1 to 65535\n/],
    [['register', 'sample', SAMPLE[2], '8443.0'], /^error: a Serve port is a whole number from 1 to 65535\n/],
  ];
  for (const [argv, message] of refused) {
    const { paths, calls, register } = world();
    const before = everythingUnder(paths.root);
    const done = await register(argv);
    assert.equal(done.code, 2, argv.join(' '));
    assert.equal(done.out, '');
    assert.match(done.err, message);
    assert.ok(done.err.endsWith(USAGE));
    assert.deepEqual(calls, []);
    assert.deepEqual(everythingUnder(paths.root), before);
  }
});

test('too few or too many arguments get the usage', async () => {
  for (const argv of [['register'], SAMPLE.slice(0, 3), [...SAMPLE, 'more']]) {
    const { calls, register } = world();
    assert.deepEqual(await register(argv), { code: 2, out: '', err: USAGE });
    assert.deepEqual(calls, []);
  }
});

test('a Serve port already given to another app is refused, and nothing is made', async () => {
  const { paths, calls, register } = world();
  await register(SAMPLE);
  const before = everythingUnder(paths.root);
  calls.length = 0;
  assert.deepEqual(await register(['register', 'example_app', EXAMPLE[2], '8443']), { code: 1, out: '', err: 'error: Serve port 8443 is already sample\'s\n' });
  assert.deepEqual(calls, []);
  assert.deepEqual(everythingUnder(paths.root), before);
});

test('an app already registered with another repository or port is refused, and left as it is', async () => {
  for (const argv of [['register', 'sample', 'git@github.com:example/other.git', '8443'], ['register', 'sample', SAMPLE[2], '9443']]) {
    const { paths, calls, register } = world();
    await register(SAMPLE);
    calls.length = 0;
    const done = await register(argv);
    assert.equal(done.code, 1);
    assert.equal(done.err, `error: sample is already registered, with git@github.com:example/sample.git on Serve port 8443: see ${paths.registration('sample')}\n`);
    assert.deepEqual(calls, []);
    assert.deepEqual(readRegistry(paths), [{ name: 'sample', repository: SAMPLE[2], servePort: 8443 }]);
  }
});

test('a name the machine already has a Linux user or group for, or Postgres a role or database, is refused', async () => {
  const taken = [
    [machinePrograms({ users: ['sample'] }), 'error: this machine already has a Linux user or group named sample, which is not an app\'s\n'],
    [machinePrograms({ groups: ['sample'] }), 'error: this machine already has a Linux user or group named sample, which is not an app\'s\n'],
    [machinePrograms({ taken: ['sample'] }), 'error: Postgres already has a role or a database named sample, which is not an app\'s\n'],
  ];
  for (const [programs, message] of taken) {
    const { paths, calls, register } = world(programs);
    const before = everythingUnder(paths.root);
    assert.deepEqual(await register(SAMPLE), { code: 1, out: '', err: message });
    assert.deepEqual(everythingUnder(paths.root), before);
    assert.deepEqual(commandLines(calls).filter((line) => /^(useradd|chown|ssh-keygen|systemctl)/.test(line)), []);
    assert.deepEqual(calls.filter((call) => /CREATE|ALTER|REVOKE/.test(call.input ?? '')), []);
  }
});

test('a registration that stopped part-way is finished by running the command again', async () => {
  const programs = machinePrograms();
  let keygenWorks = false;
  const { paths, calls, register } = world((program, args, options) => (
    program === 'ssh-keygen' && !keygenWorks ? { code: 1, stderr: 'ssh-keygen: no entropy\n' } : programs(program, args, options)
  ));
  assert.deepEqual(await register(SAMPLE), { code: 1, out: '', err: 'error: could not make sample\'s deploy key: ssh-keygen: no entropy\n' });
  const settings = fs.readFileSync(paths.settingsFile('sample'), 'utf8');
  keygenWorks = true;
  calls.length = 0;
  const done = await register(SAMPLE);
  assert.equal(done.code, 0);
  assert.match(done.out, /ssh-ed25519 AAAAmadeupsample/);
  assert.equal(fs.readFileSync(paths.settingsFile('sample'), 'utf8'), settings);
  assert.deepEqual(commandLines(calls).filter((line) => line.startsWith('useradd')), []);
  assert.ok(fs.existsSync(paths.unitFile('sample')));
});

test('a program that fails stops the registration with what it said', async () => {
  const programs = machinePrograms();
  const { paths, register } = world((program, args, options) => (
    program === 'useradd' ? { code: 9, stderr: 'useradd: cannot lock /etc/passwd\n' } : programs(program, args, options)
  ));
  assert.deepEqual(await register(SAMPLE), { code: 1, out: '', err: 'error: could not make the Linux user sample: useradd: cannot lock /etc/passwd\n' });
  assert.ok(!fs.existsSync(paths.settingsFile('sample')));
});
