// A backup bundle: one app's database dump and settings file for one date, as a tar archive
// encrypted with `age` to the owner's public key. The machine can make a bundle and cannot open one.

import fs from 'node:fs';
import path from 'node:path';

import { dumpDatabase } from './database.mjs';
import { readSettingsFile } from './settings.mjs';

export const BUNDLE_FORMAT = 1;

/**
 * The members of a bundle's archive, all at its top level. The manifest is JSON,
 * `{ format, app, date }`; the dump is pg_dump's custom format; the settings are the file as it was.
 */
export const BUNDLE_FILES = { manifest: 'bundle.json', dump: 'database.dump', settings: 'settings.env' };

const NAME = /^([a-z][a-z0-9_]*)-(\d{4}-\d{2}-\d{2})\.tar\.age$/;

/** The file name of an app's bundle for a date (YYYY-MM-DD). Decrypted, it is the same name without `.age`. */
export const bundleName = (app, date) => `${app}-${date}.tar.age`;

/** `{ name, app, date }` of a bundle's file name, or null when the name is not a bundle's. */
export function parseBundleName(name) {
  const match = NAME.exec(name);
  return match && { name, app: match[1], date: match[2] };
}

/** Whether the owner's public key is on the machine: its file has a line that is not a comment. */
export function publicKeyIsSet(paths) {
  try {
    return fs.readFileSync(paths.backupPublicKey, 'utf8').split('\n').some((line) => /^[^#\s]/.test(line));
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

function must(done, what) {
  if (done.code !== 0) throw new Error(`could not ${what}: ${done.stderr.trim()}`);
}

/**
 * Make an app's bundle for `date` in the machine's nightly directory, root's alone, replacing one of
 * the same date. Everything unencrypted is written under `workDir` and removed before this returns
 * or throws. Returns the bundle's path.
 */
export function makeBundle(world, { app, date, workDir }) {
  const { run, paths } = world;
  const scratch = path.join(workDir, app);
  const members = path.join(scratch, 'members');
  const archive = path.join(scratch, `${app}-${date}.tar`);
  const sealed = path.join(scratch, bundleName(app, date));
  const file = path.join(paths.nightlyDir, bundleName(app, date));
  try {
    fs.mkdirSync(members, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(members, BUNDLE_FILES.settings), readSettingsFile(paths, app), { mode: 0o600 });
    fs.writeFileSync(path.join(members, BUNDLE_FILES.manifest), `${JSON.stringify({ format: BUNDLE_FORMAT, app, date })}\n`, { mode: 0o600 });
    dumpDatabase(world, app, path.join(members, BUNDLE_FILES.dump));
    must(run('tar', ['--create', '--file', archive, '--directory', members, ...Object.values(BUNDLE_FILES)], { cwd: paths.root }), `bundle ${app}'s dump and settings`);
    must(run('age', ['--encrypt', '--recipients-file', paths.backupPublicKey, '--output', sealed, archive], { cwd: paths.root }), `encrypt ${app}'s bundle`);
    fs.chmodSync(sealed, 0o600);
    fs.mkdirSync(paths.nightlyDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(paths.nightlyDir, 0o700);
    fs.renameSync(sealed, file);
    return file;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
