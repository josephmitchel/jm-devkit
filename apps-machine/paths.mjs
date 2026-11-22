// Every path the commands use on the machine. A command takes its paths from here, never a literal.

import path from 'node:path';

/** The machine's paths under `root`: `/` on a real machine, a temp dir in tests. */
export function machinePaths(root = '/') {
  const configDir = path.join(root, 'etc/apps-machine');
  const appsDir = path.join(configDir, 'apps');
  return {
    root,
    /** Root's alone, mode 0700: made by the setup script. */
    configDir,
    appsDir,
    /** An app's registration. */
    registration: (app) => path.join(appsDir, `${app}.json`),
  };
}
