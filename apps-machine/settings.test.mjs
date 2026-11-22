import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readSettings, runAsApp, writeSettings } from './settings.mjs';
import { fakeRun, machine, mode, withUmask } from './test-helpers.mjs';

function withSettings(text) {
  const paths = machine();
  writeSettings(paths, 'sample', text);
  return paths;
}

test('a settings file is root\'s alone, and so is the directory of them', () => {
  const paths = withSettings('A=1\n');
  assert.equal(mode(paths.settingsDir), 0o700);
  assert.equal(mode(paths.settingsFile('sample')), 0o600);
  assert.equal(fs.readFileSync(paths.settingsFile('sample'), 'utf8'), 'A=1\n');
  assert.deepEqual(fs.readdirSync(paths.settingsDir), ['sample.env']);
});

test('a settings file written over another keeps the mode, whatever the umask', () => {
  withUmask(0o022, () => {
    const paths = withSettings('A=1\n');
    fs.chmodSync(paths.settingsFile('sample'), 0o644);
    writeSettings(paths, 'sample', 'A=2\n');
    assert.equal(mode(paths.settingsFile('sample')), 0o600);
    assert.deepEqual(readSettings(paths, 'sample'), { A: '2' });
  });
});

test('settings are read as systemd reads an environment file', () => {
  const text = [
    '# a comment',
    '; another',
    '',
    'DATABASE_URL=postgres://sample:secret@127.0.0.1:5432/sample',
    'EMPTY=',
    '  PADDED =  some words  ',
    'EQUALS=a=b#c',
    'SINGLE=\'kept as $it is \\n\'',
    'DOUBLE="a \\"quoted\\" \\$word and a back\\\\slash"',
    'LINES="one',
    'two"',
    '',
  ].join('\n');
  assert.deepEqual(readSettings(withSettings(text), 'sample'), {
    DATABASE_URL: 'postgres://sample:secret@127.0.0.1:5432/sample',
    EMPTY: '',
    PADDED: 'some words',
    EQUALS: 'a=b#c',
    SINGLE: 'kept as $it is \\n',
    DOUBLE: 'a "quoted" $word and a back\\slash',
    LINES: 'one\ntwo',
  });
});

test('a later setting of a name replaces an earlier one, and a file with no final newline is read whole', () => {
  assert.deepEqual(readSettings(withSettings('A=1\nA=2\nB=3'), 'sample'), { A: '2', B: '3' });
});

test('a line that is not a setting is refused by its number, without its text', () => {
  const refused = ['A=1\nsecret words\n', 'A=1\nexport B=secret\n', 'A=1\n1B=secret\n', 'A=1\nB=se\\cret\n', 'A=1\nB="secret" more\n',
    'A=1\nB="secret\n', 'A=1\nB=\'secret\nC=2\n', 'A=1\nB=sec"ret"\n', 'A=1\nB="sec\\ret"\n', 'A=1\n# a comment that may run on \\\nB=2\n'];
  for (const text of refused) {
    const paths = withSettings(text);
    assert.throws(() => readSettings(paths, 'sample'), (e) => {
      assert.equal(e.message, `line 2 of ${paths.settingsFile('sample')} is not a setting: write NAME=value, with the value in quotes if it holds a quote or a backslash`);
      return true;
    }, text);
  }
});

test('an app with no settings file is refused, naming the file', () => {
  const paths = machine();
  assert.throws(() => readSettings(paths, 'sample'), new RegExp(`^Error: sample has no settings file: ${paths.settingsFile('sample')} is missing$`));
});

test('a command runs as the app\'s user with the settings in its environment and nothing of root\'s', () => {
  const paths = withSettings('DATABASE_URL=postgres://sample:secret@127.0.0.1:5432/sample\nKEY="a b"\n');
  const { run, calls } = fakeRun(() => ({ code: 3, stdout: 'built', stderr: 'warned' }));
  process.env.ROOTS_OWN = 'not for an app';
  try {
    const done = runAsApp({ run, paths }, 'sample', 'npm ci && npm run build', { cwd: '/a/release', live: true });
    assert.deepEqual(done, { code: 3, stdout: 'built', stderr: 'warned' });
  } finally {
    delete process.env.ROOTS_OWN;
  }
  assert.deepEqual(calls, [{
    program: 'runuser',
    args: ['-u', 'sample', '--', '/bin/sh', '-c', 'npm ci && npm run build'],
    cwd: '/a/release',
    live: true,
    env: {
      HOME: paths.appHome('sample'),
      USER: 'sample',
      LOGNAME: 'sample',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin',
      DATABASE_URL: 'postgres://sample:secret@127.0.0.1:5432/sample',
      KEY: 'a b',
    },
  }]);
});

test('a command for an app whose settings cannot be read is not run', () => {
  const paths = withSettings('not a setting\n');
  const { run, calls } = fakeRun();
  assert.throws(() => runAsApp({ run, paths }, 'sample', 'true', { cwd: '/' }), /line 1 of /);
  assert.deepEqual(calls, []);
});
