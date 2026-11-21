#!/usr/bin/env node
// Whether a project is ready for the code reviewer's nightly summaries: discussions turned on,
// and the code reviewer's category there. Asked as the owner's `gh` login, so it says what the
// owner can see, not what the App has been granted. Read-only: a category can only be created in
// the repository's settings, so a missing one is the owner's to create.
//
//   node discussions.mjs <owner/repo>
//
// Prints `ready` (exit 0), or what the owner must create (exit 1). Exit 2 when gh failed or on bad
// arguments.

import { discussionCategory, findDiscussionCategory, missingDiscussionCategory } from '../discussion-category.mjs';
import { gh as realGh, isMain, repoSlug } from './gh.mjs';

// A repository holds at most 25 categories.
const QUERY =
  'query($o:String!,$r:String!){ repository(owner:$o,name:$r){ hasDiscussionsEnabled discussionCategories(first:100){ nodes { name } } } }';

/** `{ enabled, categories }` for `project` (`owner/name`), as the `gh` login sees it. */
export function discussionSetup(project, gh = realGh) {
  const [owner, name] = project.split('/');
  const run = gh(['api', 'graphql', '-f', `query=${QUERY}`, '-f', `o=${owner}`, '-f', `r=${name}`]);
  if (run.code !== 0) throw new Error(`could not read the discussions of ${project}: ${run.stderr.trim()}`);
  let repository;
  try {
    repository = JSON.parse(run.stdout).data.repository;
  } catch {
    repository = null;
  }
  if (!repository) throw new Error(`could not read the discussions of ${project}: GitHub's answer names no such repository`);
  return { enabled: repository.hasDiscussionsEnabled, categories: repository.discussionCategories.nodes };
}

/** The CLI. Returns the exit code. */
export function main(argv, { gh = realGh, env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const project = argv.length === 1 ? repoSlug(argv[0]) : null;
  if (!project) {
    err.write('usage: node discussions.mjs <owner/repo>\n');
    return 2;
  }
  const category = discussionCategory(env);
  let setup;
  try {
    setup = discussionSetup(project, gh);
  } catch (e) {
    err.write(`${e.message}\n`);
    return 2;
  }
  if (findDiscussionCategory(setup, category)) {
    out.write('ready\n');
    return 0;
  }
  out.write(`${missingDiscussionCategory(project, category, setup.enabled)}\n`);
  return 1;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
