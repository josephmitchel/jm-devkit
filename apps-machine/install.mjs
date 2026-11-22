#!/usr/bin/env node
// Copies the commands, and the kit files they import, from this checkout into a directory of
// root's. The setup script runs it; root's commands then run from the copy, never the checkout.
//
//   node install.mjs <absolute directory>
//
// Exit 0 done, 2 bad arguments.

import fs from 'node:fs';
import path from 'node:path';

import { isMain } from './is-main.mjs';

const HOME = 'apps-machine';

/** Files outside the home that the commands import. The copy keeps the kit's layout, so the same relative imports work. */
export const KIT_FILES = ['plugin/devkit-config.mjs', 'plugin/devkit.schema.json'];

/** The entry point, within the copy. */
export const ENTRY = `${HOME}/apps-machine.mjs`;

const isCommandModule = (file) => file.endsWith('.mjs') && !file.endsWith('.test.mjs') && path.basename(file) !== 'test-helpers.mjs';

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).filter((file) => fs.statSync(path.join(dir, file)).isFile());
}

function wanted(kitDir) {
  const modules = filesUnder(path.join(kitDir, HOME)).filter(isCommandModule).map((file) => path.join(HOME, file));
  return new Map([...modules, ...KIT_FILES].sort().map((file) => [file, {
    content: fs.readFileSync(path.join(kitDir, file)),
    mode: file === ENTRY ? 0o755 : 0o644,
  }]));
}

function isInstalled(files, destDir) {
  const present = filesUnder(destDir).sort();
  if (present.length !== files.size || present.some((file) => !files.has(file))) return false;
  const dirs = new Set(['.', ...present.flatMap(parents)]);
  return present.every((file) => {
    const { content, mode } = files.get(file);
    return hasMode(path.join(destDir, file), mode) && content.equals(fs.readFileSync(path.join(destDir, file)));
  }) && [...dirs].every((dir) => hasMode(path.join(destDir, dir), 0o755));
}

function parents(file) {
  const dir = path.dirname(file);
  return dir === '.' ? [] : [dir, ...parents(dir)];
}

const hasMode = (file, mode) => (fs.statSync(file).mode & 0o777) === mode;

/** Make `destDir` hold exactly what the kit at `kitDir` installs. Returns 'installed' or 'unchanged'. */
export function install({ kitDir = path.resolve(import.meta.dirname, '..'), destDir }) {
  const files = wanted(kitDir);
  if (isInstalled(files, destDir)) return 'unchanged';
  const next = `${destDir}.new`;
  const previous = `${destDir}.old`;
  fs.rmSync(next, { recursive: true, force: true });
  fs.rmSync(previous, { recursive: true, force: true });
  fs.mkdirSync(next, { recursive: true });
  for (const [file, { content, mode }] of files) {
    fs.mkdirSync(path.dirname(path.join(next, file)), { recursive: true });
    fs.writeFileSync(path.join(next, file), content);
    fs.chmodSync(path.join(next, file), mode);
    for (const dir of ['.', ...parents(file)]) fs.chmodSync(path.join(next, dir), 0o755);
  }
  if (fs.existsSync(destDir)) fs.renameSync(destDir, previous);
  fs.renameSync(next, destDir);
  fs.rmSync(previous, { recursive: true, force: true });
  return 'installed';
}

/** The CLI. Returns the exit code. */
export function main(argv, { out = process.stdout, err = process.stderr } = {}) {
  if (argv.length !== 1 || !path.isAbsolute(argv[0])) {
    err.write('usage: node install.mjs <absolute directory>\n');
    return 2;
  }
  const [destDir] = argv;
  const done = install({ destDir });
  out.write(done === 'installed' ? `Installed the commands in ${destDir}.\n` : `The commands in ${destDir} are as the kit has them.\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
