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

/** Each call a fake `run` recorded, as the command line it stands for. */
export const commandLines = (calls) => calls.map(({ program, args }) => [program, ...args].join(' '));

/** A file's permission bits. */
export const mode = (file) => fs.statSync(file).mode & 0o777;

/**
 * The stand-in `pg_dump`, for a `respond`: when the call is `dumpDatabase`'s, writes a dump naming
 * its database to the file asked for, root's alone and not text, and returns true.
 */
export function standInDump(program, args) {
  if (program !== '/bin/sh' || !args[1]?.includes('pg_dump')) return false;
  fs.writeFileSync(args[4], `dump of ${args[3]}\0\xff`, { encoding: 'latin1', mode: 0o600 });
  return true;
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
export async function appsMachine(argv, { run = fakeRun().run, paths = machine(), uid = 0, now } = {}) {
  const out = sink();
  const err = sink();
  const code = await main(argv, { run, paths, out, err, uid, now });
  return { code, out: out.text, err: err.text };
}

/**
 * A `respond` for `fakeRun` that stands in for the programs `backup` runs: a `pg_dump` that writes
 * a dump naming its database, a `tar` that keeps each member's bytes, and an `age` whose output
 * `openedBundle` reads back.
 */
export function backupPrograms() {
  const after = (args, option) => args[args.indexOf(option) + 1];
  return (program, args) => {
    standInDump(program, args);
    if (program === 'tar') {
      const dir = after(args, '--directory');
      const members = args.slice(args.indexOf(dir) + 1).map((name) => [name, fs.readFileSync(path.join(dir, name)).toString('base64')]);
      fs.writeFileSync(after(args, '--file'), JSON.stringify(Object.fromEntries(members)));
    }
    if (program === 'age') {
      const sealed = { recipients: fs.readFileSync(after(args, '--recipients-file'), 'utf8'), archive: fs.readFileSync(args.at(-1), 'utf8') };
      fs.writeFileSync(after(args, '--output'), `sealed by the stand-in age\n${JSON.stringify(sealed)}`);
    }
    return {};
  };
}

/** What a bundle made with `backupPrograms` holds: the recipients it was encrypted to, and each member's bytes. */
export function openedBundle(file) {
  const { recipients, archive } = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^sealed by the stand-in age\n/, ''));
  const members = Object.entries(JSON.parse(archive)).map(([name, bytes]) => [name, Buffer.from(bytes, 'base64')]);
  return { recipients, members: Object.fromEntries(members) };
}

/**
 * A `respond` for `fakeRun` that stands in for what a deploy of `app` runs, over `machinePrograms`.
 * `remote` is the repository's default branch as GitHub has it, and a test changes it between
 * deploys: `commit`, and `config`, the object or text of its project config (none when undefined).
 * `behaviour` is how the build behaves on this machine, also a test's to change: `exits` gives the
 * exit code of a command line run as the app's user, or of any other program's whole command line,
 * `healthy` whether the health path answers, `unhealthy` the commits whose release does not answer
 * it while the others do, and `listeners` the lines `ss` prints. `events` names each thing the
 * deploy did, in order, with the release the service pointed at when it was migrated and when it
 * was started.
 */
export function deployPrograms(paths, app, remote, behaviour = {}) {
  const programs = machinePrograms({ users: [app] });
  const events = [];
  const current = () => (fs.existsSync(paths.currentRelease(app)) ? path.basename(fs.readlinkSync(paths.currentRelease(app))) : 'nothing');
  const configText = () => (typeof remote.config === 'string' ? remote.config : JSON.stringify(remote.config));
  const respond = (program, args, options = {}) => {
    if (standInDump(program, args)) {
      events.push('dump');
    } else if (program === 'git' && args[0] === 'clone') {
      events.push('fetch');
      fs.mkdirSync(args.at(-1));
      if (remote.config !== undefined) fs.writeFileSync(path.join(args.at(-1), 'devkit.json'), configText());
    } else if (program === 'git' && args.includes('rev-parse')) {
      return { stdout: `${remote.commit}\n` };
    } else if (program === 'git' && args.includes('ls-tree')) {
      events.push('config');
      return { stdout: remote.config === undefined ? '' : 'devkit.json\n' };
    } else if (program === 'git' && args.includes('show')) {
      return { stdout: configText() };
    } else if (program === 'chown' && args[0] === '-R') {
      events.push('release');
    } else if (program === 'runuser' && args[1] === app) {
      const line = args.at(-1);
      const step = Object.entries(remote.config?.deploy ?? {}).find(([, value]) => value === line)?.[0] ?? line;
      events.push(step === 'migrate' ? `migrate, pointing at ${current()}` : step);
      return { code: behaviour.exits?.[line] ?? 0 };
    } else if (program === 'systemctl' && args[0] === 'stop') {
      events.push('stop');
    } else if (program === 'systemctl' && args[0] === 'start') {
      events.push(`start, pointing at ${current()}`);
    } else if (program === 'timeout' && args.includes('curl')) {
      events.push('health');
      const answers = behaviour.healthy !== false && !behaviour.unhealthy?.some((commit) => current().endsWith(commit));
      return { code: answers ? 0 : 124 };
    } else if (program === 'ss') {
      events.push('loopback');
      const port = remote.config?.deploy?.port;
      return { stdout: (behaviour.listeners ?? [`LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:*`]).map((line) => `${line}\n`).join('') };
    } else if (program === 'tailscale') {
      events.push('serve');
    }
    const code = behaviour.exits?.[[program, ...args].join(' ')];
    return code === undefined ? programs(program, args, options) : { code, stderr: `${program} could not do that\n` };
  };
  return { respond, events };
}

/**
 * A `respond` for `fakeRun` that adds to `programs` an `rclone` keeping what it is given in
 * `stored` (a Map from `<remote>:<path>` to the file's bytes) and a `curl` recording in `requests`
 * each address its config asked for.
 */
export function offsitePrograms(programs = backupPrograms()) {
  const stored = new Map();
  const requests = [];
  const respond = (program, args, options = {}) => {
    if (program === 'rclone') {
      const [verb, ...rest] = args;
      const [first, second] = rest.filter((arg, i) => !arg.startsWith('--') && rest[i - 1] !== '--config');
      if (verb === 'copyto') stored.set(second, fs.readFileSync(first));
      if (verb === 'deletefile') stored.delete(first);
      if (verb === 'lsf') return { stdout: [...stored.keys()].filter((at) => path.posix.dirname(at) === first).map((at) => `${path.posix.basename(at)}\n`).join('') };
      return {};
    }
    if (program === 'curl') {
      requests.push(/^url = "(.*)"$/m.exec(options.input ?? '')?.[1]);
      return {};
    }
    return programs(program, args, options);
  };
  return { respond, stored, requests };
}
