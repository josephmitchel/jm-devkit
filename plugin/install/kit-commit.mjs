#!/usr/bin/env node
// The kit commit the installed plugin was built from, for devkit.json's `kit`.
//
//   node kit-commit.mjs
//
// The plugin declares no version, so Claude Code names its install directory after the kit
// commit it was installed from: `${CLAUDE_PLUGIN_ROOT}` ends in a 12-hex prefix of the SHA
// (`.../plugins/cache/jm-devkit/devkit/8edb19085689`). A plugin loaded from a checkout instead
// (`--plugin-dir`) is named by that checkout's HEAD. Prints the commit; exit 2 when neither says.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMain } from './gh.mjs';

const SHA = /^[0-9a-f]{7,40}$/;

function gitHead(dir) {
  const run = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

/** The commit for a plugin at `root`, or null. */
export function kitCommit(root, head = gitHead) {
  const name = path.basename(path.resolve(root));
  if (SHA.test(name)) return name;
  const sha = head(root);
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 12) : null;
}

/** The CLI. Returns the exit code. */
export function main({ env = process.env, out = process.stdout, err = process.stderr, head } = {}) {
  const root = env.CLAUDE_PLUGIN_ROOT || fileURLToPath(new URL('..', import.meta.url));
  const commit = kitCommit(root, head);
  if (!commit) {
    err.write(`cannot tell which kit commit the plugin at ${root} is: its directory is not named by a commit and it is not a git checkout\n`);
    return 2;
  }
  out.write(`${commit}\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
