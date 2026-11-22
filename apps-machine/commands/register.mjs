import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

import { createAppUser, linuxNameTaken } from '../app-user.mjs';
import { createDatabase, databaseNameTaken, setDatabasePassword } from '../database.mjs';
import { checkRegistration, readRegistry, writeRegistration } from '../registry.mjs';
import { installService } from '../service.mjs';
import { writeSettings } from '../settings.mjs';
import { UsageError } from '../usage.mjs';

export const usage = 'apps-machine register <name> <repository> <serve-port>';
export const summary = 'give an app its user, database, settings file, deploy key and service, ready for a first deploy';

/** Every step makes only what is missing, so the command finishes a registration that stopped part-way. */
export function command(args, world) {
  if (args.length !== 3) throw new UsageError();
  const { paths, out } = world;
  const [name, repository, port] = args;
  const wanted = checkRegistration(paths, { name, repository, servePort: /^\d+$/.test(port) ? Number(port) : NaN });
  const existing = readRegistry(paths).find((app) => app.name === name);
  if (!existing) {
    if (linuxNameTaken(world, name)) throw new Error(`this machine already has a Linux user or group named ${name}, which is not an app's`);
    if (databaseNameTaken(world, name)) throw new Error(`Postgres already has a role or a database named ${name}, which is not an app's`);
  } else if (existing.repository !== wanted.repository || existing.servePort !== wanted.servePort) {
    throw new Error(`${name} is already registered, with ${existing.repository} on Serve port ${existing.servePort}: see ${paths.registration(name)}`);
  }
  writeRegistration(paths, wanted);
  createAppUser(world, name);
  createDatabase(world, name);
  if (!fs.existsSync(paths.settingsFile(name))) writeSettings(paths, name, newSettings(world, name));
  const publicKey = deployKey(world, name);
  installService(world, name);
  out.write([
    `${name} is registered: ${repository}, Serve port ${wanted.servePort}.`,
    '',
    'The public half of its deploy key:',
    '',
    `  ${publicKey}`,
    '',
    'Left to do:',
    `  1. On GitHub, add that key to ${repository.slice('git@github.com:'.length, -'.git'.length)} under Settings, Deploy keys, without write access.`,
    `  2. Add the app's other settings to its settings file, which has its DATABASE_URL: sudoedit ${paths.settingsFile(name)}`,
    `  3. Deploy it: sudo apps-machine deploy ${name}`,
    `     The deploy maps Serve port ${wanted.servePort} to the port in the project's deploy section.`,
    '',
  ].join('\n'));
}

function newSettings(world, name) {
  const url = setDatabasePassword(world, name, randomBytes(24).toString('hex'));
  return [
    `# The settings of ${name}. Its service and each step of a deploy get these in their environment;`,
    '# its user cannot read this file. One NAME=value to a line, the value in quotes if it holds a',
    '# quote, a backslash or more than one line.',
    `DATABASE_URL=${url}`,
    '',
  ].join('\n');
}

/** Returns the public half. The private half is made by ssh-keygen and read by nothing here. */
function deployKey({ run, paths }, name) {
  const key = paths.deployKey(name);
  if (!fs.existsSync(key)) {
    fs.mkdirSync(paths.keysDir, { recursive: true });
    fs.chmodSync(paths.keysDir, 0o700);
    const done = run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `apps-machine: ${name}`, '-f', key]);
    if (done.code !== 0) throw new Error(`could not make ${name}'s deploy key: ${done.stderr.trim()}`);
  }
  fs.chmodSync(key, 0o600);
  return fs.readFileSync(`${key}.pub`, 'utf8').trim();
}
