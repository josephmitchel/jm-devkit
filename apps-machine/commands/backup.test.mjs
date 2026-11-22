import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { appsMachine, backupPrograms, fakeRun, machine, openedBundle, registered, sink } from '../test-helpers.mjs';
import { bundleEveryApp } from './backup.mjs';

const PUBLIC_KEY = 'age1madeupmadeupmadeupmadeupmadeupmadeupmadeupmadeupmadeupma\n';
const NIGHT = () => new Date(2026, 10, 21, 3, 0, 0);

const mode = (file) => fs.statSync(file).mode & 0o777;
const filesUnder = (dir) => fs.readdirSync(dir, { recursive: true }).filter((file) => fs.statSync(path.join(dir, file)).isFile()).sort();

function machineWithKey(...apps) {
  const paths = machine();
  fs.writeFileSync(paths.backupPublicKey, PUBLIC_KEY);
  for (const name of apps) registered(paths, { name });
  return paths;
}

function backup(paths, { respond = backupPrograms(), now = NIGHT } = {}) {
  const { run, calls } = fakeRun(respond);
  return appsMachine(['backup'], { paths, run, now }).then((result) => ({ ...result, calls }));
}

test('after a run each registered app has one encrypted bundle for the night, root\'s alone', async () => {
  const paths = machineWithKey('sample', 'example_app');
  const result = await backup(paths);
  assert.equal(result.err, '');
  assert.equal(result.code, 0);
  assert.deepEqual(fs.readdirSync(paths.nightlyDir).sort(), ['example_app-2026-11-21.tar.age', 'sample-2026-11-21.tar.age']);
  assert.equal(mode(paths.nightlyDir), 0o700);
  for (const name of fs.readdirSync(paths.nightlyDir)) assert.equal(mode(path.join(paths.nightlyDir, name)), 0o600, name);
  assert.equal(result.out, [
    `example_app: ${paths.nightlyDir}/example_app-2026-11-21.tar.age`,
    `sample: ${paths.nightlyDir}/sample-2026-11-21.tar.age`,
    '',
  ].join('\n'));
});

test('a bundle holds the app\'s name and date, its database\'s dump and its settings file as it was, encrypted to the owner\'s public key', async () => {
  const paths = machineWithKey('sample');
  const settings = Buffer.from('DATABASE_URL=postgres://sample:f00d@127.0.0.1:5432/sample\nKEY="two\nlines"\n# caf\xe9\n', 'latin1');
  fs.writeFileSync(paths.settingsFile('sample'), settings);
  await backup(paths);
  const { recipients, members } = openedBundle(path.join(paths.nightlyDir, 'sample-2026-11-21.tar.age'));
  assert.equal(recipients, PUBLIC_KEY);
  assert.deepEqual(Object.keys(members), ['bundle.json', 'database.dump', 'settings.env']);
  assert.deepEqual(JSON.parse(members['bundle.json']), { format: 1, app: 'sample', date: '2026-11-21' });
  assert.deepEqual(members['database.dump'], Buffer.from('dump of sample\0\xff', 'latin1'));
  assert.deepEqual(members['settings.env'], settings);
});

test('nothing unencrypted is written outside the run\'s own directory, which is gone when the run ends', async () => {
  const paths = machineWithKey('sample', 'example_app');
  const programs = backupPrograms();
  const seen = new Set();
  const result = await backup(paths, {
    respond: (program, args, options) => {
      const answer = programs(program, args, options);
      for (const file of filesUnder(paths.root)) seen.add(file);
      return answer;
    },
  });
  assert.equal(result.code, 0);
  const work = path.relative(paths.root, paths.backupWorkDir);
  const unencrypted = [...seen].filter((file) => /\.(dump|tar)$|settings\.env$|bundle\.json$/.test(file));
  assert.equal(unencrypted.length, 8);
  const runs = new Set(unencrypted.map((file) => path.relative(work, file).split(path.sep)[0]));
  assert.equal(runs.size, 1);
  assert.doesNotMatch([...runs][0], /^\.\.$/);
  assert.deepEqual(fs.readdirSync(paths.backupWorkDir), []);
  assert.deepEqual(filesUnder(paths.backupDir), ['nightly/example_app-2026-11-21.tar.age', 'nightly/sample-2026-11-21.tar.age']);
});

test('one app\'s dump failing does not stop the others: the run fails naming the app, and leaves nothing of it behind', async () => {
  const paths = machineWithKey('example_app', 'other', 'sample');
  const programs = backupPrograms();
  const result = await backup(paths, {
    respond: (program, args, options) => (program === '/bin/sh' && args[3] === 'other'
      ? { code: 1, stderr: 'pg_dump: error: connection to server failed\n' }
      : programs(program, args, options)),
  });
  assert.equal(result.code, 1);
  assert.equal(result.err, [
    'other: could not dump other\'s database: pg_dump: error: connection to server failed',
    'error: no bundle was made for other',
    '',
  ].join('\n'));
  assert.deepEqual(filesUnder(paths.backupDir), ['nightly/example_app-2026-11-21.tar.age', 'nightly/sample-2026-11-21.tar.age']);
  assert.deepEqual(fs.readdirSync(paths.backupWorkDir), []);
});

test('a bundle that cannot be encrypted is not kept, and the app is named', async () => {
  const paths = machineWithKey('sample');
  const programs = backupPrograms();
  const result = await backup(paths, {
    respond: (program, args, options) => {
      const answer = programs(program, args, options);
      return program === 'age' ? { code: 1, stderr: 'age: error: malformed recipient at line 1\n' } : answer;
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.err, 'sample: could not encrypt sample\'s bundle: age: error: malformed recipient at line 1\nerror: no bundle was made for sample\n');
  assert.deepEqual(filesUnder(paths.backupDir), []);
});

test('an app without a settings file is named, and the others are bundled', async () => {
  const paths = machineWithKey('sample', 'example_app');
  fs.rmSync(paths.settingsFile('example_app'));
  const result = await backup(paths);
  assert.equal(result.code, 1);
  assert.match(result.err, /^example_app: example_app has no settings file: .*\nerror: no bundle was made for example_app\n$/);
  assert.deepEqual(filesUnder(paths.backupDir), ['nightly/sample-2026-11-21.tar.age']);
});

test('with no public key set the command refuses to run, says how to set one, and runs nothing', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  for (const text of [null, '', '# the owner\'s public key goes here\n\n']) {
    if (text !== null) fs.writeFileSync(paths.backupPublicKey, text);
    const result = await backup(paths);
    assert.equal(result.code, 1);
    assert.equal(result.out, '');
    assert.equal(result.err, `error: no public key is set for the backups, so no bundle can be encrypted: run the setup script with BACKUP_PUBLIC_KEY=<the owner's age public key>, which writes it to ${paths.backupPublicKey}\n`);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(filesUnder(paths.backupDir), []);
  }
});

test('bundles older than seven days are removed once the app has its bundle for the night, and nothing else in the backup directory is touched', async () => {
  const paths = machineWithKey('sample', 'example_app');
  const kept = ['deploys/sample-2026-01-01.dump', 'nightly/notes.txt', 'nightly/sample-2026-11-01.tar', 'nightly/unregistered-2026-01-01.tar.age'];
  const old = ['nightly/example_app-2026-11-14.tar.age', 'nightly/sample-2025-11-21.tar.age', 'nightly/sample-2026-11-14.tar.age'];
  const recent = ['nightly/example_app-2026-11-15.tar.age', 'nightly/sample-2026-11-15.tar.age', 'nightly/sample-2026-11-20.tar.age'];
  for (const file of [...kept, ...old, ...recent]) {
    fs.mkdirSync(path.dirname(path.join(paths.backupDir, file)), { recursive: true });
    fs.writeFileSync(path.join(paths.backupDir, file), 'from an earlier night');
  }
  const result = await backup(paths);
  assert.equal(result.code, 0);
  assert.deepEqual(filesUnder(paths.backupDir), [...kept, ...recent, 'nightly/example_app-2026-11-21.tar.age', 'nightly/sample-2026-11-21.tar.age'].sort());
  assert.equal(result.out, [
    `example_app: ${paths.nightlyDir}/example_app-2026-11-21.tar.age`,
    `sample: ${paths.nightlyDir}/sample-2026-11-21.tar.age`,
    'example_app: removed example_app-2026-11-14.tar.age, older than seven days',
    'sample: removed sample-2025-11-21.tar.age, older than seven days',
    'sample: removed sample-2026-11-14.tar.age, older than seven days',
    '',
  ].join('\n'));
});

test('an app whose bundle was not made tonight keeps its old bundles', async () => {
  const paths = machineWithKey('sample', 'example_app');
  fs.mkdirSync(paths.nightlyDir);
  for (const name of ['sample-2026-11-01.tar.age', 'example_app-2026-11-01.tar.age']) fs.writeFileSync(path.join(paths.nightlyDir, name), 'from an earlier night');
  const programs = backupPrograms();
  const result = await backup(paths, {
    respond: (program, args, options) => (program === '/bin/sh' && args[3] === 'sample' ? { code: 1, stderr: 'pg_dump: failed\n' } : programs(program, args, options)),
  });
  assert.equal(result.code, 1);
  assert.deepEqual(fs.readdirSync(paths.nightlyDir).sort(), ['example_app-2026-11-21.tar.age', 'sample-2026-11-01.tar.age']);
});

test('what a run that was killed left behind is removed by the next run, and a run still going is left alone', async () => {
  const paths = machineWithKey('sample');
  const killed = path.join(paths.backupWorkDir, '999999999-AbCdEf');
  const going = path.join(paths.backupWorkDir, `${process.pid}-AbCdEf`);
  for (const dir of [killed, going]) {
    fs.mkdirSync(path.join(dir, 'sample/members'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sample/members/database.dump'), 'unencrypted');
  }
  const result = await backup(paths);
  assert.equal(result.code, 0);
  assert.deepEqual(fs.readdirSync(paths.backupWorkDir), [path.basename(going)]);
});

test('a second run on the same date replaces the app\'s bundle, and the date is the machine\'s own', async () => {
  const paths = machineWithKey('sample');
  await backup(paths, { now: () => new Date(2026, 10, 21, 0, 0, 1) });
  fs.writeFileSync(paths.settingsFile('sample'), 'CHANGED=since\n');
  await backup(paths, { now: () => new Date(2026, 10, 21, 23, 59, 59) });
  assert.deepEqual(fs.readdirSync(paths.nightlyDir), ['sample-2026-11-21.tar.age']);
  assert.equal(openedBundle(path.join(paths.nightlyDir, 'sample-2026-11-21.tar.age')).members['settings.env'].toString(), 'CHANGED=since\n');
  await backup(paths, { now: () => new Date(2026, 10, 22, 0, 0, 0) });
  assert.deepEqual(fs.readdirSync(paths.nightlyDir), ['sample-2026-11-21.tar.age', 'sample-2026-11-22.tar.age']);
});

test('with no app registered there is nothing to back up, and the run says so', async () => {
  const paths = machineWithKey();
  const result = await backup(paths);
  assert.deepEqual({ code: result.code, out: result.out, err: result.err }, { code: 0, out: 'No app is registered: there is nothing to back up.\n', err: '' });
  assert.deepEqual(result.calls, []);
});

test('backup takes no arguments', async () => {
  assert.deepEqual(await appsMachine(['backup', 'sample']), { code: 2, out: '', err: 'usage: apps-machine backup\n' });
});

test('the run gives back the night\'s bundles and the apps that have none, for the steps that follow', () => {
  const paths = machineWithKey('example_app', 'other', 'sample');
  const programs = backupPrograms();
  const { run } = fakeRun((program, args, options) => (program === '/bin/sh' && args[3] === 'other' ? { code: 1, stderr: 'pg_dump: failed\n' } : programs(program, args, options)));
  const night = bundleEveryApp({ run, paths, out: sink(), err: sink(), now: NIGHT });
  assert.deepEqual(night, {
    date: '2026-11-21',
    bundles: [
      { app: 'example_app', date: '2026-11-21', name: 'example_app-2026-11-21.tar.age', file: path.join(paths.nightlyDir, 'example_app-2026-11-21.tar.age') },
      { app: 'sample', date: '2026-11-21', name: 'sample-2026-11-21.tar.age', file: path.join(paths.nightlyDir, 'sample-2026-11-21.tar.age') },
    ],
    failed: [{ app: 'other', reason: 'could not dump other\'s database: pg_dump: failed' }],
  });
});

test('the timer\'s service runs this command from where the setup script links it', () => {
  const vm = path.join(import.meta.dirname, '../../vm');
  const setup = fs.readFileSync(path.join(vm, 'apps-machine-setup.sh'), 'utf8');
  const service = fs.readFileSync(path.join(vm, 'systemd/apps-machine-backup.service'), 'utf8');
  const link = /^COMMAND=(\S+)$/m.exec(setup)[1];
  assert.deepEqual(service.match(/^ExecStart=.*$/gm), [`ExecStart=${link} backup`]);
  assert.ok(fs.existsSync(path.join(vm, 'systemd/apps-machine-backup.timer')));
});
