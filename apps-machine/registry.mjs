// The apps registered on the machine: one JSON file per app, `<name>.json` in `paths.appsDir`,
// holding `{ name, repository, servePort }`.

import fs from 'node:fs';

import { UsageError } from './usage.mjs';

const NAME = /^(?!pg_)[a-z][a-z0-9_]{0,30}$/;
const REPOSITORY = /^git@github\.com:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.git$/;

/** Every registration, by name. A machine with none, or never registered on, has `[]`. */
export function readRegistry(paths) {
  let files;
  try {
    files = fs.readdirSync(paths.appsDir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return files
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => file.slice(0, -'.json'.length))
    .map((name) => readRegistration(paths, name));
}

/** The registration of the app named `name`. Throws when there is none. */
export function registrationOf(paths, name) {
  const found = NAME.test(name) && fs.existsSync(paths.registration(name));
  if (!found) throw new Error(`no app named ${name} is registered on this machine`);
  return readRegistration(paths, name);
}

/**
 * The registration these fields make, written nowhere. Throws a UsageError for a name, repository
 * or port that cannot be one, and an Error for a port another app has.
 */
export function checkRegistration(paths, { name, repository, servePort }) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new UsageError('an app\'s name is a lowercase letter, then lowercase letters, digits or underscores, 31 characters at most and not starting pg_: it names a Linux user and a database');
  }
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) {
    throw new UsageError('a repository is given by its GitHub SSH address: git@github.com:<owner>/<name>.git');
  }
  if (!Number.isInteger(servePort) || servePort < 1 || servePort > 65535) {
    throw new UsageError('a Serve port is a whole number from 1 to 65535');
  }
  const holder = readRegistry(paths).find((other) => other.servePort === servePort && other.name !== name);
  if (holder) throw new Error(`Serve port ${servePort} is already ${holder.name}'s`);
  return { name, repository, servePort };
}

/** Register an app, or leave its registration as it is when nothing differs. Returns what is registered. Throws as `checkRegistration` does. */
export function writeRegistration(paths, fields) {
  const registration = checkRegistration(paths, fields);
  const text = `${JSON.stringify(registration, null, 2)}\n`;
  const file = paths.registration(registration.name);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return registration;
  fs.mkdirSync(paths.appsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.appsDir, 0o700);
  fs.writeFileSync(`${file}.new`, text, { mode: 0o600 });
  fs.renameSync(`${file}.new`, file);
  return registration;
}

function readRegistration(paths, name) {
  const file = paths.registration(name);
  let registration;
  try {
    registration = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not a registration: ${e.message}`);
  }
  if (registration?.name !== name) throw new Error(`${file} is not the registration of an app named ${name}`);
  return registration;
}
