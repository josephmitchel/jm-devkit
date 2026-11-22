#!/usr/bin/env node
// The apps machine's commands, for root: apps-machine <command> [arguments]
// Exit 0 done, 1 failed, 2 bad arguments.

import { isMain } from './is-main.mjs';
import { machinePaths } from './paths.mjs';
import { outliveSignals, run as realRun } from './run.mjs';
import { UsageError } from './usage.mjs';

/** One line per command: its module exports `usage`, `summary` and `command(args, world)`, which throws to fail. */
export const COMMANDS = {
  list: await import('./commands/list.mjs'),
  register: await import('./commands/register.mjs'),
  deploy: await import('./commands/deploy.mjs'),
  backup: await import('./commands/backup.mjs'),
  logs: await import('./commands/logs.mjs'),
  restore: await import('./commands/restore.mjs'),
};

function usage() {
  const lines = Object.values(COMMANDS).map((c) => `  ${c.usage}\n      ${c.summary}\n`);
  return `usage: apps-machine <command>\n${lines.join('')}`;
}

/** The CLI. Returns the exit code. */
export async function main(argv, { run = realRun, paths = machinePaths(), out = process.stdout, err = process.stderr, uid = process.getuid(), now = () => new Date() } = {}) {
  const [name, ...args] = argv;
  if (!Object.hasOwn(COMMANDS, name ?? '')) {
    err.write(usage());
    return 2;
  }
  if (uid !== 0) {
    err.write('error: run with sudo\n');
    return 1;
  }
  try {
    await COMMANDS[name].command(args, { run, paths, out, err, now });
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err.write(`${e.message ? `error: ${e.message}\n` : ''}usage: ${COMMANDS[name].usage}\n`);
      return 2;
    }
    err.write(`error: ${e.message}\n`);
    return 1;
  }
}

/** `main` as the program root runs: an interrupt does not kill it, so the command it stopped cleans up as after any failure. */
export function start(argv, world) {
  outliveSignals();
  return main(argv, world);
}

if (isMain(import.meta.url)) process.exitCode = await start(process.argv.slice(2));
