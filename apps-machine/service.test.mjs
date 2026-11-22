import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { machinePaths } from './paths.mjs';
import { installService, pointServiceAt, renderUnit, servicePointsAt, startService, stopService } from './service.mjs';
import { fakeRun, machine, mode, withUmask } from './test-helpers.mjs';

const notYetEnabled = (program, args) => (args[0] === 'is-enabled' ? { code: 1 } : {});

/** A machine with a release of the sample app in place, as a deploy has it before it points the service there. */
function withRelease(id = 'r1', paths = machine()) {
  const release = path.join(paths.releasesDir('sample'), id);
  fs.mkdirSync(release, { recursive: true });
  return { paths, release };
}

test('an app\'s unit runs the current release\'s start command as the app\'s user, with its settings', () => {
  const unit = renderUnit(machinePaths(), 'sample');
  const lines = unit.split('\n');
  for (const line of [
    'User=sample',
    'Group=sample',
    'EnvironmentFile=/etc/apps-machine/settings/sample.env',
    'WorkingDirectory=/var/lib/apps-machine/apps/sample/current',
    'ExecStart=/bin/sh /var/lib/apps-machine/apps/sample/start',
    'ConditionPathExists=/var/lib/apps-machine/apps/sample/current',
    'Restart=always',
    'StandardOutput=journal',
    'StandardError=journal',
    'WantedBy=multi-user.target',
  ]) assert.ok(lines.includes(line), `no line ${line}`);
  assert.doesNotMatch(unit, /[{}]/);
  assert.doesNotMatch(renderUnit(machinePaths(), 'example_app'), /sample/);
});

test('an app that answers a stop by exiting 143 has stopped cleanly, and no other status is added to the clean ones', () => {
  const settings = renderUnit(machinePaths(), 'sample').split('\n').filter((line) => /^(SuccessExitStatus|RestartPreventExitStatus)=/.test(line));
  assert.deepEqual(settings, ['SuccessExitStatus=143']);
});

test('installing an app\'s service writes its unit and turns it on for the next boot, without starting it', () => {
  const paths = machine();
  const { run, calls } = fakeRun(notYetEnabled);
  installService({ run, paths }, 'sample');
  assert.equal(fs.readFileSync(paths.unitFile('sample'), 'utf8'), renderUnit(paths, 'sample'));
  assert.equal(mode(paths.unitFile('sample')), 0o644);
  assert.deepEqual(calls.map(({ program, args }) => [program, ...args]), [
    ['systemctl', 'daemon-reload'],
    ['systemctl', 'is-enabled', '--quiet', 'app-sample.service'],
    ['systemctl', 'enable', 'app-sample.service'],
  ]);
});

test('installing a service that is as the template has it, and on, changes nothing', () => {
  const paths = machine();
  installService({ run: fakeRun(notYetEnabled).run, paths }, 'sample');
  const before = fs.statSync(paths.unitFile('sample'));
  const { run, calls } = fakeRun();
  installService({ run, paths }, 'sample');
  const after = fs.statSync(paths.unitFile('sample'));
  assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs]);
  assert.deepEqual(calls.map(({ program, args }) => [program, ...args]), [['systemctl', 'is-enabled', '--quiet', 'app-sample.service']]);
});

test('a unit that differs from the template is written again and systemd told', () => {
  const paths = machine();
  installService({ run: fakeRun().run, paths }, 'sample');
  fs.writeFileSync(paths.unitFile('sample'), '[Unit]\nDescription=an older template\n');
  const { run, calls } = fakeRun();
  installService({ run, paths }, 'sample');
  assert.equal(fs.readFileSync(paths.unitFile('sample'), 'utf8'), renderUnit(paths, 'sample'));
  assert.deepEqual(calls[0].args, ['daemon-reload']);
});

test('a service is stopped and started by its unit\'s name', () => {
  const paths = machine();
  const { run, calls } = fakeRun();
  stopService({ run, paths }, 'sample');
  startService({ run, paths }, 'sample');
  assert.deepEqual(calls.map(({ program, args }) => [program, ...args]), [
    ['systemctl', 'stop', 'app-sample.service'],
    ['systemctl', 'start', 'app-sample.service'],
  ]);
});

test('a service systemd could not stop, start or turn on fails with what systemctl said', () => {
  const paths = machine();
  const { run } = fakeRun((program, args) => (args[0] === 'daemon-reload' ? {} : { code: 1, stderr: 'Failed: no such unit\n' }));
  assert.throws(() => stopService({ run, paths }, 'sample'), /^Error: systemctl stop app-sample\.service failed: Failed: no such unit$/);
  assert.throws(() => startService({ run, paths }, 'sample'), /^Error: systemctl start app-sample\.service failed: Failed: no such unit$/);
  assert.throws(() => installService({ run, paths }, 'sample'), /^Error: systemctl enable app-sample\.service failed: Failed: no such unit$/);
});

test('before a first deploy an app\'s service points at nothing', () => {
  assert.equal(servicePointsAt(machine(), 'sample'), null);
});

test('a service pointed at a release runs that release with its start command', () => {
  const { paths, release } = withRelease();
  const { run } = fakeRun();
  withUmask(0o077, () => pointServiceAt({ run, paths }, 'sample', { release, start: 'node server.js --port 3000' }));
  assert.equal(fs.realpathSync(paths.currentRelease('sample')), fs.realpathSync(release));
  assert.equal(fs.readFileSync(paths.startFile('sample'), 'utf8'), 'node server.js --port 3000\n');
  assert.equal(mode(paths.startFile('sample')), 0o644);
  assert.deepEqual(servicePointsAt(paths, 'sample'), { release, start: 'node server.js --port 3000' });
});

test('pointing a service at a release brings its unit up to the template', () => {
  const { paths, release } = withRelease();
  const { run, calls } = fakeRun();
  pointServiceAt({ run, paths }, 'sample', { release, start: 'npm start' });
  assert.equal(fs.readFileSync(paths.unitFile('sample'), 'utf8'), renderUnit(paths, 'sample'));
  assert.deepEqual(calls.map(({ program, args }) => [program, ...args]), [['systemctl', 'daemon-reload']]);
  const again = fakeRun();
  pointServiceAt({ run: again.run, paths }, 'sample', { release, start: 'npm start' });
  assert.deepEqual(again.calls, []);
});

test('pointing a registered app\'s service, whose unit an older template wrote, writes the unit as the template has it now and has systemd read it', () => {
  const { paths, release } = withRelease();
  const older = renderUnit(paths, 'sample').replace('SuccessExitStatus=143\n', '');
  fs.mkdirSync(path.dirname(paths.unitFile('sample')), { recursive: true });
  fs.writeFileSync(paths.unitFile('sample'), older);
  const { run, calls } = fakeRun();
  pointServiceAt({ run, paths }, 'sample', { release, start: 'npm start' });
  assert.notEqual(renderUnit(paths, 'sample'), older);
  assert.equal(fs.readFileSync(paths.unitFile('sample'), 'utf8'), renderUnit(paths, 'sample'));
  assert.deepEqual(calls.map(({ program, args }) => [program, ...args]), [['systemctl', 'daemon-reload']]);
});

test('a service can be pointed back at what it pointed at before', () => {
  const { paths, release: first } = withRelease('r1');
  const { release: second } = withRelease('r2', paths);
  const world = { run: fakeRun().run, paths };
  pointServiceAt(world, 'sample', { release: first, start: 'node old.js' });
  const previous = servicePointsAt(paths, 'sample');
  pointServiceAt(world, 'sample', { release: second, start: 'node new.js' });
  assert.deepEqual(servicePointsAt(paths, 'sample'), { release: second, start: 'node new.js' });
  pointServiceAt(world, 'sample', previous);
  assert.deepEqual(servicePointsAt(paths, 'sample'), { release: first, start: 'node old.js' });
  assert.deepEqual(fs.readdirSync(paths.appDir('sample')).sort(), ['current', 'releases', 'start']);
});

test('a pointing that was cut short does not stop the next one', () => {
  const { paths, release } = withRelease();
  fs.symlinkSync('releases/gone', `${paths.currentRelease('sample')}.new`);
  pointServiceAt({ run: fakeRun().run, paths }, 'sample', { release, start: 'npm start' });
  assert.deepEqual(servicePointsAt(paths, 'sample'), { release, start: 'npm start' });
  assert.deepEqual(fs.readdirSync(paths.appDir('sample')).sort(), ['current', 'releases', 'start']);
});

test('a service pointed at nothing has no current release, as before a first deploy', () => {
  const { paths, release } = withRelease();
  const world = { run: fakeRun().run, paths };
  pointServiceAt(world, 'sample', { release, start: 'npm start' });
  pointServiceAt(world, 'sample', null);
  assert.equal(servicePointsAt(paths, 'sample'), null);
  assert.deepEqual(fs.readdirSync(paths.appDir('sample')), ['releases']);
  pointServiceAt(world, 'sample', null);
});

test('a service is pointed only at a release of its own app that exists, with a start command', () => {
  const { paths, release } = withRelease();
  const world = { run: fakeRun().run, paths };
  const elsewhere = path.join(paths.releasesDir('example_app'), 'r1');
  fs.mkdirSync(elsewhere, { recursive: true });
  for (const other of [elsewhere, path.join(paths.releasesDir('sample'), 'missing'), paths.releasesDir('sample'), path.join(release, 'inner')]) {
    assert.throws(() => pointServiceAt(world, 'sample', { release: other, start: 'npm start' }), /is not a release of sample$/, other);
  }
  for (const start of ['', '  ', undefined]) {
    assert.throws(() => pointServiceAt(world, 'sample', { release, start }), /^Error: a release needs a start command$/);
  }
  assert.equal(servicePointsAt(paths, 'sample'), null);
});
