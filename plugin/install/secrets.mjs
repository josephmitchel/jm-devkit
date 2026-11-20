#!/usr/bin/env node
// Sets the repository secrets a project lacks from the secrets file on this machine. A secret the
// repository already has is left alone. Each value goes to `gh secret set` on stdin: it is never
// an argument, never printed and never logged.
//
// Install no longer runs this: the code reviewer runs on the owner's machine and a project there
// needs no repository secrets. It stays for a project still on GitHub Actions, whose workflow
// reads the four, until the last one has moved.
//
//   node secrets.mjs <owner/repo> [--dry-run]
//
// Prints `set NAME` for each secret it sets (or, with --dry-run, would set); nothing when the
// repository has all four. Exit 0 done, 1 gh failed, 2 the secrets file is missing or incomplete,
// or bad arguments.

import { gh as realGh, isMain, repoSlug } from './gh.mjs';
import { SECRET_NAMES, SecretsFileError, configDir, readSecrets } from './secrets-file.mjs';

/** The names of the repository's secrets. */
export function repoSecrets(repo, gh = realGh) {
  const run = gh(['secret', 'list', '-R', repo, '--json', 'name']);
  if (run.code !== 0) throw new Error(`could not list the secrets of ${repo}: ${run.stderr.trim()}`);
  return JSON.parse(run.stdout).map((s) => s.name);
}

/** The secrets `repo` lacks, in plan order. */
export function missingSecrets(repo, gh = realGh) {
  const have = new Set(repoSecrets(repo, gh));
  return SECRET_NAMES.filter((n) => !have.has(n));
}

function scrub(text, values) {
  let out = text;
  for (const value of values) {
    for (const piece of [value, value.trim()]) if (piece.length >= 4) out = out.replaceAll(piece, '[redacted]');
  }
  return out;
}

/** The CLI. Returns the exit code. */
export function main(argv, { gh = realGh, env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const dryRun = argv.includes('--dry-run');
  const rest = argv.filter((a) => a !== '--dry-run');
  const repo = rest.length === 1 ? repoSlug(rest[0]) : null;
  if (!repo) {
    err.write('usage: node secrets.mjs <owner/repo> [--dry-run]\n');
    return 2;
  }

  let missing;
  try {
    missing = missingSecrets(repo, gh);
  } catch (e) {
    err.write(`${e.message}\n`);
    return 1;
  }
  if (missing.length === 0) return 0;

  let values;
  try {
    values = readSecrets(missing, configDir(env));
  } catch (e) {
    if (!(e instanceof SecretsFileError)) throw e;
    err.write(`cannot set ${missing.join(', ')} on ${repo}:\n${e.problems.map((p) => `  ${p}\n`).join('')}`);
    return 2;
  }

  if (dryRun) {
    for (const name of missing) out.write(`set ${name}\n`);
    return 0;
  }
  for (const name of missing) {
    const run = gh(['secret', 'set', name, '-R', repo, '--app', 'actions'], { input: values[name] });
    if (run.code !== 0) {
      err.write(`could not set ${name} on ${repo}: ${scrub(run.stderr, Object.values(values)).trim()}\n`);
      return 1;
    }
    out.write(`set ${name}\n`);
  }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
