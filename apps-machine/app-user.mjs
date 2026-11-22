// An app's Linux user, named for the app: no shell, no password, no group but its own. What it may
// read is settled by who owns each directory: `ownedDir` makes the ones `register` gives it, and
// `makeRelease` in releases.mjs hands it each release.

import fs from 'node:fs';
import path from 'node:path';

import { must } from './run.mjs';

function userExists({ run }, name) {
  return run('id', ['-u', name]).code === 0;
}

/** Whether the machine already has a Linux user or group of this name. */
export function linuxNameTaken(world, name) {
  return userExists(world, name) || world.run('getent', ['group', name]).code === 0;
}

/** Make `dir` if it is missing, with this mode, owner and group. Its parent must exist. */
export function ownedDir({ run }, dir, { owner, group, mode }) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode });
  fs.chmodSync(dir, mode);
  must(run('chown', [`${owner}:${group}`, dir]), `could not give ${dir} to ${owner}:${group}`);
}

/**
 * Make the app's user if it is missing, and its directories: `appDir` and `releasesDir` are root's
 * and let the app's group in to read, and `appHome` is the app's own. No other app's user gets into any of them.
 */
export function createAppUser(world, app) {
  const { run, paths } = world;
  if (!userExists(world, app)) {
    must(run('useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', paths.appHome(app), '--shell', '/usr/sbin/nologin', app]), `could not make the Linux user ${app}`);
  }
  const allAppsDir = path.dirname(paths.appDir(app));
  fs.mkdirSync(allAppsDir, { recursive: true });
  fs.chmodSync(allAppsDir, 0o755);
  ownedDir(world, paths.appDir(app), { owner: 'root', group: app, mode: 0o750 });
  ownedDir(world, paths.appHome(app), { owner: app, group: app, mode: 0o700 });
  ownedDir(world, paths.releasesDir(app), { owner: 'root', group: app, mode: 0o750 });
}
