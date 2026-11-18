// The one way the install scripts run `gh`. Tests pass their own runner of the same shape.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Run `gh` with `args`, `input` on its stdin. Returns `{ code, stdout, stderr }`. */
export function gh(args, { input } = {}) {
  const run = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw new Error(`could not run gh: ${run.error.message}`);
  return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
}

/** True when `metaUrl` is the script node was started with. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(metaUrl);
}

/** An owner/name slug, or null. */
export function repoSlug(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : null;
}
