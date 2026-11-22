// The one way the commands start a program. Tests pass their own `run` of the same shape.

import { spawnSync } from 'node:child_process';

/**
 * Run `program` with `args` and wait for it. Returns `{ code, stdout, stderr }`.
 * `input` goes to its stdin. `env`, when given, is its whole environment. `cwd` is where it runs.
 * With `live`, its output goes straight to the terminal and comes back empty.
 */
export function run(program, args = [], { input, env, cwd, live = false } = {}) {
  const done = spawnSync(program, args, {
    input,
    env,
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: live ? [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'] : 'pipe',
  });
  if (done.error) throw new Error(`could not run ${program}: ${done.error.message}`);
  return { code: done.status ?? 1, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
}
