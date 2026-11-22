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
    backupDir: path.join(stateDir, 'backups'),
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
    /** The dumps a deploy takes of an app's database before it changes anything, one file per deploy. */
    deployDumps: (app) => path.join(stateDir, 'backups/deploys', app),
    /** Root's checkout of the commit being deployed, until it becomes a release. */
    incomingRelease: (app) => path.join(appDir(app), 'incoming'),
    /** The host keys root's ssh accepts from GitHub, written by a deploy before it fetches. */
    githubHostKeys: path.join(configDir, 'github-host-keys'),
  };
}
