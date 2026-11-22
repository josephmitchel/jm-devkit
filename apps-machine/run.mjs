// The one way the commands start a program. Tests pass their own `run` of the same shape.

import { spawnSync } from 'node:child_process';

/** The signals that end a command early: a terminal's interrupt, a shutdown, a session that dropped. */
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/** Thrown by `run`, once, for the program one of those signals ended. What cleans up after it runs programs as before. */
export class Interrupted extends Error {
  constructor(signal) {
    super(`interrupted by ${signal}`);
    this.name = 'Interrupted';
    this.signal = signal;
  }
}

/** Keep this process alive through those signals, so the command's own cleanup runs: the program it was waiting for gets the signal too, and `run` throws. */
export function outliveSignals() {
  for (const signal of Object.keys(SIGNALS)) process.on(signal, () => {});
}

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
  const signal = Object.keys(SIGNALS).find((name) => done.signal === name || done.status === 128 + SIGNALS[name]);
  if (signal) throw new Interrupted(signal);
  return { code: done.status ?? 1, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
}
