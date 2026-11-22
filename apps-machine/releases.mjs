// An app's releases: one directory per deploy in `paths.releasesDir`, named for when the deploy
// began and the commit it holds, `20261121T143005Z-<commit>`, so names sort oldest first and a
// release's commit is read from its name. A release is a shallow clone of the repository's default
// branch, fetched by root and then handed to the app's user. From then on root runs no git in it,
// and reads the release's deploy section from its own record of it, `<release>.json`, beside the release.

import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE } from '../plugin/devkit-config.mjs';
import { GITHUB_KNOWN_HOSTS } from './github-host-keys.mjs';
import { servicePointsAt } from './service.mjs';

/** How many releases a deploy leaves: the one it made and the two before it. */
export const KEPT_RELEASES = 3;

const RELEASE = /^\d{8}T\d{6}Z-([0-9a-f]{40,64})$/;

/** The time a deploy began, as its release and its dump are named: `20261121T143005Z`. */
export function stampOf(date) {
  return date.toISOString().replace(/[-:]|\.\d+/g, '');
}

/** The commit a release holds. */
export function commitOf(release) {
  const named = RELEASE.exec(path.basename(release));
  if (!named) throw new Error(`${release} is not a release`);
  return named[1];
}

/** An app's release directories, oldest first. */
export function releasesOf(paths, app) {
  const dir = paths.releasesDir(app);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => RELEASE.test(name)).sort().map((name) => path.join(dir, name));
}

function git({ run }, args, env = {}) {
  return run('git', args, { env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env } });
}

/** Root's ssh for a fetch: the app's deploy key and no other, GitHub's published host keys and no other, and never a question. */
function sshCommand(paths, app) {
  fs.writeFileSync(`${paths.githubHostKeys}.new`, GITHUB_KNOWN_HOSTS, { mode: 0o600 });
  fs.renameSync(`${paths.githubHostKeys}.new`, paths.githubHostKeys);
  const options = ['IdentitiesOnly=yes', 'BatchMode=yes', 'StrictHostKeyChecking=yes', `UserKnownHostsFile='${paths.githubHostKeys}'`, 'GlobalKnownHostsFile=/dev/null'];
  return `ssh -F /dev/null -i '${paths.deployKey(app)}' ${options.map((option) => `-o ${option}`).join(' ')}`;
}

/**
 * Fetch the repository's default branch, as the remote has it now, into `paths.incomingRelease`.
 * Returns `{ checkout, commit }`. The checkout is root's: nothing of the app's has run in it.
 */
export function fetchDefaultBranch(world, { name, repository }) {
  const { paths } = world;
  const checkout = paths.incomingRelease(name);
  fs.rmSync(checkout, { recursive: true, force: true });
  const cloned = git(world, ['clone', '--quiet', '--depth', '1', '--no-tags', repository, checkout], { GIT_SSH_COMMAND: sshCommand(paths, name) });
  if (cloned.code !== 0) throw new Error(`could not fetch ${repository}: ${cloned.stderr.trim()}`);
  const head = git(world, ['-C', checkout, 'rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0) throw new Error(`could not read the commit fetched from ${repository}: ${head.stderr.trim()}`);
  return { checkout, commit: head.stdout.trim() };
}

/** The text of the project config in the fetched commit, whatever the checkout's files now hold. Throws when the commit has none. */
export function projectConfigAt(world, { checkout, commit }) {
  const listed = git(world, ['-C', checkout, 'ls-tree', '--name-only', commit, '--', CONFIG_FILE]);
  if (listed.code === 0 && listed.stdout.trim() === '') throw new Error(`the default branch has no ${CONFIG_FILE} at ${commit}`);
  const shown = listed.code === 0 ? git(world, ['-C', checkout, 'show', `${commit}:${CONFIG_FILE}`]) : listed;
  if (shown.code !== 0) throw new Error(`could not read ${CONFIG_FILE} at ${commit}: ${shown.stderr.trim()}`);
  return shown.stdout;
}

const recordOf = (release) => `${release}.json`;

/** The deploy section a release was deployed with, as root recorded it. */
export function deployConfigOf(release) {
  return JSON.parse(fs.readFileSync(recordOf(release), 'utf8'));
}

/**
 * Turn a fetched checkout into the app's newest release, record the deploy section `config` it is
 * deployed with, and hand the release to the app's user. Returns the release directory.
 */
export function makeRelease({ run, paths }, app, { checkout, commit, stamp, config }) {
  const release = path.join(paths.releasesDir(app), `${stamp}-${commit}`);
  commitOf(release);
  fs.writeFileSync(recordOf(release), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(checkout, release);
  const done = run('chown', ['-R', `${app}:${app}`, release]);
  if (done.code !== 0) throw new Error(`could not give ${release} to ${app}: ${done.stderr.trim()}`);
  return release;
}

/** Remove all but the newest `KEPT_RELEASES` of an app's releases, and never the one its service runs. Returns what was removed. */
export function pruneReleases(paths, app) {
  const running = servicePointsAt(paths, app)?.release;
  const old = releasesOf(paths, app).slice(0, -KEPT_RELEASES).filter((release) => release !== running);
  for (const release of old) {
    fs.rmSync(release, { recursive: true, force: true });
    fs.rmSync(recordOf(release), { force: true });
  }
  return old;
}
