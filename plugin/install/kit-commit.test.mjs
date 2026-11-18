import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kitCommit, main } from './kit-commit.mjs';
import { sink } from './test-helpers.mjs';

const noGit = () => null;

test('an installed plugin is named by its commit: the last segment of its root', () => {
  assert.equal(kitCommit('/home/me/.claude/plugins/cache/jm-devkit/devkit/8edb19085689', noGit), '8edb19085689');
  assert.equal(kitCommit('/home/me/.claude/plugins/cache/jm-devkit/devkit/8edb19085689/', noGit), '8edb19085689');
});

test('a plugin loaded from a checkout is named by the checkout HEAD, to 12 characters', () => {
  const head = () => '9cd0bc1a2b3c4d5e6f708192a3b4c5d6e7f80912';
  assert.equal(kitCommit('/src/jm-devkit/plugin', head), '9cd0bc1a2b3c');
  assert.equal(kitCommit('/src/jm-devkit/plugin', noGit), null);
});

test('the CLI reads CLAUDE_PLUGIN_ROOT and exits 2 when it cannot tell', () => {
  const out = sink();
  assert.equal(main({ env: { CLAUDE_PLUGIN_ROOT: '/cache/devkit/0123456789ab' }, out, head: noGit }), 0);
  assert.equal(out.text, '0123456789ab\n');
  const err = sink();
  assert.equal(main({ env: { CLAUDE_PLUGIN_ROOT: '/somewhere/plugin' }, err, head: noGit }), 2);
  assert.match(err.text, /cannot tell which kit commit/);
});
