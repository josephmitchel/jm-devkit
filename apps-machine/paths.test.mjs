import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { machinePaths, serviceName } from './paths.mjs';

test('on a real machine the registrations are in /etc/apps-machine/apps', () => {
  const paths = machinePaths();
  assert.equal(paths.configDir, '/etc/apps-machine');
  assert.equal(paths.registration('sample'), '/etc/apps-machine/apps/sample.json');
});

test('an app\'s settings and deploy key are in root\'s directory, and its files in a directory of its own', () => {
  const paths = machinePaths();
  assert.equal(paths.settingsFile('sample'), '/etc/apps-machine/settings/sample.env');
  assert.equal(paths.deployKey('sample'), '/etc/apps-machine/keys/sample');
  assert.equal(paths.appDir('sample'), '/var/lib/apps-machine/apps/sample');
  assert.equal(paths.appHome('sample'), '/var/lib/apps-machine/apps/sample/home');
  assert.equal(paths.releasesDir('sample'), '/var/lib/apps-machine/apps/sample/releases');
  assert.equal(paths.currentRelease('sample'), '/var/lib/apps-machine/apps/sample/current');
  assert.equal(paths.startFile('sample'), '/var/lib/apps-machine/apps/sample/start');
  assert.equal(paths.backupDir, '/var/lib/apps-machine/backups');
});

test('an app\'s service has a name no unit of the machine\'s own has', () => {
  assert.equal(serviceName('sample'), 'app-sample.service');
  assert.equal(machinePaths().unitFile('sample'), '/etc/systemd/system/app-sample.service');
});

test('every path is under the root it was given', () => {
  const root = '/tmp/a-machine';
  for (const [name, value] of Object.entries(machinePaths(root))) {
    const at = typeof value === 'function' ? value('sample') : value;
    assert.ok(at === root || at.startsWith(root + path.sep), `${name} is ${at}`);
  }
});

test('the setup script states each directory it makes as paths.mjs has it', () => {
  const setup = fs.readFileSync(path.join(import.meta.dirname, '../vm/apps-machine-setup.sh'), 'utf8');
  const paths = machinePaths();
  const stated = { CONFIG_DIR: paths.configDir, STATE_DIR: paths.stateDir, BACKUP_DIR: paths.backupDir, BACKUP_KEY_FILE: paths.backupPublicKey };
  for (const [variable, expected] of Object.entries(stated)) {
    const line = new RegExp(`^${variable}=(\\S+)$`, 'm').exec(setup);
    assert.ok(line, `the setup script sets no ${variable}`);
    assert.equal(line[1], expected, variable);
  }
});

test('the backups\' public key is in root\'s directory, and the nightly bundles and a run\'s work in the backup directory', () => {
  const paths = machinePaths();
  assert.equal(paths.backupPublicKey, '/etc/apps-machine/backup-public-key');
  assert.equal(paths.nightlyDir, '/var/lib/apps-machine/backups/nightly');
  assert.equal(paths.backupWorkDir, '/var/lib/apps-machine/backups/work');
});

test('what a restore replaced is kept in the backup directory, apart from the nightly bundles and a run\'s work', () => {
  assert.equal(machinePaths().restoreDumps('sample'), '/var/lib/apps-machine/backups/restores/sample');
});
