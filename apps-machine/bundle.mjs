// A backup bundle: one app's database dump and settings file for one date, as a tar archive
// encrypted with `age` to the owner's public key. The machine can make a bundle and cannot decrypt
// one: what it opens is a bundle the owner decrypted on his own device.

import fs from 'node:fs';
import path from 'node:path';

import { dumpDatabase } from './database.mjs';
import { privateDir, valueLines } from './files.mjs';
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

/** Whether the owner's public key is on the machine: its file has a line that is not a comment. Whether that line is a key is `age`'s to say. */
export const publicKeyIsSet = (paths) => valueLines(paths.backupPublicKey).length > 0;

function must(done, what) {
  if (done.code !== 0) throw new Error(`could not ${what}: ${done.stderr.trim()}`);
}

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * A directory of a run's own for a bundle's unencrypted files, root's alone and named for its
 * process, after removing those of runs that were killed before they could. The caller removes it.
 */
export function newWorkDir(paths) {
  privateDir(paths.backupWorkDir);
  for (const name of fs.readdirSync(paths.backupWorkDir)) {
    const owner = /^(\d+)-/.exec(name);
    if (owner && !isRunning(Number(owner[1]))) fs.rmSync(path.join(paths.backupWorkDir, name), { recursive: true, force: true });
  }
  return fs.mkdtempSync(path.join(paths.backupWorkDir, `${process.pid}-`));
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
    privateDir(members);
    fs.writeFileSync(path.join(members, BUNDLE_FILES.settings), readSettingsFile(paths, app), { mode: 0o600 });
    fs.writeFileSync(path.join(members, BUNDLE_FILES.manifest), `${JSON.stringify({ format: BUNDLE_FORMAT, app, date })}\n`, { mode: 0o600 });
    dumpDatabase(world, app, path.join(members, BUNDLE_FILES.dump));
    must(run('tar', ['--create', '--file', archive, '--directory', members, ...Object.values(BUNDLE_FILES)], { cwd: paths.root }), `bundle ${app}'s dump and settings`);
    must(run('age', ['--encrypt', '--recipients-file', paths.backupPublicKey, '--output', sealed, archive], { cwd: paths.root }), `encrypt ${app}'s bundle`);
    fs.chmodSync(sealed, 0o600);
    privateDir(paths.nightlyDir);
    fs.renameSync(sealed, file);
    return file;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Whether `file` is a decrypted bundle, whole or not: a tar archive that holds a bundle's manifest. */
export function isBundle({ run, paths }, file) {
  const listed = run('tar', ['--list', '--force-local', '--file', file], { cwd: paths.root });
  return listed.stdout.split('\n').includes(BUNDLE_FILES.manifest);
}

/**
 * Take a decrypted bundle's files out into `dir`, which is the caller's to remove. Returns
 * `{ app, date, dump, settings }`: the app and date the bundle says it is of, and the two files' paths.
 */
export function openBundle({ run, paths }, file, dir) {
  const names = Object.values(BUNDLE_FILES);
  must(run('tar', ['--extract', '--force-local', '--file', file, '--directory', dir, '--no-same-owner', ...names], { cwd: paths.root }), `open the bundle ${file}`);
  const at = (name) => path.join(dir, name);
  for (const name of names) {
    if (!fs.lstatSync(at(name), { throwIfNoEntry: false })?.isFile()) throw new Error(`${file} is not a bundle: its ${name} is not a file`);
  }
  const manifest = manifestIn(fs.readFileSync(at(BUNDLE_FILES.manifest), 'utf8'));
  if (!manifest) throw new Error(`${file} is not a bundle: its ${BUNDLE_FILES.manifest} does not say which app and date it is of`);
  if (manifest.format !== BUNDLE_FORMAT) throw new Error(`${file} is a bundle of format ${manifest.format}, and these commands read format ${BUNDLE_FORMAT}`);
  return { app: manifest.app, date: manifest.date, dump: at(BUNDLE_FILES.dump), settings: at(BUNDLE_FILES.settings) };
}

function manifestIn(text) {
  try {
    const manifest = JSON.parse(text);
    return typeof manifest?.app === 'string' && typeof manifest.date === 'string' ? manifest : null;
  } catch {
    return null;
  }
}
