import fs from 'node:fs';
import path from 'node:path';

import { isBundle, openBundle } from '../bundle.mjs';
import { databasePassword, dumpDatabase, dumpFault, restoreDatabase, setDatabasePassword } from '../database.mjs';
import { HEALTH_TIME_LIMIT_SECONDS, answersHealthy } from '../health.mjs';
import { serviceName } from '../paths.mjs';
import { registrationOf } from '../registry.mjs';
import { deployConfigOf, stampOf } from '../releases.mjs';
import { servicePointsAt, startService, stopService } from '../service.mjs';
import { readSettings, writeSettings } from '../settings.mjs';
import { UsageError } from '../usage.mjs';

export const usage = 'apps-machine restore <name> <file> [--settings]';
export const summary = 'put an app\'s database back from a decrypted bundle or from the dump a deploy took, and with --settings the bundle\'s settings file too';

const ENCRYPTED = 'age-encryption.org/v1';

/** A decrypted bundle is removed however the restore ends. A dump is not: it is root's alone already, and still the way back. */
export function command(args, world) {
  const options = args.filter((arg) => arg.startsWith('-'));
  const [name, given, ...others] = args.filter((arg) => !arg.startsWith('-'));
  if (given === undefined || others.length > 0 || options.some((option) => option !== '--settings')) throw new UsageError();
  const file = fileAt(given);
  const bundled = isBundle(world, file);
  try {
    restore(world, { name, file, bundled, withSettings: options.length > 0 });
  } finally {
    if (bundled) {
      fs.rmSync(file, { force: true });
      world.out.write(`Removed the decrypted bundle ${file}\n`);
    }
  }
}

function fileAt(given) {
  try {
    const file = fs.realpathSync(given);
    if (fs.statSync(file).isFile()) return file;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  throw new Error(`${path.resolve(given)} is not a file`);
}

function startsWith(file, text) {
  const start = Buffer.alloc(text.length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, start);
  } finally {
    fs.closeSync(fd);
  }
  return start.toString('latin1') === text;
}

/** Everything that can refuse comes before the service is stopped; from the stop on, a failure leaves it stopped and says how to go back. */
function restore(world, { name, file, bundled, withSettings }) {
  const { paths, out, err, now } = world;
  registrationOf(paths, name);
  const workDir = bundled ? newWorkDir(paths) : null;
  try {
    const source = bundled ? openBundle(world, file, workDir) : { dump: file };
    if (bundled && source.app !== name) throw new Error(`${file} is a bundle of ${source.app}, not of ${name}`);
    if (!bundled && startsWith(file, ENCRYPTED)) throw new Error(`${file} is still encrypted: decrypt it on the device that holds the private key, and bring what that gives`);
    const fault = dumpFault(world, source.dump);
    if (fault) throw new Error(bundled ? `the dump in ${file} cannot be restored: ${fault}` : `${file} is neither a decrypted bundle nor a database dump: ${fault}`);
    if (!bundled && withSettings) throw new Error(`${file} is a dump, which holds no settings file: leave out --settings`);
    const running = servicePointsAt(paths, name);
    const answers = running && deploySectionOf(name, running.release);

    const kept = newKeptName(paths.restoreDumps(name), stampOf(now()));
    const before = { dump: `${kept}.dump`, settings: null };
    dumpDatabase(world, name, before.dump);
    out.write(`Dumped ${name}'s database as it is now to ${before.dump}\n`);

    let step = 'stop';
    try {
      out.write(`Stopping ${serviceName(name)}\n`);
      stopService(world, name);
      step = 'database';
      out.write(`Restoring ${name}'s database from ${bundled ? `the bundle of ${source.date}` : file}\n`);
      restoreDatabase(world, name, source.dump);
      step = 'settings';
      if (withSettings) {
        before.settings = keptSettings(paths, name, `${kept}.env`);
        putSettingsBack(world, name, source.settings);
      } else if (bundled) out.write(`Left ${name}'s settings file as it is\n`);
      if (answers) {
        step = 'start';
        out.write(`Starting ${serviceName(name)}\n`);
        startService(world, name);
        step = 'health';
        const { port, healthPath } = answers;
        out.write(`Asking ${healthPath} on port ${port}, for ${HEALTH_TIME_LIMIT_SECONDS} seconds at most\n`);
        if (!answersHealthy(world, answers)) throw new Error(`${healthPath} on port ${port} did not answer with success within ${HEALTH_TIME_LIMIT_SECONDS} seconds`);
      }
    } catch (e) {
      err.write([
        `${serviceName(name)} ${stoppedAgain(world, name) ? 'is stopped.' : `could not be stopped: see systemctl status ${serviceName(name)}`}`,
        ...wayBack(name, before),
        '',
      ].join('\n'));
      throw new Error(`the restore of ${name} stopped at ${step}: ${e.message}`);
    }
    out.write([
      answers ? `${name} is restored and answering.` : `${name} is restored. It has never been deployed, so nothing was started: its first deploy starts it.`,
      ...wayBack(name, before),
      '',
    ].join('\n'));
  } finally {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** A name in `dir` no earlier restore has used, so a dump kept there is never written over: least of all the one being restored. */
function newKeptName(dir, stamp) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let name = stamp;
  for (let n = 2; fs.existsSync(path.join(dir, `${name}.dump`)); n += 1) name = `${stamp}-${n}`;
  return path.join(dir, name);
}

/** The deploy section the running release was deployed with, which says where the app answers. */
function deploySectionOf(name, release) {
  try {
    return deployConfigOf(release);
  } catch (e) {
    throw new Error(`cannot tell where ${name} answers: ${e.message}`);
  }
}

function wayBack(name, before) {
  return [
    `${name}'s database as it was before this restore is in ${before.dump}. To put it back:`,
    `  sudo apps-machine restore ${name} ${before.dump}`,
    ...(before.settings ? [`Its settings file as it was is in ${before.settings}`] : []),
  ];
}

function stoppedAgain(world, name) {
  try {
    stopService(world, name);
    return true;
  } catch {
    return false;
  }
}

/** A directory for the bundle's files, named as a backup run's is, so the next backup removes what a killed restore left. */
function newWorkDir(paths) {
  fs.mkdirSync(paths.backupWorkDir, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(paths.backupWorkDir, `${process.pid}-`));
}

/** Copy the app's settings file as it is to `keep`, root's alone. Returns `keep`, or null when the app has no settings file. */
function keptSettings(paths, name, keep) {
  if (!fs.existsSync(paths.settingsFile(name))) return null;
  fs.writeFileSync(keep, fs.readFileSync(paths.settingsFile(name)), { mode: 0o600 });
  return keep;
}

/**
 * Replace the app's settings file with the bundle's, byte for byte. On a machine built again the
 * app's role has a new password, so the role is given the one the file put back names.
 */
function putSettingsBack(world, name, from) {
  const { paths, out, err } = world;
  writeSettings(paths, name, fs.readFileSync(from));
  out.write(`Put ${name}'s settings file back from the bundle\n`);
  const password = passwordIn(paths, name);
  if (password) setDatabasePassword(world, name, password);
  else err.write(`warning: the settings file put back does not hold DATABASE_URL as register writes it, so ${name}'s database password is as it was. If ${name} cannot open its database, correct DATABASE_URL in ${paths.settingsFile(name)}\n`);
}

function passwordIn(paths, name) {
  try {
    return databasePassword(readSettings(paths, name).DATABASE_URL, name);
  } catch {
    return null;
  }
}
