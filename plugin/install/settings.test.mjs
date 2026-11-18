import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { SETTINGS_FILE, contradictsGitRule, main } from './settings.mjs';
import { sink, tempDir } from './test-helpers.mjs';

function project(settings) {
  const dir = tempDir();
  if (settings !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, SETTINGS_FILE), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  return dir;
}

function run(argv) {
  const out = sink();
  const err = sink();
  return { code: main(argv, { out, err }), out: out.text, err: err.text };
}

const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'));

test('a rule catching a plain git commit or push contradicts the Git rule; a narrower one does not', () => {
  for (const rule of ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git commit *)', 'Bash(git push)', 'Bash(git:*)', 'Bash(git *)']) {
    assert.ok(contradictsGitRule(rule), rule);
  }
  for (const rule of ['Bash(git push --force:*)', 'Bash(git reset --hard:*)', 'Bash(git status)', 'Read(./.env)', 'Bash(npm test)']) {
    assert.ok(!contradictsGitRule(rule), rule);
  }
});

test('the contradicting rules are removed and everything else in the file stays', () => {
  const dir = project({
    permissions: {
      allow: ['Bash(npm test)'],
      ask: ['Bash(git commit:*)', 'Bash(git push --force:*)'],
      deny: ['Bash(git push:*)'],
    },
    env: { FOO: '1' },
  });
  assert.deepEqual(run([dir]), {
    code: 0,
    out: 'remove permissions.ask "Bash(git commit:*)"\nremove permissions.deny "Bash(git push:*)"\n',
    err: '',
  });
  assert.deepEqual(read(dir), { permissions: { allow: ['Bash(npm test)'], ask: ['Bash(git push --force:*)'] }, env: { FOO: '1' } });
});

test('--dry-run lists the same and leaves the file as it was', () => {
  const text = JSON.stringify({ permissions: { ask: ['Bash(git commit:*)'] } });
  const dir = project(text);
  const result = run([dir, '--dry-run']);
  assert.equal(result.out, 'remove permissions.ask "Bash(git commit:*)"\nremove .claude/settings.json\n');
  assert.equal(fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'), text);
});

test('a file left with nothing in it is removed', () => {
  const dir = project({ $schema: 'https://json.schemastore.org/claude-code-settings.json', permissions: { ask: ['Bash(git push:*)'] } });
  assert.equal(run([dir]).code, 0);
  assert.ok(!fs.existsSync(path.join(dir, SETTINGS_FILE)));
});

test('no settings file, or no such rule, is nothing to do', () => {
  assert.deepEqual(run([project()]), { code: 0, out: '', err: '' });
  const text = JSON.stringify({ permissions: { ask: [] } });
  const dir = project(text);
  assert.deepEqual(run([dir]), { code: 0, out: '', err: '' });
  assert.equal(fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'), text);
});

test('a settings file that is not JSON exits 2 and is left alone', () => {
  const dir = project('{ nope');
  const result = run([dir]);
  assert.equal(result.code, 2);
  assert.match(result.err, /not valid JSON/);
  assert.equal(run([]).code, 2);
});
