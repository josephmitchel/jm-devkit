// An app's settings: a file of `NAME=value` lines that only root can read. The app's service gets
// the values from systemd (`EnvironmentFile=`); a command gets them from `readSettings`, and hands
// them to a program it runs as the app's user with `runAsApp`. The app's user never reads the file.

import fs from 'node:fs';

// What systemd gives a service.
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin';

// One line, or one quoted value over several: the part of systemd's environment-file syntax that
// reads one way only. A value is bare, in single quotes (kept as it is), or in double quotes
// (where a backslash goes before a double quote, a backslash, a dollar sign or a backquote).
// A comment holds no backslash: some versions of systemd run it on over the next line.
const LINE = /[ \t]*(?:[#;][^\n\\]*|([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:'([^']*)'|"((?:[^"\\]|\\["\\$`])*)"|([^'"\\\n]*))[ \t\r]*)?(?:\n|$)/y;

/** Write an app's settings file, root's alone. */
export function writeSettings(paths, app, text) {
  const file = paths.settingsFile(app);
  fs.mkdirSync(paths.settingsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.settingsDir, 0o700);
  fs.writeFileSync(`${file}.new`, text, { mode: 0o600 });
  fs.renameSync(`${file}.new`, file);
}

/** An app's settings file as it is, byte for byte. */
export function readSettingsFile(paths, app) {
  const file = paths.settingsFile(app);
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`${app} has no settings file: ${file} is missing`);
    throw e;
  }
}

/** An app's settings as an environment object. Throws, without quoting the file, when a line is not a setting. */
export function readSettings(paths, app) {
  const file = paths.settingsFile(app);
  const text = readSettingsFile(paths, app).toString('utf8');
  const settings = {};
  LINE.lastIndex = 0;
  while (LINE.lastIndex < text.length) {
    const at = LINE.lastIndex;
    const line = LINE.exec(text);
    if (!line) {
      const number = text.slice(0, at).split('\n').length;
      throw new Error(`line ${number} of ${file} is not a setting: write NAME=value, with the value in quotes if it holds a quote or a backslash`);
    }
    const [, name, single, double, bare] = line;
    if (name) settings[name] = single ?? double?.replace(/\\(["\\$`])/g, '$1') ?? bare.trimEnd();
  }
  return settings;
}

/**
 * Run a shell command as the app's user, with the app's settings in its environment and nothing of
 * root's. Returns what `run` returns. `cwd` and `live` are `run`'s.
 */
export function runAsApp({ run, paths }, app, command, { cwd, live = false } = {}) {
  const env = { HOME: paths.appHome(app), USER: app, LOGNAME: app, PATH: SYSTEM_PATH, ...readSettings(paths, app) };
  return run('runuser', ['-u', app, '--', '/bin/sh', '-c', command], { env, cwd, live });
}
