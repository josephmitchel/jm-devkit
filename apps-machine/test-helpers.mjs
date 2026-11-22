// Shared by the commands' tests: a machine under a temp dir, a fake `run`, and captured output.

import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { COMMANDS, main } from './apps-machine.mjs';
import { machinePaths } from './paths.mjs';
import { readRegistry, registrationOf } from './registry.mjs';

const dirs = [];
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

export function tempDir(prefix = 'apps-machine-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** The paths of a new machine whose root is a temp dir, with the directories the setup script makes. */
export function machine() {
  const paths = machinePaths(tempDir());
  for (const [dir, mode] of [[paths.configDir, 0o700], [paths.stateDir, 0o755], [paths.backupDir, 0o700]]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, mode);
  }
  return paths;
}

/** A fake `run`: `respond(program, args, options)` returns any of `{ code, stdout, stderr }`; every call is recorded. */
export function fakeRun(respond = () => ({})) {
  const calls = [];
  const run = (program, args = [], options = {}) => {
    calls.push({ program, args, ...options });
    return { code: 0, stdout: '', stderr: '', ...respond(program, args, options) };
  };
  return { run, calls };
}

/**
 * A `respond` for `fakeRun` that stands in for the programs `register` asks things of: it remembers
 * the Linux users made and the services turned on, writes a deploy key's two files, and answers
 * for Postgres. `users` and `groups` are there already; `taken` are names Postgres already has.
 */
export function machinePrograms({ users = [], groups = [], taken = [], port = 5432 } = {}) {
  const present = new Set(users);
  const enabled = new Set();
  return (program, args, { input = '' } = {}) => {
    if (program === 'id') return { code: present.has(args.at(-1)) ? 0 : 1 };
    if (program === 'getent' && args[0] === 'group') return { code: groups.includes(args.at(-1)) ? 0 : 2 };
    if (program === 'useradd') present.add(args.at(-1));
    if (program === 'systemctl' && args[0] === 'is-enabled') return { code: enabled.has(args.at(-1)) ? 0 : 1 };
    if (program === 'systemctl' && args[0] === 'enable') enabled.add(args.at(-1));
    if (program === 'ssh-keygen') {
      const file = args[args.indexOf('-f') + 1];
      fs.writeFileSync(file, `PRIVATE HALF ${path.basename(file)}\n`, { mode: 0o644 });
      fs.writeFileSync(`${file}.pub`, `ssh-ed25519 AAAAmadeup${path.basename(file)} ${args[args.indexOf('-C') + 1]}\n`);
    }
    if (/^SHOW port/.test(input)) return { stdout: `${port}\n` };
    if (/^SELECT 1 FROM pg_roles/.test(input)) return { stdout: taken.some((name) => input.includes(`'${name}'`)) ? '1\n' : '' };
    return {};
  };
}

/** A writable stream stand-in that keeps what was written. */
export function sink() {
  const s = { text: '', write: (chunk) => { s.text += chunk; return true; } };
  return s;
}

/**
 * Register an app on a machine by running the register command against `machinePrograms`, so its
 * registration, directories, settings file, deploy key and unit are there. Returns the registration.
 * The repository and Serve port are made up when not given.
 */
export function registered(paths, { name, repository = `git@github.com:example/${name}.git`, servePort }) {
  const used = readRegistry(paths).map((app) => app.servePort);
  const port = servePort ?? Array.from({ length: used.length + 1 }, (_, i) => 8443 + i).find((free) => !used.includes(free));
  COMMANDS.register.command([name, repository, String(port)], { run: fakeRun(machinePrograms()).run, paths, out: sink(), err: sink() });
  return registrationOf(paths, name);
}

/** Run `apps-machine <argv>` as root on `paths`, with programs run by `run`. */
export async function appsMachine(argv, { run = fakeRun().run, paths = machine(), uid = 0 } = {}) {
  const out = sink();
  const err = sink();
  const code = await main(argv, { run, paths, out, err, uid });
  return { code, out: out.text, err: err.text };
}
