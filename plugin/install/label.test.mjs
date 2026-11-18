import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REVIEW_NOW, main } from './label.mjs';
import { fakeGh, sink } from './test-helpers.mjs';

const REPO = 'owner/project';

function repoWith(labels) {
  return fakeGh((args) => {
    if (args[1] === 'list') return { stdout: JSON.stringify(labels.map((name) => ({ name }))) };
    if (args[1] === 'create') return {};
    return { code: 1 };
  });
}

function run(argv, gh) {
  const out = sink();
  const err = sink();
  return { code: main(argv, { gh, out, err }), out: out.text, err: err.text };
}

test('a repository without review-now gets it, with its colour and description', () => {
  const { gh, calls } = repoWith(['spec', 'bug']);
  assert.deepEqual(run([REPO], gh), { code: 0, out: 'create review-now\n', err: '' });
  assert.deepEqual(calls.at(-1).args, ['label', 'create', 'review-now', '-R', REPO, '--color', REVIEW_NOW.color, '--description', REVIEW_NOW.description]);
});

test('--dry-run says it would create review-now and creates nothing', () => {
  const { gh, calls } = repoWith([]);
  assert.deepEqual(run([REPO, '--dry-run'], gh), { code: 0, out: 'create review-now\n', err: '' });
  assert.ok(calls.every((c) => c.args[1] === 'list'));
});

test('a repository that has it, in any case, is left alone', () => {
  const { gh, calls } = repoWith(['Review-Now']);
  assert.deepEqual(run([REPO], gh), { code: 0, out: '', err: '' });
  assert.equal(calls.length, 1);
});

test('a gh failure exits 1 with what gh said', () => {
  const { gh } = fakeGh((args) => (args[1] === 'list' ? { stdout: '[]' } : { code: 1, stderr: 'HTTP 403' }));
  const result = run([REPO], gh);
  assert.equal(result.code, 1);
  assert.match(result.err, /could not create review-now on owner\/project: HTTP 403/);
});

test('bad arguments exit 2', () => {
  assert.equal(run([], repoWith([]).gh).code, 2);
  assert.equal(run(['nope'], repoWith([]).gh).code, 2);
});
