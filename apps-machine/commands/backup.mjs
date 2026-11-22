import fs from 'node:fs';
import path from 'node:path';

import { makeBundle, parseBundleName, publicKeyIsSet } from '../bundle.mjs';
import { readRegistry } from '../registry.mjs';
import { expiredOnMachine } from '../retention.mjs';
import { UsageError } from '../usage.mjs';

export const usage = 'apps-machine backup';
export const summary = 'bundle every app\'s database and settings file for the night, encrypted to the owner\'s public key';

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
  fs.mkdirSync(paths.backupWorkDir, { recursive: true, mode: 0o700 });
  const workDir = fs.mkdtempSync(path.join(paths.backupWorkDir, `${process.pid}-`));
  try {
    for (const { name: app } of readRegistry(paths)) {
      try {
        const file = makeBundle(world, { app, date: night.date, workDir });
        night.bundles.push({ app, date: night.date, name: path.basename(file), file });
        out.write(`${app}: ${file}\n`);
      } catch (e) {
        night.failed.push({ app, reason: e.message });
        err.write(`${app}: ${e.message}\n`);
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  for (const { app, name } of removeExpired(paths, night)) out.write(`${app}: removed ${name}, older than seven days\n`);
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

export function command(args, world) {
  if (args.length > 0) throw new UsageError();
  const night = bundleEveryApp(world);
  if (night.failed.length > 0) throw new Error(`no bundle was made for ${night.failed.map((failure) => failure.app).join(', ')}`);
}
