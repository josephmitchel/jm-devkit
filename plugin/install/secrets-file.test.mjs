import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { APP_SECRET_NAMES, SecretsFileError, configDir as defaultDir, parseEnvFile, readSecrets } from './secrets-file.mjs';
import { PRIVATE_KEY, VALUES, configDir } from './test-helpers.mjs';

test('the config dir is DEVKIT_CONFIG_DIR, else ~/.config/jm-devkit', () => {
  assert.equal(defaultDir({ DEVKIT_CONFIG_DIR: '/x/y' }), '/x/y');
  assert.match(defaultDir({}), /[/\\]\.config[/\\]jm-devkit$/);
});

test('a value is taken whole: = and & stay, one pair of quotes goes, comments and export are skipped', () => {
  const { values, malformed } = parseEnvFile(
    ['# the kit', '', 'export A=x=y&z=1', 'B="quoted value"', "C='single'", 'D=  spaced ', 'not a line', 'E='].join('\n'),
  );
  assert.deepEqual(values, { A: 'x=y&z=1', B: 'quoted value', C: 'single', D: '  spaced ', E: '' });
  assert.deepEqual(malformed, [7]);
});

test("readSecrets returns the App's client id and its key, the key from its own file", () => {
  assert.deepEqual(readSecrets(APP_SECRET_NAMES, configDir()), { ...VALUES, REVIEWER_APP_PRIVATE_KEY: PRIVATE_KEY });
});

test('readSecrets names every problem at once and no value', () => {
  const dir = configDir({ lines: ['DATABASE_URL=postgres://secret-value', 'oops'], key: 'not a key', mode: 0o644 });
  let error;
  try {
    readSecrets(APP_SECRET_NAMES, dir);
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof SecretsFileError);
  const text = error.problems.join('\n');
  assert.match(text, /secrets\.env is readable by others than its owner \(mode 644\)/);
  assert.match(text, /secrets\.env line 2 is not NAME=value/);
  assert.match(text, /no value for REVIEWER_APP_CLIENT_ID/);
  assert.match(text, /reviewer-app-private-key\.pem is not a PEM private key/);
  assert.doesNotMatch(text, /secret-value|oops/);
});

test('a missing secrets file is a clear error naming where it should be', () => {
  const dir = configDir({ lines: null, key: null });
  assert.throws(() => readSecrets(APP_SECRET_NAMES, dir), (e) => {
    assert.match(e.message, new RegExp(`${path.join(dir, 'secrets.env').replaceAll('\\', '\\\\')} is missing`));
    assert.match(e.message, /reviewer-app-private-key\.pem is missing/);
    return true;
  });
});
