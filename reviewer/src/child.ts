import { spawn, type ChildProcess } from 'node:child_process';

/** How a streamed command ended. `exitCode` and `signal` both null: it never started, and `error` says why. */
export interface ChildEnded {
  exitCode: number | null;
  signal: string | null;
  /** What stopped it before it had finished, when something did: its time limit, or the caller. */
  stoppedBy: 'limit' | 'caller' | null;
  error: Error | null;
}

export interface ChildOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Lead a process group of its own, so that whatever it started is signalled with it. */
  ownGroup: boolean;
  /** It is stopped once it has run this long. Null: no limit. */
  limitMs: number | null;
  /** How long it has, once told to stop, before it is killed outright. */
  killAfterMs: number;
  /** How long its output may stay open once it has exited: a process it left behind can hold the pipe. */
  closesWithinMs: number;
}

function signal(child: ChildProcess, ownGroup: boolean, name: NodeJS.Signals): void {
  if (!ownGroup || child.pid === undefined) {
    child.kill(name);
    return;
  }
  try {
    process.kill(-child.pid, name);
  } catch {
    child.kill(name);
  }
}

/**
 * Run a command for everything it writes: each piece goes to `onOutput` as it comes. It is told
 * to stop (SIGTERM, then SIGKILL) at its time limit, or when the caller uses the `stop` that
 * `onStart` is handed. Resolves once it has exited and its output has closed.
 */
export function streamChild(
  file: string,
  args: string[],
  options: ChildOptions,
  onOutput: (chunk: string, from: 'stdout' | 'stderr') => void,
  onStart?: (stop: () => void) => void,
): Promise<ChildEnded> {
  return new Promise((resolve) => {
    let stoppedBy: ChildEnded['stoppedBy'] = null;
    let error: Error | null = null;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: options.ownGroup });
    const stop = (by: 'limit' | 'caller') => {
      if (stoppedBy !== null) return;
      stoppedBy = by;
      signal(child, options.ownGroup, 'SIGTERM');
      timers.push(setTimeout(() => signal(child, options.ownGroup, 'SIGKILL'), options.killAfterMs));
    };
    onStart?.(() => stop('caller'));
    if (options.limitMs !== null) timers.push(setTimeout(() => stop('limit'), options.limitMs));

    const finish = (exitCode: number | null, signalName: string | null) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve({ exitCode, signal: signalName, stoppedBy, error });
    };
    for (const from of ['stdout', 'stderr'] as const) {
      child[from].setEncoding('utf8');
      child[from].on('data', (chunk: string) => onOutput(chunk, from));
    }
    child.on('error', (err) => {
      error = err;
      finish(null, null);
    });
    child.on('exit', (exitCode, signalName) => {
      timers.push(
        setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(exitCode, signalName);
        }, options.closesWithinMs),
      );
    });
    child.on('close', finish);
  });
}
