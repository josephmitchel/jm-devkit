// Shared by the install scripts' tests: a scratch config dir, a fake `gh`, and captured output.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sink, tempDir } from '../test-scratch.mjs';

export { sink, tempDir };

export const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export const VALUES = {
  REVIEWER_APP_CLIENT_ID: 'Iv23liTESTCLIENT',
};

/** A config dir holding a complete secrets file and key, mode 600, unless told otherwise. */
export function configDir({ lines, key = PRIVATE_KEY, mode = 0o600 } = {}) {
  const dir = tempDir('devkit-config-');
  const text = lines === undefined ? Object.entries(VALUES).map(([k, v]) => `${k}=${v}`) : lines;
  if (text !== null) {
    fs.writeFileSync(path.join(dir, 'secrets.env'), `${text.join('\n')}\n`);
    fs.chmodSync(path.join(dir, 'secrets.env'), mode);
  }
  if (key !== null) {
    fs.writeFileSync(path.join(dir, 'reviewer-app-private-key.pem'), key);
    fs.chmodSync(path.join(dir, 'reviewer-app-private-key.pem'), mode);
  }
  return dir;
}

/** A fake `gh`: `respond(args, input)` returns `{ code, stdout, stderr }`; every call is recorded. */
export function fakeGh(respond) {
  const calls = [];
  const gh = (args, { input } = {}) => {
    calls.push({ args, input });
    return { code: 0, stdout: '', stderr: '', ...respond(args, input) };
  };
  return { gh, calls };
}
