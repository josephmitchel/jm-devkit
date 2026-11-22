// Every path the commands use on the machine. A command takes its paths from here, never a literal.

import path from 'node:path';

/** The systemd unit of an app's service. The prefix keeps an app's name from being a unit the machine already has. */
export const serviceName = (app) => `app-${app}.service`;

/** The machine's paths under `root`: `/` on a real machine, a temp dir in tests. */
export function machinePaths(root = '/') {
  const configDir = path.join(root, 'etc/apps-machine');
  const appsDir = path.join(configDir, 'apps');
  const settingsDir = path.join(configDir, 'settings');
  const keysDir = path.join(configDir, 'keys');
  const stateDir = path.join(root, 'var/lib/apps-machine');
  const backupDir = path.join(stateDir, 'backups');
  const appDir = (app) => path.join(stateDir, 'apps', app);
  return {
    root,
    /** Root's alone, mode 0700: made by the setup script. */
    configDir,
    appsDir,
    /** An app's registration. */
    registration: (app) => path.join(appsDir, `${app}.json`),
    settingsDir,
    /** An app's settings, root's alone: `NAME=value` lines, read by systemd and by `readSettings`. */
    settingsFile: (app) => path.join(settingsDir, `${app}.env`),
    keysDir,
    /** The private half of an app's deploy key. The public half is beside it, ending `.pub`. */
    deployKey: (app) => path.join(keysDir, app),
    /** Readable by all, written by root: made by the setup script. */
    stateDir,
    /** Root's alone, mode 0700: made by the setup script. Dumps and bundles go here. */
    backupDir,
    /** Root's, and readable by the app's group alone. */
    appDir,
    /** The home of the app's Linux user, and the one place under `appDir` it owns outside its releases. */
    appHome: (app) => path.join(appDir(app), 'home'),
    releasesDir: (app) => path.join(appDir(app), 'releases'),
    /** A link to the release the service runs, missing until the first deploy. */
    currentRelease: (app) => path.join(appDir(app), 'current'),
    /** The start command of the current release, which the service runs with `sh`. */
    startFile: (app) => path.join(appDir(app), 'start'),
    unitFile: (app) => path.join(root, 'etc/systemd/system', serviceName(app)),
    /** The owner's public key for backups, in a file `age` reads recipients from. The private half is never on the machine. */
    backupPublicKey: path.join(configDir, 'backup-public-key'),
    /** The nights' encrypted bundles, root's alone. */
    nightlyDir: path.join(backupDir, 'nightly'),
    /** Where a backup run or a restore works: a directory per run, removed when the run ends. */
    backupWorkDir: path.join(backupDir, 'work'),
    /** The dumps a deploy takes of an app's database before it changes anything, one file per deploy. */
    deployDumps: (app) => path.join(backupDir, 'deploys', app),
    /** Root's checkout of the commit being deployed, until it becomes a release. */
    incomingRelease: (app) => path.join(appDir(app), 'incoming'),
    /** The host keys root's ssh accepts from GitHub, written by a deploy before it fetches. */
    githubHostKeys: path.join(configDir, 'github-host-keys'),
    /** Where the bundles are uploaded: one line, an rclone remote and a folder in it, `<remote>:<folder>`. */
    backupStorage: path.join(configDir, 'backup-storage'),
    /** The rclone config that defines that remote. It holds the storage credential, so it is root's alone. */
    rcloneConfig: path.join(configDir, 'rclone.conf'),
    /** The address requested when a night's bundles have all uploaded: one line, root's alone. */
    backupAliveAddress: path.join(configDir, 'backup-alive-address'),
    /** What a restore replaced, kept so it can be undone: an app's database dump, and its settings file when that was replaced too. */
    restoreDumps: (app) => path.join(backupDir, 'restores', app),
  };
}
