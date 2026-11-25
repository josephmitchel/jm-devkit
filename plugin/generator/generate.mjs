#!/usr/bin/env node
// Turns a project's devkit.json into every kit-owned file, and removes the ones the kit has
// retired. Nothing else writes or removes a kit-owned file. See README.md beside this file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_FILE, DevkitConfigError, checkDevkitConfig, parseDevkitConfig } from '../devkit-config.mjs';

export const SWEEP_WORKFLOW = '.github/workflows/nightly-sweep.yml';

/**
 * The kit-owned files the kit no longer writes, each with what removing it from a project does.
 * A project that still has one is behind, and writing removes it.
 */
export const RETIRED = {
  [SWEEP_WORKFLOW]: "removing it lets the code reviewer on the development machine handle the project, which it leaves alone while the file is there",
};

/** Every kit-owned file for `config`, as `{ path: contents }` with paths relative to the project root. */
export function generate(config) {
  checkDevkitConfig(config);
  return {};
}

/** Read and validate `<projectDir>/devkit.json`. */
export function readConfig(projectDir) {
  const file = path.join(projectDir, CONFIG_FILE);
  if (!fs.existsSync(file)) throw new DevkitConfigError(`no ${CONFIG_FILE} in ${projectDir}`);
  return parseDevkitConfig(fs.readFileSync(file, 'utf8'));
}

/** The kit-owned files under `projectDir` that are missing or differ from `files`. */
export function drifted(projectDir, files) {
  return Object.entries(files)
    .filter(([relative, contents]) => {
      const file = path.join(projectDir, relative);
      return !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== contents;
    })
    .map(([relative]) => relative);
}

/** The retired kit-owned files `projectDir` still has. */
export function retiredFiles(projectDir) {
  return Object.keys(RETIRED).filter((relative) => fs.existsSync(path.join(projectDir, relative)));
}

const USAGE = 'usage: node generate.mjs <projectDir> [--check]';

/** The CLI. Returns the exit code: 0 done or level, 1 behind (with --check), 2 could not generate. */
export function main(argv, out = process.stdout, err = process.stderr) {
  const check = argv.includes('--check');
  const rest = argv.filter((a) => a !== '--check');
  if (rest.length !== 1 || rest[0].startsWith('-')) {
    err.write(`${USAGE}\n`);
    return 2;
  }
  const projectDir = rest[0];

  let files;
  try {
    files = generate(readConfig(projectDir));
  } catch (e) {
    if (!(e instanceof DevkitConfigError)) throw e;
    if (e.errors.length === 0) err.write(`${e.message}\n`);
    else err.write(`${CONFIG_FILE} is malformed:\n${e.errors.map((m) => `  ${m}\n`).join('')}`);
    return 2;
  }

  const behind = drifted(projectDir, files);
  const retired = retiredFiles(projectDir);
  if (check) {
    for (const relative of [...behind, ...retired]) out.write(`${relative}\n`);
    for (const relative of retired) err.write(`${relative} is retired: ${RETIRED[relative]}\n`);
    const count = behind.length + retired.length;
    if (count > 0) err.write(`${count} kit-owned file(s) are behind the kit\n`);
    return count > 0 ? 1 : 0;
  }
  for (const relative of behind) {
    const file = path.join(projectDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, files[relative]);
    out.write(`wrote ${relative}\n`);
  }
  for (const relative of retired) {
    fs.rmSync(path.join(projectDir, relative));
    out.write(`removed ${relative}\n`);
  }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
