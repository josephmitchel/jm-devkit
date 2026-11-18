import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { SECRET_NAMES, SecretsFileError, configDir as defaultDir, parseEnvFile, readSecrets } from './secrets-file.mjs';
import { main } from './secrets.mjs';
import { PRIVATE_KEY, VALUES, configDir, fakeGh, sink } from './test-helpers.mjs';

const REPO = 'owner/project';
const ALL_VALUES = [...Object.values(VALUES), PRIVATE_KEY];

/** A gh whose repository already has `existing`, and which accepts every `secret set`. */
function repoWith(existing = []) {
  return fakeGh((args) => {
    if (args[0] === 'secret' && args[1] === 'list') return { stdout: JSON.stringify(existing.map((name) => ({ name }))) };
    if (args[0] === 'secret' && args[1] === 'set') return {};
    return { code: 1, stderr: `unexpected gh ${args.join(' ')}` };
  });
}

function run(argv, { gh, dir }) {
  const out = sink();
  const err = sink();
  const code = main(argv, { gh, env: { DEVKIT_CONFIG_DIR: dir }, out, err });
  return { code, out: out.text, err: err.text };
}

function assertNoValue(...texts) {
  for (const text of texts) for (const value of ALL_VALUES) assert.ok(!text.includes(value.trim()), 'a secret value was printed');
}

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

test('readSecrets returns the four values, the key from its own file', () => {
  const dir = configDir();
  assert.deepEqual(readSecrets(SECRET_NAMES, dir), { ...VALUES, REVIEWER_APP_PRIVATE_KEY: PRIVATE_KEY });
});

test('readSecrets names every problem at once and no value', () => {
  const dir = configDir({ lines: ['DATABASE_URL=postgres://secret-value', 'oops'], key: 'not a key', mode: 0o644 });
  let error;
  try {
    readSecrets(SECRET_NAMES, dir);
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof SecretsFileError);
  const text = error.problems.join('\n');
  assert.match(text, /secrets\.env is readable by others than its owner \(mode 644\)/);
  assert.match(text, /secrets\.env line 2 is not NAME=value/);
  assert.match(text, /no value for CLAUDE_CODE_OAUTH_TOKEN, REVIEWER_APP_CLIENT_ID/);
  assert.match(text, /reviewer-app-private-key\.pem is not a PEM private key/);
  assert.doesNotMatch(text, /secret-value|oops/);
});

test('a missing secrets file is a clear error naming where it should be', () => {
  const dir = configDir({ lines: null, key: null });
  assert.throws(() => readSecrets(SECRET_NAMES, dir), (e) => {
    assert.match(e.message, new RegExp(`${path.join(dir, 'secrets.env').replaceAll('\\', '\\\\')} is missing`));
    assert.match(e.message, /reviewer-app-private-key\.pem is missing/);
    return true;
  });
});

test('--dry-run lists the secrets the repository lacks and sets nothing', () => {
  const { gh, calls } = repoWith(['DATABASE_URL']);
  const result = run([REPO, '--dry-run'], { gh, dir: configDir() });
  assert.equal(result.code, 0);
  assert.equal(result.out, 'set CLAUDE_CODE_OAUTH_TOKEN\nset REVIEWER_APP_CLIENT_ID\nset REVIEWER_APP_PRIVATE_KEY\n');
  assert.deepEqual(calls.map((c) => c.args[1]), ['list']);
});

test('each missing secret is set with its value on stdin, never in an argument or the output', () => {
  const { gh, calls } = repoWith(['DATABASE_URL']);
  const result = run([REPO], { gh, dir: configDir() });
  assert.equal(result.code, 0);
  const sets = calls.filter((c) => c.args[1] === 'set');
  assert.deepEqual(
    sets.map((c) => c.args),
    ['CLAUDE_CODE_OAUTH_TOKEN', 'REVIEWER_APP_CLIENT_ID', 'REVIEWER_APP_PRIVATE_KEY'].map((n) => ['secret', 'set', n, '-R', REPO, '--app', 'actions']),
  );
  assert.deepEqual(sets.map((c) => c.input), [VALUES.CLAUDE_CODE_OAUTH_TOKEN, VALUES.REVIEWER_APP_CLIENT_ID, PRIVATE_KEY]);
  for (const c of calls) assertNoValue(c.args.join(' '));
  assertNoValue(result.out, result.err);
});

test('a repository with all four secrets needs no secrets file and gets nothing', () => {
  const { gh, calls } = repoWith(SECRET_NAMES);
  const result = run([REPO], { gh, dir: configDir({ lines: null, key: null }) });
  assert.deepEqual(result, { code: 0, out: '', err: '' });
  assert.equal(calls.length, 1);
});

test('an incomplete secrets file stops it before anything is set, dry run or not, exit 2', () => {
  for (const argv of [[REPO, '--dry-run'], [REPO]]) {
    const { gh, calls } = repoWith([]);
    const result = run(argv, { gh, dir: configDir({ lines: [`DATABASE_URL=${VALUES.DATABASE_URL}`] }) });
    assert.equal(result.code, 2);
    assert.match(result.err, /cannot set DATABASE_URL, CLAUDE_CODE_OAUTH_TOKEN, REVIEWER_APP_CLIENT_ID, REVIEWER_APP_PRIVATE_KEY on owner\/project/);
    assert.match(result.err, /no value for CLAUDE_CODE_OAUTH_TOKEN, REVIEWER_APP_CLIENT_ID/);
    assert.equal(result.out, '');
    assert.ok(calls.every((c) => c.args[1] === 'list'));
    assertNoValue(result.err);
  }
});

test('a failing gh secret set is reported without the value, exit 1', () => {
  const { gh } = fakeGh((args, input) => {
    if (args[1] === 'list') return { stdout: '[]' };
    return { code: 1, stderr: `HTTP 403 while storing ${input}` };
  });
  const result = run([REPO], { gh, dir: configDir() });
  assert.equal(result.code, 1);
  assert.match(result.err, /could not set DATABASE_URL on owner\/project: HTTP 403 while storing \[redacted\]/);
  assertNoValue(result.out, result.err);
});

test('bad arguments exit 2 with the usage', () => {
  for (const argv of [[], ['not-a-slug'], [REPO, 'extra']]) {
    const result = run(argv, { gh: repoWith().gh, dir: configDir() });
    assert.equal(result.code, 2);
    assert.match(result.err, /^usage:/);
  }
});
