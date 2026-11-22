import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Interrupted } from '../run.mjs';
import { appsMachine, backupPrograms, fakeRun, filesUnder, machine, mode, offsitePrograms, openedBundle, registered, sink } from '../test-helpers.mjs';
import { bundleEveryApp } from './backup.mjs';

const PUBLIC_KEY = 'age1madeupmadeupmadeupmadeupmadeupmadeupmadeupmadeupmadeupma\n';
const STORAGE = 'backups:apps-machine';
const CREDENTIAL = 'madeUpStorageCredential';
const ADDRESS = 'https://alive.example/ping/made-up-id';
const NIGHT = () => new Date(2026, 10, 21, 3, 0, 0);

/** A machine set up for its backups: the public key, the storage and the alive address. */
function machineWithKey(...apps) {
  const paths = machine();
  fs.writeFileSync(paths.backupPublicKey, PUBLIC_KEY);
  fs.writeFileSync(paths.backupStorage, `${STORAGE}\n`);
  fs.writeFileSync(paths.rcloneConfig, `[backups]\ntype = sftp\nhost = storage.example\npass = ${CREDENTIAL}\n`);
  fs.writeFileSync(paths.backupAliveAddress, `${ADDRESS}\n`);
  for (const name of apps) registered(paths, { name });
  return paths;
}

function backup(paths, { offsite = offsitePrograms(), respond = offsite.respond, now = NIGHT } = {}) {
  const { run, calls } = fakeRun(respond);
  return appsMachine(['backup'], { paths, run, now }).then((result) => ({ ...result, calls, stored: offsite.stored, requests: offsite.requests }));
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
    'example_app: uploaded example_app-2026-11-21.tar.age',
    'sample: uploaded sample-2026-11-21.tar.age',
    'The alive request was made.',
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
  assert.deepEqual(members['database.dump'], Buffer.from('PGDMPdump of sample\0\xff', 'latin1'));
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

test('a run that is interrupted stops there: no other app is dumped, nothing is uploaded, and nothing unencrypted is left', async () => {
  for (const interrupted of ['tar', 'age', 'rclone']) {
    const paths = machineWithKey('example_app', 'sample');
    const offsite = offsitePrograms();
    const result = await backup(paths, {
      offsite,
      respond: (program, args, options) => {
        const answer = offsite.respond(program, args, options);
        if (program === interrupted) throw new Interrupted('SIGTERM');
        return answer;
      },
    });
    assert.equal(result.code, 1, interrupted);
    assert.equal(result.err, 'error: interrupted by SIGTERM\n', interrupted);
    assert.deepEqual(fs.readdirSync(paths.backupWorkDir), [], interrupted);
    assert.equal(result.calls.filter((call) => call.program === interrupted).length, 1, interrupted);
    assert.deepEqual(result.requests, [], interrupted);
    if (interrupted !== 'rclone') assert.deepEqual(filesUnder(paths.backupDir), [], interrupted);
  }
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
    'example_app: removed example_app-2026-11-14.tar.age, older than 7 days',
    'sample: removed sample-2025-11-21.tar.age, older than 7 days',
    'sample: removed sample-2026-11-14.tar.age, older than 7 days',
    'example_app: uploaded example_app-2026-11-21.tar.age',
    'sample: uploaded sample-2026-11-21.tar.age',
    'The alive request was made.',
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

test('with no app registered there is nothing to back up: the run says so, and the machine still says it is alive', async () => {
  const paths = machineWithKey();
  const result = await backup(paths);
  assert.deepEqual({ code: result.code, out: result.out, err: result.err }, { code: 0, out: 'No app is registered: there is nothing to back up.\nThe alive request was made.\n', err: '' });
  assert.deepEqual(programsRun(result.calls), ['curl']);
  assert.deepEqual(result.requests, [ADDRESS]);
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

test('the timer\'s service waits for the network, and its unit, which anyone can read, holds neither setting', () => {
  const service = fs.readFileSync(path.join(import.meta.dirname, '../../vm/systemd/apps-machine-backup.service'), 'utf8');
  assert.match(service, /^Wants=network-online\.target$/m);
  assert.match(service, /^After=(\S+ )*network-online\.target( \S+)*$/m);
  assert.doesNotMatch(service, /^\s*(Environment|EnvironmentFile|PassEnvironment|SetCredential|LoadCredential)\w*=/m);
});

test('after a run each of the night\'s bundles is on the storage, byte for byte', async () => {
  const paths = machineWithKey('sample', 'example_app');
  const result = await backup(paths);
  assert.equal(result.err, '');
  assert.equal(result.code, 0);
  assert.deepEqual([...result.stored.keys()], [`${STORAGE}/example_app-2026-11-21.tar.age`, `${STORAGE}/sample-2026-11-21.tar.age`]);
  for (const [at, bytes] of result.stored) assert.deepEqual(bytes, fs.readFileSync(path.join(paths.nightlyDir, path.basename(at))), at);
  assert.match(result.out, /^example_app: uploaded example_app-2026-11-21\.tar\.age\nsample: uploaded sample-2026-11-21\.tar\.age\n/m);
});

const programsRun = (calls) => calls.map(({ program, args }) => (program === 'rclone' ? `rclone ${args[0]}` : program));

test('the alive request is made once, after every bundle has uploaded', async () => {
  const paths = machineWithKey('sample', 'example_app');
  const result = await backup(paths);
  assert.equal(result.code, 0);
  assert.deepEqual(result.requests, [ADDRESS]);
  const programs = programsRun(result.calls);
  assert.equal(programs.indexOf('curl'), programs.length - 1);
  assert.equal(programs.filter((program) => program === 'rclone copyto').length, 2);
  assert.match(result.out, /\nThe alive request was made\.\n$/);
});

/** The stand-in programs, with `rclone` failing as `failure` says whenever `failing(verb, args)`. */
function failingStorage(failing, failure = { code: 1, stderr: '2026/11/21 03:00:09 ERROR : Attempt 3/3 failed with 1 errors\n2026/11/21 03:00:09 Failed to copyto: permission denied\n' }, offsite = offsitePrograms()) {
  const respond = (program, args, options) => (program === 'rclone' && failing(args[0], args) ? failure : offsite.respond(program, args, options));
  return { offsite, respond };
}

test('an upload that fails means no alive request, and the run fails naming the app', async () => {
  const paths = machineWithKey('example_app', 'other', 'sample');
  const result = await backup(paths, failingStorage((verb, args) => verb === 'copyto' && args.at(-1).includes('/other-')));
  assert.equal(result.code, 1);
  assert.equal(result.err, [
    'other: could not upload other\'s bundle: 2026/11/21 03:00:09 ERROR : Attempt 3/3 failed with 1 errors',
    '2026/11/21 03:00:09 Failed to copyto: permission denied',
    'error: no bundle was uploaded for other',
    '',
  ].join('\n'));
  assert.deepEqual(result.requests, []);
  assert.deepEqual([...result.stored.keys()], [`${STORAGE}/example_app-2026-11-21.tar.age`, `${STORAGE}/sample-2026-11-21.tar.age`]);
  assert.ok(fs.existsSync(path.join(paths.nightlyDir, 'other-2026-11-21.tar.age')));
});

test('an app whose bundle was not made means no alive request, and the other apps\' bundles are uploaded', async () => {
  const paths = machineWithKey('example_app', 'other', 'sample');
  const offsite = offsitePrograms();
  const result = await backup(paths, {
    offsite,
    respond: (program, args, options) => (program === '/bin/sh' && args[3] === 'other' ? { code: 1, stderr: 'pg_dump: failed\n' } : offsite.respond(program, args, options)),
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /\nerror: no bundle was made for other\n$/);
  assert.deepEqual(result.requests, []);
  assert.deepEqual([...result.stored.keys()], [`${STORAGE}/example_app-2026-11-21.tar.age`, `${STORAGE}/sample-2026-11-21.tar.age`]);
});

test('with no storage configured the bundles are made, and the run stops there saying uploads are not set up', async () => {
  const unset = {
    'no destination': (paths) => fs.rmSync(paths.backupStorage),
    'a destination file of comments': (paths) => fs.writeFileSync(paths.backupStorage, '# <remote>:<folder>\n\n'),
    'no rclone config': (paths) => fs.rmSync(paths.rcloneConfig),
  };
  for (const [what, unconfigure] of Object.entries(unset)) {
    const paths = machineWithKey('sample');
    unconfigure(paths);
    const result = await backup(paths);
    assert.equal(result.code, 1, what);
    assert.match(result.err, /^error: uploads are not set up: /, what);
    assert.equal(result.err.trimEnd().split('\n').length, 1, what);
    assert.ok(result.err.includes(paths.backupStorage) || result.err.includes(paths.rcloneConfig), what);
    assert.deepEqual(programsRun(result.calls).filter((program) => /^(rclone|curl)/.test(program)), [], what);
    assert.deepEqual(fs.readdirSync(paths.nightlyDir), ['sample-2026-11-21.tar.age'], what);
  }
});

test('uploads that are not set up and an app without a bundle are both said', async () => {
  const paths = machineWithKey('sample');
  fs.rmSync(paths.backupStorage);
  fs.rmSync(paths.settingsFile('sample'));
  const result = await backup(paths);
  assert.equal(result.code, 1);
  assert.match(result.err, /\nerror: no bundle was made for sample; uploads are not set up: /);
});

test('with no alive address set the run warns that nothing is watching it, and succeeds', async () => {
  for (const text of [null, '# the address goes here\n']) {
    const paths = machineWithKey('sample');
    fs.rmSync(paths.backupAliveAddress);
    if (text !== null) fs.writeFileSync(paths.backupAliveAddress, text);
    const result = await backup(paths);
    assert.equal(result.code, 0);
    assert.equal(result.err, `warning: no alive address is set in ${paths.backupAliveAddress}, so nothing is watching whether the backups run\n`);
    assert.equal(result.stored.size, 1);
    assert.equal(programsRun(result.calls).includes('curl'), false);
    assert.doesNotMatch(result.out, /alive/);
  }
});

const SECRETS = [CREDENTIAL, ADDRESS, 'alive.example', 'made-up-id'];
const holdsSecret = (text) => SECRETS.some((secret) => text.includes(secret));

test('neither the storage credential nor the alive address is in a program\'s arguments or environment, or in what the run prints', async () => {
  const paths = machineWithKey('sample');
  const result = await backup(paths, { offsite: storageHolding('sample-2025-01-02.tar.age') });
  assert.equal(result.code, 0);
  assert.deepEqual(programsRun(result.calls).slice(-4), ['rclone copyto', 'rclone lsf', 'rclone deletefile', 'curl']);
  assert.equal(holdsSecret(result.out + result.err), false);
  assert.equal(holdsSecret(JSON.stringify(result.calls.map(({ input, ...seenByOthers }) => seenByOthers))), false);
  assert.deepEqual(result.calls.filter(({ input }) => input !== undefined && holdsSecret(input)).map(({ program, input }) => [program, input]), [['curl', `url = "${ADDRESS}"\n`]]);
  for (const { args } of result.calls.filter(({ program }) => program === 'rclone')) assert.equal(args[args.indexOf('--config') + 1], paths.rcloneConfig);
});

test('an alive request that fails makes the run fail, without the address or what curl said of it', async () => {
  const paths = machineWithKey('sample');
  const offsite = offsitePrograms();
  const result = await backup(paths, {
    offsite,
    respond: (program, args, options) => (program === 'curl' ? { code: 6, stdout: ADDRESS, stderr: 'curl: (6) Could not resolve host: alive.example\n' } : offsite.respond(program, args, options)),
  });
  assert.equal(result.code, 1);
  assert.equal(result.err, 'error: the alive request failed: its host was not found (curl exit 6)\n');
  assert.equal(holdsSecret(result.out), false);
  assert.equal(result.stored.size, 1);
});

test('an alive address that is not an http or https address is refused, and not printed', async () => {
  for (const address of ['alive.example/ping/made-up-id', 'ftp://alive.example/made-up-id', 'https://alive.example/made-up-id"\nurl = "file:///etc/shadow', 'https://alive.example/made-up-id\\', 'https://alive.example/ made-up-id']) {
    const paths = machineWithKey('sample');
    fs.writeFileSync(paths.backupAliveAddress, `# where the alive request goes\n${address.replace('\n', '\\n')}\n`);
    const result = await backup(paths);
    assert.equal(result.code, 1, address);
    assert.equal(result.err, `error: ${paths.backupAliveAddress} does not hold an http or https address, so the alive request was not made\n`, address);
    assert.equal(programsRun(result.calls).includes('curl'), false, address);
    assert.equal(holdsSecret(result.out), false, address);
  }
});

test('a destination that spells out a remote, where a credential could be, is refused and not printed', async () => {
  for (const storage of [`:sftp,host=storage.example,pass=${CREDENTIAL}:apps-machine`, `backups,pass=${CREDENTIAL}:apps-machine`, '/mnt/apps-machine', 'apps-machine']) {
    const paths = machineWithKey('sample');
    fs.writeFileSync(paths.backupStorage, `${storage}\n`);
    const result = await backup(paths);
    assert.equal(result.code, 1, storage);
    assert.equal(result.err, `error: uploads are not set up: ${paths.backupStorage} must hold <remote>:<folder>, where <remote> is the name of a remote in ${paths.rcloneConfig}\n`, storage);
    assert.deepEqual(programsRun(result.calls).filter((program) => /^(rclone|curl)/.test(program)), [], storage);
  }
});

test('a bundle goes into the folder the destination names, and to the top of a remote that names none', async () => {
  for (const [storage, at] of [['backups:', 'backups:sample-2026-11-21.tar.age'], ['backups:apps-machine/', 'backups:apps-machine/sample-2026-11-21.tar.age'], ['my backups:a/b', 'my backups:a/b/sample-2026-11-21.tar.age']]) {
    const paths = machineWithKey('sample');
    fs.writeFileSync(paths.backupStorage, `  ${storage}  \n`);
    const result = await backup(paths);
    assert.equal(result.code, 0, storage);
    assert.deepEqual([...result.stored.keys()], [at]);
  }
});

function storageHolding(...names) {
  const offsite = offsitePrograms();
  for (const name of names) offsite.stored.set(name.includes(':') ? name : `${STORAGE}/${name}`, Buffer.from('from an earlier night'));
  return offsite;
}

test('on the storage an app keeps thirty days of bundles and the first of each month, once tonight\'s is there, and nothing else is touched', async () => {
  const paths = machineWithKey('sample', 'example_app');
  const kept = [
    'backups:elsewhere/sample-2020-01-01.tar.age', 'notes.txt', 'sample-2026-10-22.tar', 'unregistered-2020-01-01.tar.age', 'unregistered-2020-01-02.tar.age',
    'sample-2025-12-03.tar.age', 'sample-2026-10-01.tar.age', 'sample-2026-10-23.tar.age', 'example_app-2026-10-02.tar.age',
  ];
  const expired = ['sample-2025-11-01.tar.age', 'sample-2025-12-04.tar.age', 'sample-2026-10-02.tar.age', 'sample-2026-10-22.tar.age', 'example_app-2026-10-03.tar.age'];
  const offsite = storageHolding(...kept, ...expired);
  const result = await backup(paths, { offsite });
  assert.equal(result.err, '');
  assert.equal(result.code, 0);
  assert.deepEqual([...result.stored.keys()].sort(), [...storageHolding(...kept, 'example_app-2026-11-21.tar.age', 'sample-2026-11-21.tar.age').stored.keys()].sort());
  assert.deepEqual(result.out.split('\n').filter((line) => line.includes('from the storage')), [
    'example_app: removed example_app-2026-10-03.tar.age from the storage',
    'sample: removed sample-2025-11-01.tar.age from the storage',
    'sample: removed sample-2025-12-04.tar.age from the storage',
    'sample: removed sample-2026-10-02.tar.age from the storage',
    'sample: removed sample-2026-10-22.tar.age from the storage',
  ]);
  assert.deepEqual(result.requests, [ADDRESS]);
});

test('an app whose bundle did not upload tonight keeps what it has on the storage', async () => {
  const paths = machineWithKey('sample', 'example_app');
  const offsite = storageHolding('sample-2025-01-01.tar.age', 'sample-2025-01-02.tar.age', 'example_app-2025-01-01.tar.age', 'example_app-2025-01-02.tar.age');
  const result = await backup(paths, failingStorage((verb, args) => verb === 'copyto' && args.at(-1).includes('/sample-'), undefined, offsite));
  assert.equal(result.code, 1);
  assert.deepEqual([...result.stored.keys()].map((at) => path.posix.basename(at)), ['sample-2025-01-01.tar.age', 'sample-2025-01-02.tar.age', 'example_app-2026-11-21.tar.age']);
});

test('a storage that cannot be listed or pruned means no alive request, and the run fails saying which', async () => {
  const refused = { code: 1, stderr: '2026/11/21 03:00:09 Failed: permission denied\n' };
  for (const [verb, message] of [
    ['lsf', 'error: could not list the bundles on the storage: 2026/11/21 03:00:09 Failed: permission denied\n'],
    ['deletefile', 'error: could not remove sample-2025-01-02.tar.age from the storage: 2026/11/21 03:00:09 Failed: permission denied\n'],
  ]) {
    const paths = machineWithKey('sample');
    const offsite = storageHolding('sample-2025-01-02.tar.age');
    const result = await backup(paths, failingStorage((asked) => asked === verb, refused, offsite));
    assert.equal(result.code, 1, verb);
    assert.equal(result.err, message);
    assert.deepEqual(result.requests, [], verb);
    assert.ok(result.stored.has(`${STORAGE}/sample-2026-11-21.tar.age`), verb);
  }
});
