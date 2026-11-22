// The secrets file on the development machine: the four values every project's repository secrets
// are set from. It lives outside any repository and is readable only by its owner. Nothing here
// prints, logs or returns a value inside an error message.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SECRETS_FILE = 'secrets.env';
export const KEY_FILE = 'reviewer-app-private-key.pem';

/** The repository secrets a project needs, in the order the plan lists them. */
export const SECRET_NAMES = ['DATABASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'REVIEWER_APP_CLIENT_ID', 'REVIEWER_APP_PRIVATE_KEY'];

/** The one secret that comes from its own file instead of a line in secrets.env. */
const FROM_KEY_FILE = 'REVIEWER_APP_PRIVATE_KEY';

/** The secrets file is missing, readable by others, or lacks a value that was asked for. */
export class SecretsFileError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'SecretsFileError';
    this.problems = problems;
  }
}

/** Where the secrets live: `$DEVKIT_CONFIG_DIR`, else `~/.config/jm-devkit`. */
export function configDir(env = process.env) {
  return env.DEVKIT_CONFIG_DIR || path.join(os.homedir(), '.config', 'jm-devkit');
}

/**
 * `NAME=value` lines, split at the first `=`. Blank lines and `#` comments are skipped, an
 * `export ` prefix is allowed, and one pair of matching quotes around a value is removed. A value
 * is taken as written otherwise: it may hold `=`, `&` or spaces.
 */
export function parseEnvFile(text) {
  const values = {};
  const malformed = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (/^\s*(#|$)/.test(line)) return;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      malformed.push(i + 1);
      return;
    }
    let value = match[2];
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    values[match[1]] = value;
  });
  return { values, malformed };
}

function ownerOnly(file, problems) {
  if (process.platform === 'win32') return;
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) {
    problems.push(`${file} is readable by others than its owner (mode ${mode.toString(8)}): run chmod 600 on it`);
  }
}

/**
 * The values of `names`, read from `dir`. Throws SecretsFileError naming every problem at once
 * (a missing file, a file others can read, a name with no value) and never a value.
 */
export function readSecrets(names = SECRET_NAMES, dir = configDir()) {
  const problems = [];
  const values = {};
  const fromEnv = names.filter((n) => n !== FROM_KEY_FILE);

  if (fromEnv.length > 0) {
    const file = path.join(dir, SECRETS_FILE);
    if (!fs.existsSync(file)) {
      problems.push(`${file} is missing: it needs a NAME=value line for ${fromEnv.join(', ')}`);
    } else {
      ownerOnly(file, problems);
      const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
      for (const line of parsed.malformed) problems.push(`${file} line ${line} is not NAME=value`);
      const missing = fromEnv.filter((n) => !parsed.values[n]);
      if (missing.length > 0) problems.push(`${file} has no value for ${missing.join(', ')}`);
      for (const n of fromEnv) if (parsed.values[n]) values[n] = parsed.values[n];
    }
  }

  if (names.includes(FROM_KEY_FILE)) {
    const file = path.join(dir, KEY_FILE);
    if (!fs.existsSync(file)) {
      problems.push(`${file} is missing: it holds the code reviewer's GitHub App private key (${FROM_KEY_FILE})`);
    } else {
      ownerOnly(file, problems);
      const key = fs.readFileSync(file, 'utf8');
      if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key.trimStart())) problems.push(`${file} is not a PEM private key`);
      else values[FROM_KEY_FILE] = key;
    }
  }

  if (problems.length > 0) throw new SecretsFileError(problems);
  return values;
}
