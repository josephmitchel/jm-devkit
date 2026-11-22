// Shared by the kit's node tests, the plugin's and the apps machine's: a temp dir that is gone
// after the file's tests, and captured output.

import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs = [];
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

export function tempDir(prefix = 'devkit-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A writable stream stand-in that keeps what was written. */
export function sink() {
  const s = { text: '', write: (chunk) => { s.text += chunk; return true; } };
  return s;
}
