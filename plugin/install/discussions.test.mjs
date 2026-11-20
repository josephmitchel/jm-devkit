import { test } from 'node:test';
import assert from 'node:assert/strict';

import { main } from './discussions.mjs';
import { fakeGh, sink } from './test-helpers.mjs';

const REPO = 'owner/project';

/** A fake `gh` whose GraphQL answer is a repository with discussions on or off and these categories. */
function repoWith({ enabled = true, categories = [] } = {}) {
  return fakeGh((args) => {
    if (args[0] !== 'api' || args[1] !== 'graphql') return { code: 1, stderr: 'not a call this script makes' };
    const repository = { hasDiscussionsEnabled: enabled, discussionCategories: { nodes: categories.map((name) => ({ name })) } };
    return { stdout: JSON.stringify({ data: { repository } }) };
  });
}

function run(argv, gh, env = {}) {
  const out = sink();
  const err = sink();
  return { code: main(argv, { gh, env, out, err }), out: out.text, err: err.text };
}

test('a project with discussions on and the category, however it is capitalised, is ready', () => {
  const { gh, calls } = repoWith({ categories: ['General', 'code Reviewer '] });
  assert.deepEqual(run([REPO], gh), { code: 0, out: 'ready\n', err: '' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('o=owner') && calls[0].args.includes('r=project'), calls[0].args.join(' '));
});

test('a project with discussions on and no such category is told exactly what to create', () => {
  const { gh } = repoWith({ categories: ['General', 'Ideas'] });
  const result = run([REPO], gh);
  assert.equal(result.code, 1);
  assert.equal(
    result.out,
    'owner/project has no discussion category named "Code reviewer". Create a discussion category named "Code reviewer" ' +
      "(the project's Discussions tab, the pencil beside Categories, New category; format: Open-ended discussion). " +
      "The code reviewer posts each night's summary there. It cannot create the category: GitHub's API has no call for it.\n",
  );
  assert.equal(result.err, '');
});

test('a project with discussions off is told to turn them on and then create the category', () => {
  const result = run([REPO], repoWith({ enabled: false }).gh);
  assert.equal(result.code, 1);
  assert.match(result.out, /^owner\/project has discussions turned off\. In the project's settings on GitHub, turn on Discussions \(Settings, General, Features\), then create a discussion category named "Code reviewer"/);
});

test('the category looked for is the one the code reviewer is set to post in', () => {
  const env = { REVIEWER_DISCUSSION_CATEGORY: 'Nightly' };
  assert.equal(run([REPO], repoWith({ categories: ['nightly'] }).gh, env).code, 0);
  const missing = run([REPO], repoWith({ categories: ['Code reviewer'] }).gh, env);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /no discussion category named "Nightly"/);
});

test('it only asks: nothing is created or changed', () => {
  for (const setup of [{ categories: ['Code reviewer'] }, { categories: [] }, { enabled: false }]) {
    const { gh, calls } = repoWith(setup);
    run([REPO], gh);
    assert.equal(calls.length, 1);
    assert.match(calls[0].args.find((a) => a.startsWith('query=')), /^query=query\(/);
  }
});

test('a gh failure, or an answer with no repository in it, exits 2 saying so', () => {
  const refused = run([REPO], fakeGh(() => ({ code: 1, stderr: 'HTTP 401: Bad credentials\n' })).gh);
  assert.deepEqual(refused, { code: 2, out: '', err: 'could not read the discussions of owner/project: HTTP 401: Bad credentials\n' });
  const empty = run([REPO], fakeGh(() => ({ stdout: '{"data":{"repository":null}}' })).gh);
  assert.equal(empty.code, 2);
  assert.match(empty.err, /^could not read the discussions of owner\/project: /);
  assert.equal(empty.out, '');
});

test('bad arguments exit 2', () => {
  for (const argv of [[], ['nope'], [REPO, 'extra']]) {
    const result = run(argv, repoWith().gh);
    assert.equal(result.code, 2);
    assert.match(result.err, /^usage: /);
  }
});
