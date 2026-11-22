import fs from 'node:fs';
import path from 'node:path';

import { makeBundle, newWorkDir, parseBundleName, publicKeyIsSet } from '../bundle.mjs';
import { keptByDeploys, keptByRestores } from '../kept.mjs';
import { aliveAddressOf, bundlesOnStorage, removeFromStorage, requestAlive, storageOf, uploadBundle } from '../offsite.mjs';
import { readRegistry } from '../registry.mjs';
import { DAYS_KEPT_DUMPS_LAST, DAYS_KEPT_ON_MACHINE, expiredKeptDumps, expiredOnMachine, expiredOnStorage } from '../retention.mjs';
import { Interrupted } from '../run.mjs';
import { UsageError } from '../usage.mjs';

export const usage = 'apps-machine backup';
export const summary = 'bundle every app\'s database and settings file for the night, encrypted to the owner\'s public key, and upload the bundles';

const localDate = (at) => [at.getFullYear(), at.getMonth() + 1, at.getDate()].map((part) => String(part).padStart(2, '0')).join('-');

/**
 * Make the night's bundle of every registered app. Returns `{ date, bundles, failed }`: a bundle is
 * `{ app, date, name, file }`, and a failure `{ app, reason }` for an app whose bundle was not made.
 */
export function bundleEveryApp(world) {
  const { paths, out, err, now } = world;
  if (!publicKeyIsSet(paths)) {
    throw new Error(`no public key is set for the backups, so no bundle can be encrypted: run the setup script with BACKUP_PUBLIC_KEY=<the owner's age public key>, which writes it to ${paths.backupPublicKey}`);
  }
  const night = { date: localDate(now()), bundles: [], failed: [] };
  const apps = readRegistry(paths);
  if (apps.length === 0) {
    out.write('No app is registered: there is nothing to back up.\n');
    return night;
  }
  const workDir = newWorkDir(paths);
  try {
    for (const { name: app } of apps) {
      try {
        const file = makeBundle(world, { app, date: night.date, workDir });
        night.bundles.push({ app, date: night.date, name: path.basename(file), file });
        out.write(`${app}: ${file}\n`);
      } catch (e) {
        if (e instanceof Interrupted) throw e;
        night.failed.push({ app, reason: e.message });
        err.write(`${app}: ${e.message}\n`);
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  for (const { app, name } of removeExpired(paths, night)) out.write(`${app}: removed ${name}, older than ${DAYS_KEPT_ON_MACHINE} days\n`);
  return night;
}

/** An app's old bundles go only once it has tonight's: a backup that keeps failing never eats the last good ones. */
function removeExpired(paths, night) {
  const bundled = new Set(night.bundles.map((bundle) => bundle.app));
  const onMachine = bundled.size === 0 ? [] : fs.readdirSync(paths.nightlyDir).sort().map(parseBundleName).filter((bundle) => bundle && bundled.has(bundle.app));
  const expired = expiredOnMachine(onMachine, night.date);
  for (const { name } of expired) fs.rmSync(path.join(paths.nightlyDir, name));
  return expired;
}

/** Upload each of the night's bundles. Returns the ones now on the storage; one that is not is said on `err`. */
function uploadEach(world, storage, bundles) {
  return bundles.filter((bundle) => {
    try {
      uploadBundle(world, storage, bundle);
      world.out.write(`${bundle.app}: uploaded ${bundle.name}\n`);
      return true;
    } catch (e) {
      if (e instanceof Interrupted) throw e;
      world.err.write(`${bundle.app}: ${e.message}\n`);
      return false;
    }
  });
}

/** As on the machine, an app's old bundles go from the storage only once tonight's is there. */
function pruneStorage(world, storage, uploaded, today) {
  if (uploaded.length === 0) return;
  const apps = new Set(uploaded.map((bundle) => bundle.app));
  const stored = bundlesOnStorage(world, storage).filter((bundle) => apps.has(bundle.app));
  for (const bundle of expiredOnStorage(stored, today)) {
    removeFromStorage(world, storage, bundle);
    world.out.write(`${bundle.app}: removed ${bundle.name} from the storage\n`);
  }
}

/** What the deploys and the restores of every registered app kept goes after its thirty days, whether or not the app has a bundle tonight. */
function removeExpiredKept({ paths, out }, today) {
  for (const { name: app } of readRegistry(paths)) {
    for (const kept of [keptByDeploys(paths, app), keptByRestores(paths, app)]) {
      const dated = kept.map((one) => ({ ...one, date: localDate(one.time) }));
      for (const file of expiredKeptDumps(dated, today).flatMap((one) => one.files)) {
        fs.rmSync(file);
        out.write(`${app}: removed ${file}, older than ${DAYS_KEPT_DUMPS_LAST} days\n`);
      }
    }
  }
}

/** The request whose absence is the alarm: made only by a night in which nothing went wrong. */
function sayAlive(world) {
  const address = aliveAddressOf(world.paths);
  if (address === null) {
    world.err.write(`warning: no alive address is set in ${world.paths.backupAliveAddress}, so nothing is watching whether the backups run\n`);
    return;
  }
  requestAlive(world, address);
  world.out.write('The alive request was made.\n');
}

const appsOf = (list) => list.map(({ app }) => app).join(', ');

export function command(args, world) {
  if (args.length > 0) throw new UsageError();
  const night = bundleEveryApp(world);
  const problems = night.failed.length > 0 ? [`no bundle was made for ${appsOf(night.failed)}`] : [];
  try {
    const storage = storageOf(world.paths);
    const uploaded = uploadEach(world, storage, night.bundles);
    if (uploaded.length < night.bundles.length) problems.push(`no bundle was uploaded for ${appsOf(night.bundles.filter((bundle) => !uploaded.includes(bundle)))}`);
    pruneStorage(world, storage, uploaded, night.date);
  } catch (e) {
    if (e instanceof Interrupted) throw e;
    problems.push(e.message);
  }
  try {
    removeExpiredKept(world, night.date);
  } catch (e) {
    problems.push(e.message);
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
  sayAlive(world);
}
