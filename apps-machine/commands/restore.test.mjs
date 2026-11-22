import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeRelease } from '../releases.mjs';
import { Interrupted, run as realRun } from '../run.mjs';
import { pointServiceAt } from '../service.mjs';
import { DEPLOY_SECTION, appsMachine, archiveOf, commandLines, decryptedBundle, fakeRun, filesUnder, machine, machinePrograms, mode, registered, standInDump, standInDumpOf, standInDumpText, withUmask } from '../test-helpers.mjs';

const USAGE = 'usage: apps-machine restore <name> <file> [--settings]\n';
const NOW = () => new Date(Date.UTC(2026, 10, 21, 14, 30, 5));
const STAMP = '20261121T143005Z';
const NIGHT_SETTINGS = 'DATABASE_URL=postgres://sample:0ldpassw0rd@127.0.0.1:5432/sample\nKEY="that night\'s"\n';

/**
 * A machine with `sample` registered, the machine's own `tar`, and stand-ins for the rest. Postgres
 * is `state.data`, the text the database holds: a dump of it is the stand-in dump of that text.
 * `state.running` is the service, `state.events` what was done, and a name in `state.fails` fails.
 */
function sampleMachine({ data = 'as it is now', deployed = true } = {}) {
  const paths = machine();
  registered(paths, { name: 'sample' });
  if (deployed) {
    const config = { ...DEPLOY_SECTION, start: 'node server.mjs', port: 4310 };
    fs.mkdirSync(paths.incomingRelease('sample'));
    const release = makeRelease({ run: fakeRun().run, paths }, 'sample', { checkout: paths.incomingRelease('sample'), commit: 'c0ffee'.padEnd(40, '0'), stamp: '20261101T090000Z', config });
    pointServiceAt({ run: fakeRun().run, paths }, 'sample', { release, start: config.start });
  }
  const state = { data, running: deployed, events: [], fails: {}, password: null };
  const programs = machinePrograms({ users: ['sample'] });
  const failing = (what, said) => (state.fails[what] ? { code: 1, stderr: `${said}\n` } : {});
  const { run, calls } = fakeRun((program, args, options = {}) => {
    const { input = '' } = options;
    if (program === 'tar') return realRun(program, args, options);
    if (standInDump(program, args, state.fails.dump ? null : state.data)) {
      state.events.push('dump');
      return failing('dump', 'pg_dump: error: said this');
    } else if (program === '/bin/sh' && args[1].includes('pg_restore --list')) {
      return standInDumpText(args.at(-1)) === null ? { code: 1, stderr: 'pg_restore: error: input file does not appear to be a valid archive\n' } : {};
    } else if (program === '/bin/sh' && args[1].includes('pg_restore')) {
      state.events.push('restore');
      if (state.fails.restore) return failing('restore', 'pg_restore: error: said this');
      state.data = standInDumpText(args.at(-1));
    } else if (/^DROP DATABASE/.test(input)) {
      state.events.push('drop');
      state.data = null;
    } else if (/CREATE DATABASE/.test(input)) {
      state.data ??= '';
    } else if (/^ALTER ROLE/.test(input)) {
      state.events.push('password');
      if (state.fails.password) return failing('password', 'psql: said this');
      state.password = /PASSWORD '(.*)'/.exec(input)[1];
    } else if (program === 'systemctl' && args[0] === 'stop') {
      state.events.push('stop');
      if (state.fails.stop) return failing('stop', 'systemctl: said this');
      state.running = false;
    } else if (program === 'systemctl' && args[0] === 'start') {
      state.events.push('start');
      if (state.fails.start) return failing('start', 'systemctl: said this');
      state.running = true;
    } else if (program === 'timeout' && args.includes('curl')) {
      state.events.push('health');
      if (state.fails.health === 'interrupted') throw new Interrupted('SIGHUP');
      return { code: state.fails.health ? 124 : 0 };
    }
    return programs(program, args, options);
  });
  const restore = (...argv) => appsMachine(['restore', ...argv], { run, paths, now: NOW });
  return { paths, state, calls, run, restore, before: path.join(paths.restoreDumps('sample'), `${STAMP}.dump`) };
}

const lastNight = (overrides = {}) => decryptedBundle({ app: 'sample', date: '2026-11-20', dump: standInDumpOf('as it was that night'), settings: NIGHT_SETTINGS, ...overrides });

test('restoring a night\'s bundle puts the database back as it was that night, with the service stopped while it is replaced, started after, and asked whether it answers', async () => {
  const { state, restore } = sampleMachine();
  const done = await restore('sample', lastNight());
  assert.equal(done.err, '');
  assert.equal(done.code, 0);
  assert.equal(state.data, 'as it was that night');
  assert.equal(state.running, true);
  assert.deepEqual(state.events, ['stop', 'dump', 'drop', 'restore', 'start', 'health']);
  assert.match(done.out, /^sample is restored and answering\.$/m);
});

test('the health path asked is the one the running release was deployed with, on its port', async () => {
  const { calls, restore } = sampleMachine();
  await restore('sample', lastNight());
  const asked = commandLines(calls).filter((line) => line.startsWith('timeout '));
  assert.equal(asked.length, 1);
  assert.match(asked[0], / curl .* http:\/\/127\.0\.0\.1:4310\/healthz$/);
});

test('an app that does not answer after a restore is stopped again, and the restore fails naming the dump taken at the start', async () => {
  const { state, restore, before } = sampleMachine();
  state.fails.health = true;
  const done = await restore('sample', lastNight());
  assert.equal(done.code, 1);
  assert.deepEqual(state.events, ['stop', 'dump', 'drop', 'restore', 'start', 'health', 'stop']);
  assert.equal(state.running, false);
  assert.equal(state.data, 'as it was that night');
  assert.equal(done.err, [
    'app-sample.service is stopped.',
    `sample's database as it was before this restore is in ${before}. To put it back:`,
    `  sudo apps-machine restore sample ${before}`,
    'error: the restore of sample stopped at health: /healthz on port 4310 did not answer with success within 90 seconds',
    '',
  ].join('\n'));
});

test('a running release whose record of its deploy section cannot be read is refused before anything is stopped', async () => {
  const { paths, state, restore } = sampleMachine();
  fs.rmSync(`${fs.realpathSync(paths.currentRelease('sample'))}.json`);
  const done = await restore('sample', lastNight());
  assert.equal(done.code, 1);
  assert.match(done.err, /^error: cannot tell where sample answers: ENOENT: .*\.json'\n$/);
  assert.equal(state.running, true);
  assert.deepEqual(state.events, []);
});

test('the database as it was is dumped once the service is stopped, so the dump misses nothing the app wrote, for root alone, and the way to put it back is printed', async () => {
  const { paths, state, restore, before } = sampleMachine();
  const done = await restore('sample', lastNight());
  assert.deepEqual(state.events.slice(0, 2), ['stop', 'dump']);
  assert.deepEqual(fs.readFileSync(before), standInDumpOf('as it is now'));
  assert.equal(mode(before), 0o600);
  assert.equal(mode(paths.restoreDumps('sample')), 0o700);
  assert.match(done.out, new RegExp(`^Dumped sample's database as it is now to ${before}$`, 'm'));
  assert.ok(done.out.includes(`sample's database as it was before this restore is in ${before}. To put it back:\n  sudo apps-machine restore sample ${before}\n`));
});

test('the dump taken before a restore undoes it, and is kept', async () => {
  const { state, restore, before } = sampleMachine();
  await restore('sample', lastNight());
  const undone = await restore('sample', before);
  assert.equal(undone.code, 0);
  assert.equal(state.data, 'as it is now');
  assert.deepEqual(fs.readFileSync(before), standInDumpOf('as it is now'));
});

test('the dump a deploy took restores as a bundle\'s does, and stays where the deploy put it', async () => {
  const { paths, state, restore } = sampleMachine();
  const taken = path.join(paths.deployDumps('sample'), '20261121T120000Z.dump');
  fs.mkdirSync(path.dirname(taken), { recursive: true });
  fs.writeFileSync(taken, standInDumpOf('as it was before the deploy'));
  const done = await restore('sample', taken);
  assert.equal(done.err, '');
  assert.equal(done.code, 0);
  assert.equal(state.data, 'as it was before the deploy');
  assert.deepEqual(state.events, ['stop', 'dump', 'drop', 'restore', 'start', 'health']);
  assert.deepEqual(fs.readFileSync(taken), standInDumpOf('as it was before the deploy'));
  assert.doesNotMatch(done.out, /Removed/);
});

test('without --settings the settings file is left as it is', async () => {
  const { paths, state, restore } = sampleMachine();
  const settings = fs.readFileSync(paths.settingsFile('sample'));
  const done = await restore('sample', lastNight());
  assert.deepEqual(fs.readFileSync(paths.settingsFile('sample')), settings);
  assert.equal(state.password, null);
  assert.match(done.out, /^Left sample's settings file as it is$/m);
  assert.deepEqual(filesUnder(paths.restoreDumps('sample')), [`${STAMP}.dump`]);
});

test('with --settings the bundle\'s settings file replaces the app\'s, byte for byte and root\'s alone, and the one replaced is kept', async () => {
  const { paths, restore } = sampleMachine();
  const replaced = fs.readFileSync(paths.settingsFile('sample'));
  const settings = Buffer.from(`${NIGHT_SETTINGS}# caf\xe9\n`, 'latin1');
  const done = await withUmask(0o022, () => restore('sample', lastNight({ settings }), '--settings'));
  assert.equal(done.err, '');
  assert.equal(done.code, 0);
  assert.deepEqual(fs.readFileSync(paths.settingsFile('sample')), settings);
  assert.equal(mode(paths.settingsFile('sample')), 0o600);
  assert.equal(fs.statSync(paths.settingsFile('sample')).uid, process.getuid());
  const kept = path.join(paths.restoreDumps('sample'), `${STAMP}.env`);
  assert.deepEqual(fs.readFileSync(kept), replaced);
  assert.equal(mode(kept), 0o600);
  assert.ok(done.out.includes(`Its settings file as it was is in ${kept}\n`));
});

test('the option may come before the app\'s name', async () => {
  const { paths, restore } = sampleMachine();
  const done = await restore('--settings', 'sample', lastNight());
  assert.equal(done.code, 0);
  assert.equal(fs.readFileSync(paths.settingsFile('sample'), 'utf8'), NIGHT_SETTINGS);
});

test('the app\'s role is given the password the settings put back name, after the database is restored and before the service starts', async () => {
  const { state, calls, restore } = sampleMachine();
  await restore('sample', lastNight(), '--settings');
  assert.equal(state.password, '0ldpassw0rd');
  assert.deepEqual(state.events, ['stop', 'dump', 'drop', 'restore', 'password', 'start', 'health']);
  for (const call of calls) assert.ok(!call.args.join(' ').includes('0ldpassw0rd'));
});

test('a bundle whose settings are the file register wrote on another machine gives the role that machine\'s password', async () => {
  const lost = sampleMachine();
  const written = fs.readFileSync(lost.paths.settingsFile('sample'));
  const [, password] = /^DATABASE_URL=postgres:\/\/sample:([0-9a-f]{48})@/m.exec(written.toString());
  const { paths, state, restore } = sampleMachine();
  assert.notDeepEqual(fs.readFileSync(paths.settingsFile('sample')), written);
  const done = await restore('sample', lastNight({ settings: written }), '--settings');
  assert.equal(done.err, '');
  assert.equal(done.code, 0);
  assert.equal(state.password, password);
  assert.deepEqual(fs.readFileSync(paths.settingsFile('sample')), written);
});

test('an app whose settings file is gone gets the bundle\'s with --settings, and there is none to keep', async () => {
  const { paths, restore } = sampleMachine();
  fs.rmSync(paths.settingsFile('sample'));
  const done = await restore('sample', lastNight(), '--settings');
  assert.equal(done.code, 0);
  assert.equal(fs.readFileSync(paths.settingsFile('sample'), 'utf8'), NIGHT_SETTINGS);
  assert.deepEqual(filesUnder(paths.restoreDumps('sample')), [`${STAMP}.dump`]);
  assert.doesNotMatch(done.out, /Its settings file as it was/);
});

test('settings put back whose DATABASE_URL is not one register wrote leave the password alone, with a warning that names the file and not what it holds', async () => {
  for (const settings of ['DATABASE_URL=postgres://sample:s3cret@db.example:5432/sample\n', 'KEY=value\n', 'not a setting s3cret\n']) {
    const { paths, state, restore } = sampleMachine();
    const done = await restore('sample', lastNight({ settings }), '--settings');
    assert.equal(done.code, 0, settings);
    assert.equal(fs.readFileSync(paths.settingsFile('sample'), 'utf8'), settings);
    assert.equal(state.password, null);
    assert.equal(state.running, true);
    assert.equal(done.err, `warning: the settings file put back does not hold DATABASE_URL as register writes it, so sample's database password is as it was. If sample cannot open its database, correct DATABASE_URL in ${paths.settingsFile('sample')}\n`);
    assert.doesNotMatch(done.out + done.err, /s3cret/);
  }
});

/** A restore that changed nothing: the service was never stopped and the database is as it was. */
function assertRefused(done, state, message) {
  assert.equal(done.code, 1);
  assert.equal(done.err, `error: ${message}\n`);
  assert.equal(state.data, 'as it is now');
  assert.equal(state.running, true);
  assert.deepEqual(state.events, []);
}

test('a bundle of another app is refused before anything is stopped', async () => {
  const { state, restore } = sampleMachine();
  const bundle = decryptedBundle({ app: 'example_app', dump: standInDumpOf('another app\'s'), settings: NIGHT_SETTINGS });
  assertRefused(await restore('sample', bundle), state, `${bundle} is a bundle of example_app, not of sample`);
});

test('a file that is neither a bundle nor a dump is refused before anything is stopped, and left where it is', async () => {
  const { paths, state, restore } = sampleMachine();
  const notes = path.join(paths.root, 'notes.txt');
  fs.writeFileSync(notes, 'notes\n');
  assertRefused(await restore('sample', notes), state,
    `${notes} is neither a decrypted bundle nor a database dump: pg_restore: error: input file does not appear to be a valid archive`);
  assert.equal(fs.readFileSync(notes, 'utf8'), 'notes\n');
});

test('a bundle that is still encrypted is refused, saying where it is decrypted, and left where it is', async () => {
  const { paths, state, restore } = sampleMachine();
  const sealed = path.join(paths.root, 'sample-2026-11-20.tar.age');
  fs.writeFileSync(sealed, Buffer.concat([Buffer.from('age-encryption.org/v1\n-> X25519 madeup\n'), Buffer.from([0xff, 0x00])]));
  assertRefused(await restore('sample', sealed), state,
    `${sealed} is still encrypted: decrypt it on the device that holds the private key, and bring what that gives`);
  assert.ok(fs.existsSync(sealed));
});

test('a bundle whose dump pg_restore cannot read is refused before anything is stopped', async () => {
  const { state, restore } = sampleMachine();
  const bundle = lastNight({ dump: 'cut short' });
  assertRefused(await restore('sample', bundle), state,
    `the dump in ${bundle} cannot be restored: pg_restore: error: input file does not appear to be a valid archive`);
});

test('a bundle missing one of its files is refused before anything is stopped', async () => {
  const { state, restore } = sampleMachine();
  const bundle = archiveOf({ 'bundle.json': '{"format":1,"app":"sample","date":"2026-11-20"}\n', 'database.dump': standInDumpOf('as it was that night') });
  const done = await restore('sample', bundle);
  assert.equal(done.code, 1);
  assert.match(done.err, /^error: could not open the bundle .*: tar: settings\.env: Not found in archive/);
  assert.equal(state.running, true);
  assert.deepEqual(state.events, []);
});

test('--settings with a dump is refused before anything is stopped: a dump holds no settings file', async () => {
  const { paths, state, restore } = sampleMachine();
  const dump = path.join(paths.backupDir, 'a.dump');
  fs.writeFileSync(dump, standInDumpOf('from a deploy'));
  assertRefused(await restore('sample', dump, '--settings'), state, `${dump} is a dump, which holds no settings file: leave out --settings`);
});

test('an app that is not registered, and a file that is not there, are refused', async () => {
  const { paths, state, restore } = sampleMachine();
  const dump = path.join(paths.backupDir, 'a.dump');
  fs.writeFileSync(dump, standInDumpOf('from a deploy'));
  assertRefused(await restore('example_app', dump), state, 'no app named example_app is registered on this machine');
  assertRefused(await restore('sample', path.join(paths.root, 'missing.tar')), state, `${path.join(paths.root, 'missing.tar')} is not a file`);
  assertRefused(await restore('sample', paths.backupDir), state, `${paths.backupDir} is not a file`);
});

test('when the service cannot be stopped or the database dumped, nothing is replaced and the service is started again', async () => {
  for (const [failing, events, said] of [
    ['dump', ['stop', 'dump', 'start'], 'the restore of sample stopped at dump: could not dump sample\'s database: pg_dump: error: said this'],
    ['stop', ['stop', 'start'], 'the restore of sample stopped at stop: systemctl stop app-sample.service failed: systemctl: said this'],
  ]) {
    const { paths, state, restore } = sampleMachine();
    state.fails[failing] = true;
    const done = await restore('sample', lastNight());
    assert.equal(done.code, 1, failing);
    assert.equal(done.err, `Nothing was replaced. app-sample.service was started again.\nerror: ${said}\n`);
    assert.equal(state.data, 'as it is now', failing);
    assert.equal(state.running, true, failing);
    assert.deepEqual(state.events, events, failing);
    assert.deepEqual(filesUnder(paths.restoreDumps('sample')), [], failing);
  }
});

test('a service that cannot be started again after a dump that failed is said, with where to look', async () => {
  const { state, restore } = sampleMachine();
  Object.assign(state.fails, { dump: true, start: true });
  const done = await restore('sample', lastNight());
  assert.equal(done.code, 1);
  assert.equal(done.err.split('\n')[0], 'Nothing was replaced, but app-sample.service could not be started again: see systemctl status app-sample.service');
  assert.equal(state.data, 'as it is now');
});

test('the decrypted bundle is gone from the machine however the restore ends, and nothing of it is left in the backup directory', async () => {
  const outcomes = {
    'restored': (m, given) => m.restore('sample', given.whole, '--settings'),
    'another app\'s': (m, given) => m.restore('sample', given.other),
    'for an app not registered': (m, given) => m.restore('example_app', given.whole),
    'its dump unreadable': (m, given) => m.restore('sample', given.unreadable),
    'missing a file': (m, given) => m.restore('sample', given.partial),
    'the dump before it failing': (m, given) => { m.state.fails.dump = true; return m.restore('sample', given.whole); },
    'the restore failing': (m, given) => { m.state.fails.restore = true; return m.restore('sample', given.whole); },
    'the start failing': (m, given) => { m.state.fails.start = true; return m.restore('sample', given.whole); },
    'the app not answering': (m, given) => { m.state.fails.health = true; return m.restore('sample', given.whole); },
  };
  for (const [outcome, act] of Object.entries(outcomes)) {
    const m = sampleMachine();
    const given = {
      whole: lastNight(),
      other: decryptedBundle({ app: 'example_app', dump: standInDumpOf('another app\'s'), settings: NIGHT_SETTINGS }),
      unreadable: lastNight({ dump: 'cut short' }),
      partial: archiveOf({ 'bundle.json': '{"format":1,"app":"sample","date":"2026-11-20"}\n', 'database.dump': standInDumpOf('that night') }),
    };
    const done = await act(m, given);
    const used = Object.values(given).filter((file) => !fs.existsSync(file));
    assert.equal(used.length, 1, outcome);
    assert.ok(done.out.endsWith(`Removed the decrypted bundle ${used[0]}\n`), outcome);
    assert.deepEqual(fs.readdirSync(m.paths.backupDir, { recursive: true }).filter((entry) => entry.startsWith('work/')), [], outcome);
    assert.deepEqual(filesUnder(m.paths.backupDir).filter((file) => !file.startsWith('restores/sample/')), [], outcome);
  }
});

test('a restore interrupted while it waits for the app to answer stops the service again and leaves nothing of the bundle', async () => {
  const m = sampleMachine();
  m.state.fails.health = 'interrupted';
  const bundle = lastNight();
  const done = await m.restore('sample', bundle);
  assert.equal(done.code, 1);
  assert.equal(done.err.split('\n').at(-2), 'error: the restore of sample stopped at health: interrupted by SIGHUP');
  assert.equal(m.state.events.at(-1), 'stop');
  assert.equal(m.state.running, false);
  assert.ok(!fs.existsSync(bundle));
  assert.deepEqual(filesUnder(m.paths.backupDir).filter((file) => !file.startsWith('restores/sample/')), []);
});

test('a bundle given through a link is itself removed', async () => {
  const { paths, restore } = sampleMachine();
  const bundle = lastNight();
  const link = path.join(paths.root, 'latest.tar');
  fs.symlinkSync(bundle, link);
  const done = await restore('sample', link);
  assert.equal(done.code, 0);
  assert.ok(!fs.existsSync(bundle));
});

test('the bundle\'s files are taken out only into the restore\'s own directory, which root alone can enter', async () => {
  const m = sampleMachine();
  const seen = new Map();
  const watched = (program, args, options) => {
    const done = m.run(program, args, options);
    for (const file of filesUnder(m.paths.root)) {
      if (/(database\.dump|settings\.env|bundle\.json)$/.test(file)) seen.set(file, mode(path.dirname(path.join(m.paths.root, file))));
    }
    return done;
  };
  const done = await appsMachine(['restore', 'sample', lastNight(), '--settings'], { run: watched, paths: m.paths, now: NOW });
  assert.equal(done.code, 0);
  const work = path.relative(m.paths.root, m.paths.backupWorkDir);
  assert.equal(seen.size, 3);
  for (const [file, dirMode] of seen) {
    assert.match(path.relative(work, file), /^\d+-[^/]+\/(bundle\.json|database\.dump|settings\.env)$/);
    assert.equal(dirMode, 0o700);
  }
});

test('a restore that fails once the service is stopped leaves it stopped, says so, and names the dump taken at the start', async () => {
  for (const [failing, step, said, events] of [
    ['restore', 'database', 'could not restore sample\'s database: pg_restore: error: said this', ['stop', 'dump', 'drop', 'restore', 'stop']],
    ['start', 'start', 'systemctl start app-sample.service failed: systemctl: said this', ['stop', 'dump', 'drop', 'restore', 'start', 'stop']],
  ]) {
    const { state, restore, before } = sampleMachine();
    state.fails[failing] = true;
    const done = await restore('sample', lastNight());
    assert.equal(done.code, 1, failing);
    assert.deepEqual(state.events, events, failing);
    assert.equal(done.err, [
      'app-sample.service is stopped.',
      `sample's database as it was before this restore is in ${before}. To put it back:`,
      `  sudo apps-machine restore sample ${before}`,
      `error: the restore of sample stopped at ${step}: ${said}`,
      '',
    ].join('\n'), failing);
    assert.equal(state.running, false, failing);
    assert.deepEqual(fs.readFileSync(before), standInDumpOf('as it is now'));
    assert.doesNotMatch(done.out, /is restored/);
  }
});

test('a restore that fails after the settings were put back names the settings file it replaced too', async () => {
  for (const [failing, step] of [['password', 'settings'], ['start', 'start']]) {
    const { paths, state, restore } = sampleMachine();
    const replaced = fs.readFileSync(paths.settingsFile('sample'));
    state.fails[failing] = true;
    const done = await restore('sample', lastNight(), '--settings');
    assert.equal(done.code, 1, failing);
    const kept = path.join(paths.restoreDumps('sample'), `${STAMP}.env`);
    assert.ok(done.err.includes(`Its settings file as it was is in ${kept}\n`), failing);
    assert.deepEqual(fs.readFileSync(kept), replaced);
    assert.match(done.err, new RegExp(`^error: the restore of sample stopped at ${step}: `, 'm'));
    assert.equal(state.running, false);
  }
});

test('an app whose service points at no release, never deployed or its first deploy failed, gets its database back, and nothing is started', async () => {
  const { state, restore } = sampleMachine({ deployed: false });
  const done = await restore('sample', lastNight());
  assert.equal(done.err, '');
  assert.equal(done.code, 0);
  assert.equal(state.data, 'as it was that night');
  assert.deepEqual(state.events, ['stop', 'dump', 'drop', 'restore']);
  assert.match(done.out, /^sample is restored\. Its service points at no release, because it has never been deployed or its first deploy failed, so nothing was started: its next deploy starts it\.$/m);
});

test('anything but a name, a file and --settings is a usage error, and nothing is run or removed', async () => {
  const bundle = lastNight();
  for (const argv of [[], ['sample'], ['sample', bundle, 'more'], ['sample', bundle, '--setings'], ['sample', '--settings'], ['sample', bundle, '--settings', '--force']]) {
    const { calls, restore } = sampleMachine();
    const done = await restore(...argv);
    assert.equal(done.code, 2, argv.join(' '));
    assert.ok(done.err.endsWith(USAGE));
    assert.deepEqual(calls, []);
  }
  assert.ok(fs.existsSync(bundle));
});

test('a usage error names each file it was given and did not remove, since a decrypted bundle left behind is unencrypted', async () => {
  const bundle = lastNight();
  const { restore } = sampleMachine();
  const done = await restore(bundle, 'more', '--force');
  assert.equal(done.code, 2);
  assert.equal(done.err, `error: still on this machine, where a decrypted bundle is unencrypted: ${bundle}\n${USAGE}`);
  assert.equal((await restore('sample')).err, USAGE);
});
