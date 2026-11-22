// Shared by the commands' tests: a machine under a temp dir, a fake `run`, and captured output.

import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from './apps-machine.mjs';
import { machinePaths } from './paths.mjs';

const dirs = [];
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

export function tempDir(prefix = 'apps-machine-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** The paths of a new machine whose root is a temp dir. */
export function machine() {
  return machinePaths(tempDir());
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

/** A writable stream stand-in that keeps what was written. */
export function sink() {
  const s = { text: '', write: (chunk) => { s.text += chunk; return true; } };
  return s;
}

/** Put an app's registration on a machine, as the register command leaves it. */
export function registered(paths, registration) {
  fs.mkdirSync(paths.appsDir, { recursive: true });
  fs.writeFileSync(paths.registration(registration.name), `${JSON.stringify(registration, null, 2)}\n`);
  return registration;
}

/** Run `apps-machine <argv>` as root on `paths`, with programs run by `run`. */
export async function appsMachine(argv, { run = fakeRun().run, paths = machine(), uid = 0 } = {}) {
  const out = sink();
  const err = sink();
  const code = await main(argv, { run, paths, out, err, uid });
  return { code, out: out.text, err: err.text };
}
