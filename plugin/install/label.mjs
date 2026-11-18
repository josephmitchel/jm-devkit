#!/usr/bin/env node
// Creates the `review-now` label when the repository lacks it: the one label nothing else creates.
// The rest of the label scheme is the code reviewer's to create, on its first run.
//
//   node label.mjs <owner/repo> [--dry-run]
//
// Prints `create review-now` when it creates it (or, with --dry-run, would); nothing when the
// repository has it. Exit 0 done, 1 gh failed, 2 bad arguments.

import { gh as realGh, isMain, repoSlug } from './gh.mjs';

/** Outside the scheme: it goes on a pull request. Pale purple, beside the `concern` kind. */
export const REVIEW_NOW = {
  name: 'review-now',
  color: 'd2a8ff',
  description: "Pull request: run the code reviewer's full review on it now",
};

/** Whether `repo` has a label named `name` (GitHub label names are case-insensitive). */
export function hasLabel(repo, name, gh = realGh) {
  const run = gh(['label', 'list', '-R', repo, '--json', 'name', '--limit', '1000']);
  if (run.code !== 0) throw new Error(`could not list the labels of ${repo}: ${run.stderr.trim()}`);
  return JSON.parse(run.stdout).some((l) => l.name.toLowerCase() === name.toLowerCase());
}

/** The CLI. Returns the exit code. */
export function main(argv, { gh = realGh, out = process.stdout, err = process.stderr } = {}) {
  const dryRun = argv.includes('--dry-run');
  const rest = argv.filter((a) => a !== '--dry-run');
  const repo = rest.length === 1 ? repoSlug(rest[0]) : null;
  if (!repo) {
    err.write('usage: node label.mjs <owner/repo> [--dry-run]\n');
    return 2;
  }
  try {
    if (hasLabel(repo, REVIEW_NOW.name, gh)) return 0;
  } catch (e) {
    err.write(`${e.message}\n`);
    return 1;
  }
  if (!dryRun) {
    const { name, color, description } = REVIEW_NOW;
    const run = gh(['label', 'create', name, '-R', repo, '--color', color, '--description', description]);
    if (run.code !== 0) {
      err.write(`could not create ${name} on ${repo}: ${run.stderr.trim()}\n`);
      return 1;
    }
  }
  out.write(`create ${REVIEW_NOW.name}\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
