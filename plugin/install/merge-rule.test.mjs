import { test } from 'node:test';
import assert from 'node:assert/strict';

import { main } from './merge-rule.mjs';
import { fakeGh, sink } from './test-helpers.mjs';

const REPO = 'owner/project';
const ACTIONS = 15368;

const CI = `name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
`;

const PULL_REQUEST = {
  required_approving_review_count: 0,
  dismiss_stale_reviews_on_push: false,
  require_code_owner_review: false,
  require_last_push_approval: false,
  required_review_thread_resolution: false,
};

/** The whole of what the kit asks GitHub to create for a project whose CI jobs are `unit` and `lint`. */
const CREATED = {
  name: 'merge rule',
  target: 'branch',
  enforcement: 'active',
  bypass_actors: [],
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'pull_request', parameters: PULL_REQUEST },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: [
          { context: 'unit', integration_id: ACTIONS },
          { context: 'lint', integration_id: ACTIONS },
        ],
      },
    },
  ],
};

const statusChecks = (...contexts) => ({
  type: 'required_status_checks',
  parameters: {
    strict_required_status_checks_policy: false,
    do_not_enforce_on_create: false,
    required_status_checks: contexts.map((context) => ({ context, integration_id: ACTIONS })),
  },
});

/** A ruleset as GitHub returns it to an account with admin rights: the merge rule, made by hand, unless told otherwise. */
function ruleset(changes = {}) {
  return {
    id: 7,
    name: 'main merge gate',
    target: 'branch',
    source_type: 'Repository',
    source: REPO,
    enforcement: 'active',
    conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: { ...PULL_REQUEST, required_reviewers: [], allowed_merge_methods: ['merge', 'squash', 'rebase'] } },
      statusChecks('unit', 'lint'),
    ],
    bypass_actors: [],
    current_user_can_bypass: 'never',
    ...changes,
  };
}

const without = (type, rules = ruleset().rules) => rules.filter((rule) => rule.type !== type);

/** GitHub shows who may bypass a ruleset only to an account that may edit it. */
function asSeenWithoutAdmin({ bypass_actors: _hidden, ...seen }) {
  return seen;
}

const NOT_FOUND = { code: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)\n' };

/** A fake `gh` over a made-up project: its rulesets, its CI workflow, and whether the account has admin rights. */
function projectWith({ admin = true, rulesets = [], workflow = CI, branch = 'main', refuse = null } = {}) {
  const seen = admin ? rulesets : rulesets.map(asSeenWithoutAdmin);
  return fakeGh((args) => {
    const path = args.at(args.includes('--method') ? 3 : -1);
    if (args[0] !== 'api') return { code: 1, stderr: 'not a call this script makes' };
    if (args.includes('--method')) return refuse ? { code: 1, stderr: refuse } : { stdout: '{}' };
    if (path === `repos/${REPO}`) return { stdout: JSON.stringify({ default_branch: branch, permissions: { admin, push: true } }) };
    if (path === `repos/${REPO}/rulesets?per_page=100`) {
      return { stdout: JSON.stringify(seen.map(({ id, name, target, source_type, enforcement }) => ({ id, name, target, source_type, enforcement }))) };
    }
    const one = seen.find((r) => path === `repos/${REPO}/rulesets/${r.id}`);
    if (one) return { stdout: JSON.stringify(one) };
    if (path === `repos/${REPO}/contents/.github/workflows/ci.yml` && args.includes('Accept: application/vnd.github.raw+json')) {
      return workflow === null ? NOT_FOUND : { stdout: workflow };
    }
    return { code: 1, stderr: `unexpected call: ${args.join(' ')}` };
  });
}

function run(argv, gh) {
  const out = sink();
  const err = sink();
  return { code: main(argv, { gh, out, err }), out: out.text, err: err.text };
}

const writes = (calls) => calls.filter((call) => call.args.includes('--method'));

test('a project carrying the rule is in place, and nothing is asked of GitHub but to read', () => {
  const { gh, calls } = projectWith({ rulesets: [ruleset()] });
  assert.deepEqual(run([REPO], gh), { code: 0, out: 'in place\n', err: '' });
  assert.deepEqual(writes(calls), []);
});

test('a project without the rule gets it, with its CI jobs as required checks', () => {
  const { gh, calls } = projectWith();
  assert.deepEqual(run([REPO], gh), { code: 0, out: 'create merge rule: requires the CI checks unit, lint\n', err: '' });
  const [created, ...others] = writes(calls);
  assert.deepEqual(others, []);
  assert.deepEqual(created.args, ['api', '--method', 'POST', `repos/${REPO}/rulesets`, '--input', '-']);
  assert.deepEqual(JSON.parse(created.input), CREATED);
});

test('--dry-run says it would create the rule and creates nothing', () => {
  const { gh, calls } = projectWith();
  assert.deepEqual(run([REPO, '--dry-run'], gh), { code: 0, out: 'create merge rule: requires the CI checks unit, lint\n', err: '' });
  assert.deepEqual(writes(calls), []);
});

test('without admin rights a missing rule is reported with the one command that creates it, and the exit code is unchanged', () => {
  const { gh, calls } = projectWith({ admin: false });
  const result = run([REPO], gh);
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  const [said, command, ...rest] = result.out.trimEnd().split('\n');
  assert.deepEqual(rest, []);
  assert.equal(
    said,
    'owner/project has no merge rule on its default branch, and this account has no admin rights on the project to add it. Run this as an account that has them:',
  );
  const [, body] = command.match(/^printf '%s' '(.*)' \| gh api --method POST repos\/owner\/project\/rulesets --input -$/);
  assert.deepEqual(JSON.parse(body), CREATED);
  assert.deepEqual(writes(calls), []);
});

test('an account without admin rights is not shown who may bypass the rule, and in place says so', () => {
  const { gh, calls } = projectWith({ admin: false, rulesets: [ruleset()] });
  assert.deepEqual(run([REPO], gh), {
    code: 0,
    out:
      'in place, as far as this account can see: who may bypass a ruleset is shown only to an account with admin rights on owner/project. ' +
      'For such an account this prints [] when nobody may: gh api repos/owner/project/rulesets/7 --jq .bypass_actors\n',
    err: '',
  });
  assert.deepEqual(writes(calls), []);
});

const WEAKER = /^The merge rule of owner\/project \(the ruleset "main merge gate"\) is weaker than the kit's: (.*)\. Install and sync never change these: put them right at https:\/\/github\.com\/owner\/project\/rules\/7\n$/;

test('a rule that is inactive, bypassable or short of a restriction is reported, naming which, and is not changed', () => {
  const bypass = { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' };
  for (const [changes, named] of [
    [{ enforcement: 'disabled' }, 'it is not active (enforcement: disabled)'],
    [{ enforcement: 'evaluate' }, 'it is not active (enforcement: evaluate)'],
    [{ bypass_actors: [bypass] }, 'it can be bypassed (1 bypass actor)'],
    [{ bypass_actors: [bypass, { ...bypass, actor_id: 9 }] }, 'it can be bypassed (2 bypass actors)'],
    [{ rules: without('deletion') }, 'it lets the default branch be deleted'],
    [{ rules: without('non_fast_forward') }, 'it allows force-pushes'],
    [{ rules: without('pull_request') }, 'it does not require a pull request'],
    [
      { enforcement: 'disabled', bypass_actors: [bypass], rules: without('deletion', without('pull_request')) },
      'it is not active (enforcement: disabled); it can be bypassed (1 bypass actor); it lets the default branch be deleted; it does not require a pull request',
    ],
  ]) {
    const { gh, calls } = projectWith({ rulesets: [ruleset(changes)] });
    const result = run([REPO], gh);
    assert.equal(result.code, 0);
    assert.equal(result.out.match(WEAKER)?.[1], named, result.out);
    assert.deepEqual(writes(calls), []);
  }
});

test('a rule this account can bypass is reported even though the account is not shown who else can', () => {
  const { gh } = projectWith({ admin: false, rulesets: [ruleset({ current_user_can_bypass: 'pull_requests_only' })] });
  assert.equal(run([REPO], gh).out.match(WEAKER)?.[1], 'this account can bypass it');
});

test('a rule that lacks a CI job gets it as a required check, and keeps everything it had', () => {
  const had = ruleset({ rules: [...without('required_status_checks'), statusChecks('unit', 'deploy-preview')] });
  const { gh, calls } = projectWith({ rulesets: [had] });
  assert.deepEqual(run([REPO], gh), { code: 0, out: 'add required checks: lint\n', err: '' });
  const [changed, ...others] = writes(calls);
  assert.deepEqual(others, []);
  assert.deepEqual(changed.args, ['api', '--method', 'PUT', `repos/${REPO}/rulesets/7`, '--input', '-']);
  const { rules: hadRules, name, target, enforcement, conditions, bypass_actors } = had;
  const checks = hadRules.at(-1).parameters;
  assert.deepEqual(JSON.parse(changed.input), {
    name,
    target,
    enforcement,
    conditions,
    bypass_actors,
    rules: [
      ...hadRules.slice(0, -1),
      { type: 'required_status_checks', parameters: { ...checks, required_status_checks: [...checks.required_status_checks, { context: 'lint', integration_id: ACTIONS }] } },
    ],
  });
});

test('a rule with no required checks at all gets the CI jobs, beside the rules it had', () => {
  const had = ruleset({ rules: [...without('required_status_checks'), { type: 'required_linear_history' }] });
  const { gh, calls } = projectWith({ rulesets: [had] });
  assert.deepEqual(run([REPO], gh), { code: 0, out: 'add required checks: unit, lint\n', err: '' });
  assert.deepEqual(JSON.parse(writes(calls)[0].input).rules, [...had.rules, CREATED.rules.at(-1)]);
});

test('--dry-run says which checks it would add and adds nothing', () => {
  const { gh, calls } = projectWith({ rulesets: [ruleset({ rules: without('required_status_checks') })] });
  assert.deepEqual(run([REPO, '--dry-run'], gh), { code: 0, out: 'add required checks: unit, lint\n', err: '' });
  assert.deepEqual(writes(calls), []);
});

test('without admin rights a missing required check is reported with the command that adds it', () => {
  const had = ruleset({ rules: [...without('required_status_checks'), statusChecks('unit')] });
  const { gh, calls } = projectWith({ admin: false, rulesets: [had] });
  const result = run([REPO], gh);
  assert.equal(result.code, 0);
  const [said, command, ...rest] = result.out.trimEnd().split('\n');
  assert.deepEqual(rest, []);
  assert.equal(
    said,
    'The merge rule of owner/project (the ruleset "main merge gate") does not require the CI checks lint, and this account has no admin rights on the project to add them. ' +
      'The command sends the whole ruleset as it was read just now, with the checks added, so run it before the ruleset is changed again. Run this as an account that has them:',
  );
  const [, body] = command.match(/^printf '%s' '(.*)' \| gh api --method PUT repos\/owner\/project\/rulesets\/7 --input -$/);
  const sent = JSON.parse(body);
  assert.deepEqual(Object.keys(sent), ['name', 'target', 'enforcement', 'conditions', 'rules']);
  assert.deepEqual(sent.rules.slice(0, -1), had.rules.slice(0, -1));
  assert.deepEqual(sent.rules.at(-1).parameters.required_status_checks.map((c) => c.context), ['unit', 'lint']);
  assert.deepEqual(writes(calls), []);
});

test('without admin rights a rule that is weaker and lacks a check gets no command, which could undo the fix: the next run gives it', () => {
  const bypass = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
  for (const [changes, named] of [
    [{ enforcement: 'disabled' }, 'it is not active (enforcement: disabled)'],
    [{ current_user_can_bypass: 'always', bypass_actors: bypass }, 'this account can bypass it'],
    [{ rules: without('deletion') }, 'it lets the default branch be deleted'],
  ]) {
    const had = ruleset({ ...changes, rules: [...without('required_status_checks', changes.rules), statusChecks('unit')] });
    const { gh, calls } = projectWith({ admin: false, rulesets: [had] });
    assert.deepEqual(run([REPO], gh), {
      code: 0,
      out:
        `The merge rule of owner/project (the ruleset "main merge gate") is weaker than the kit's: ${named}. ` +
        'Install and sync never change these: put them right at https://github.com/owner/project/rules/7 ' +
        'It also does not require the CI checks lint: once the rest is right, the next install or sync adds them or gives the command that does.\n',
      err: '',
    });
    assert.deepEqual(writes(calls), []);
  }
});

test('a ruleset that covers more than the default branch is the rule only when whole: short of that the rule is missing, and the broad ruleset is never written to', () => {
  const allBranches = { ref_name: { exclude: [], include: ['~ALL'] } };
  const releasesToo = { ref_name: { exclude: [], include: ['refs/heads/main', 'refs/heads/release/*'] } };
  for (const admin of [true, false]) {
    for (const changes of [
      { conditions: allBranches, rules: [{ type: 'deletion' }] },
      { conditions: releasesToo, rules: without('required_status_checks') },
      { conditions: releasesToo, rules: [...without('required_status_checks'), statusChecks('unit')] },
      { conditions: allBranches, enforcement: 'disabled' },
    ]) {
      const { gh, calls } = projectWith({ admin, rulesets: [ruleset(changes)] });
      const result = run([REPO], gh);
      assert.equal(result.code, 0);
      if (admin) {
        assert.equal(result.out, 'create merge rule: requires the CI checks unit, lint\n');
        assert.deepEqual(writes(calls).map((call) => call.args.slice(2, 4)), [['POST', `repos/${REPO}/rulesets`]]);
        assert.deepEqual(JSON.parse(writes(calls)[0].input), CREATED);
      } else {
        const [said, command, ...rest] = result.out.trimEnd().split('\n');
        assert.deepEqual(rest, []);
        assert.match(said, /^owner\/project has no merge rule on its default branch, /);
        assert.deepEqual(JSON.parse(command.match(/^printf '%s' '(.*)' \| gh api --method POST repos\/owner\/project\/rulesets --input -$/)[1]), CREATED);
        assert.deepEqual(writes(calls), []);
      }
    }
    const whole = ruleset({ conditions: releasesToo });
    const { gh, calls } = projectWith({ admin, rulesets: [whole] });
    assert.match(run([REPO], gh).out, /^in place/);
    assert.deepEqual(writes(calls), []);
  }
});

test('a weaker rule that also lacks a check gets the check, and what is weaker is still reported', () => {
  const { gh, calls } = projectWith({ rulesets: [ruleset({ enforcement: 'disabled', rules: [...without('required_status_checks'), statusChecks('unit')] })] });
  const [added, reported] = run([REPO], gh).out.split(/(?<=^[^\n]*\n)/);
  assert.equal(added, 'add required checks: lint\n');
  assert.equal(reported.match(WEAKER)?.[1], 'it is not active (enforcement: disabled)');
  assert.equal(JSON.parse(writes(calls)[0].input).enforcement, 'disabled');
});

test("a rule stricter than the kit's is left as it is", () => {
  const stricter = ruleset({
    conditions: { ref_name: { exclude: [], include: ['~ALL'] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'required_linear_history' },
      { type: 'required_signatures' },
      { type: 'pull_request', parameters: { ...PULL_REQUEST, required_approving_review_count: 2, require_code_owner_review: true } },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: 'lint' }, { context: 'unit', integration_id: ACTIONS }, { context: 'security/scan', integration_id: 99 }],
        },
      },
    ],
  });
  const { gh, calls } = projectWith({ rulesets: [stricter] });
  assert.deepEqual(run([REPO], gh), { code: 0, out: 'in place\n', err: '' });
  assert.deepEqual(writes(calls), []);
});

test('a ruleset naming the default branch by its ref is the rule; one that leaves it out, or is of another kind, is not', () => {
  const byRef = ruleset({ conditions: { ref_name: { exclude: [], include: ['refs/heads/trunk'] } } });
  assert.equal(run([REPO], projectWith({ branch: 'trunk', rulesets: [byRef] }).gh).out, 'in place\n');
  for (const other of [
    ruleset({ conditions: { ref_name: { exclude: [], include: ['refs/heads/release/*'] } } }),
    ruleset({ conditions: { ref_name: { exclude: ['~DEFAULT_BRANCH'], include: ['~ALL'] } } }),
    ruleset({ conditions: { ref_name: { exclude: ['refs/heads/ma*'], include: ['~ALL'] } } }),
    ruleset({ target: 'tag' }),
    ruleset({ source_type: 'Organization' }),
    ruleset({ rules: [{ type: 'required_signatures' }] }),
  ]) {
    const { gh, calls } = projectWith({ rulesets: [other] });
    assert.equal(run([REPO], gh).out, 'create merge rule: requires the CI checks unit, lint\n', JSON.stringify(other));
    assert.equal(writes(calls).length, 1);
  }
});

const judged = (out) => out.match(/the ruleset "([^"]*)"/)?.[1];
const everyBranch = { ref_name: { exclude: [], include: ['~ALL'] } };

test('with several rulesets on the default branch, a whole one means in place whatever the others lack', () => {
  const partial = ruleset({ id: 3, name: 'no force-push', rules: [{ type: 'non_fast_forward' }] });
  for (const whole of [ruleset(), ruleset({ conditions: everyBranch })]) {
    for (const rulesets of [[partial, whole], [whole, partial]]) {
      const { gh, calls } = projectWith({ rulesets });
      assert.equal(run([REPO], gh).out, 'in place\n');
      assert.deepEqual(writes(calls), []);
    }
  }
});

test('a ruleset in force is judged before a whole one that is not: a disabled draft does not hide the live rule', () => {
  const live = ruleset({ id: 1, name: 'live', rules: without('required_status_checks') });
  const draft = ruleset({ id: 2, name: 'draft', enforcement: 'disabled' });
  for (const rulesets of [[live, draft], [draft, live]]) {
    const { gh, calls } = projectWith({ rulesets });
    assert.equal(run([REPO], gh).out, 'add required checks: unit, lint\n');
    assert.equal(writes(calls)[0].args[3], `repos/${REPO}/rulesets/1`);
    assert.equal(judged(run([REPO], projectWith({ admin: false, rulesets }).gh).out), 'live');
  }
});

test('a broader ruleset that falls short is passed over for one for the default branch alone; among those, the one that lacks least is judged', () => {
  const lacking = without('required_status_checks');
  const broad = ruleset({ id: 1, name: 'all branches', conditions: everyBranch, rules: lacking });
  const own = ruleset({ id: 2, name: 'default branch', rules: without('deletion', lacking) });
  for (const rulesets of [[broad, own], [own, broad]]) {
    const { gh, calls } = projectWith({ rulesets });
    assert.equal(judged(run([REPO], gh).out), 'default branch');
    assert.deepEqual(writes(calls).map((call) => call.args[3]), [`repos/${REPO}/rulesets/2`]);
  }
  const closer = ruleset({ id: 3, name: 'closer', rules: lacking });
  for (const rulesets of [[own, closer], [closer, own]]) {
    const { gh, calls } = projectWith({ rulesets });
    assert.equal(run([REPO], gh).out, 'add required checks: unit, lint\n');
    assert.equal(writes(calls)[0].args[3], `repos/${REPO}/rulesets/3`);
  }
});

test('a project with no CI workflow gets the rule without required checks, and is told its jobs are not required', () => {
  const { gh, calls } = projectWith({ workflow: null });
  const told =
    "owner/project's CI workflow (.github/workflows/ci.yml on main) is missing, so the merge rule cannot require its jobs. " +
    'They become required at the next install or sync after that is put right.\n';
  assert.deepEqual(run([REPO], gh), { code: 0, out: `create merge rule: no required checks\n${told}`, err: '' });
  assert.deepEqual(JSON.parse(writes(calls)[0].input), { ...CREATED, rules: CREATED.rules.slice(0, 3) });
  const after = projectWith({ workflow: null, rulesets: [ruleset({ rules: without('required_status_checks') })] });
  assert.deepEqual(run([REPO], after.gh), { code: 0, out: told, err: '' });
  assert.deepEqual(writes(after.calls), []);
});

test('a CI workflow that does not run on every pull request has none of its jobs required', () => {
  const filtered = CI.replace('  pull_request:\n', '  pull_request:\n    paths: [src/**]\n');
  const { gh, calls } = projectWith({ workflow: filtered, rulesets: [ruleset({ rules: without('required_status_checks') })] });
  assert.match(
    run([REPO], gh).out,
    /^owner\/project's CI workflow \(\.github\/workflows\/ci\.yml on main\) runs on some pull requests only: its pull_request trigger has filters, so the merge rule cannot require its jobs\. /,
  );
  assert.deepEqual(writes(calls), []);
});

test("a CI workflow whose pull_request trigger is filtered to the project's default branch still has its jobs required", () => {
  const workflow = CI.replace('  pull_request:\n', '  pull_request:\n    branches: [trunk]\n');
  assert.equal(run([REPO], projectWith({ workflow, branch: 'trunk', rulesets: [ruleset()] }).gh).out, 'in place\n');
  assert.match(run([REPO], projectWith({ workflow, branch: 'main', rulesets: [ruleset()] }).gh).out, /runs on some pull requests only/);
});

test('a rule that still requires the jobs of a workflow that no longer runs on every pull request, or is gone, is said to leave pull requests waiting', () => {
  const filtered = CI.replace('  pull_request:\n', '  pull_request:\n    paths: [src/**]\n');
  const rules = [...without('required_status_checks'), statusChecks('unit', 'lint', 'security/scan')];
  const waits = (problem, checks) =>
    `owner/project's CI workflow (.github/workflows/ci.yml on main) ${problem}, and the merge rule (the ruleset "main merge gate") still requires the checks ${checks}. ` +
    'A pull request that nothing reports them on waits for them and cannot merge: put the workflow right, or take them out of the ruleset at https://github.com/owner/project/rules/7\n';
  const some = projectWith({ workflow: filtered, rulesets: [ruleset({ rules })] });
  assert.deepEqual(run([REPO], some.gh), { code: 0, out: waits('runs on some pull requests only: its pull_request trigger has filters', 'unit, lint'), err: '' });
  const gone = projectWith({ workflow: null, rulesets: [ruleset({ rules })] });
  assert.deepEqual(run([REPO], gone.gh), { code: 0, out: waits('is missing', 'unit, lint, security/scan'), err: '' });
  assert.deepEqual([...writes(some.calls), ...writes(gone.calls)], []);
});

test('a CI job whose check names are not certain is not required, and the owner is told which and why', () => {
  const matrix = `${CI}  browsers:\n    strategy:\n      matrix:\n        browser: [firefox, chromium]\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run e2e\n`;
  const told =
    'The merge rule does not cover the CI job browsers of owner/project (.github/workflows/ci.yml on main): ' +
    'it has a matrix, and reports one check for each combination. Requiring its checks in the rule is yours.\n';
  const { gh, calls } = projectWith({ workflow: matrix });
  assert.deepEqual(run([REPO], gh), { code: 0, out: `create merge rule: requires the CI checks unit, lint\n${told}`, err: '' });
  assert.deepEqual(JSON.parse(writes(calls)[0].input), CREATED);
  const byHand = statusChecks('unit', 'lint', 'browsers (firefox)', 'browsers (chromium)');
  const after = projectWith({ workflow: matrix, rulesets: [ruleset({ rules: [...without('required_status_checks'), byHand] })] });
  assert.deepEqual(run([REPO], after.gh), { code: 0, out: told, err: '' });
  assert.deepEqual(writes(after.calls), []);
});

test('nothing it asks of GitHub can loosen a rule: every rule, check and setting it read is in what it sends', () => {
  const bypass = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
  for (const had of [
    ruleset({ rules: [statusChecks('other')] }),
    ruleset({ rules: [{ type: 'pull_request', parameters: { ...PULL_REQUEST, required_approving_review_count: 3 } }, { type: 'required_signatures' }] }),
    ruleset({
      enforcement: 'disabled',
      bypass_actors: bypass,
      conditions: { ref_name: { exclude: ['refs/heads/scratch'], include: ['refs/heads/main', '~DEFAULT_BRANCH'] } },
      rules: [{ type: 'deletion' }, statusChecks('unit', 'other')],
    }),
  ]) {
    const { gh, calls } = projectWith({ rulesets: [had] });
    run([REPO], gh);
    const [{ args, input }, ...others] = writes(calls);
    assert.deepEqual(others, []);
    assert.equal(args[2], 'PUT');
    const sent = JSON.parse(input);
    for (const key of ['name', 'target', 'enforcement', 'conditions', 'bypass_actors']) assert.deepEqual(sent[key], had[key], key);
    for (const rule of had.rules) {
      const kept = sent.rules.find((r) => r.type === rule.type);
      const { required_status_checks: checks = [], ...parameters } = rule.parameters ?? {};
      const { required_status_checks: keptChecks = [], ...keptParameters } = kept.parameters ?? {};
      assert.deepEqual(keptParameters, parameters, rule.type);
      assert.deepEqual(keptChecks.slice(0, checks.length), checks);
    }
    assert.equal(sent.rules.length, had.rules.length + (had.rules.some((r) => r.type === 'required_status_checks') ? 0 : 1));
  }
});

test('when GitHub cannot be read it exits 1 saying what could not be read, and changes nothing', () => {
  const refused = run([REPO], fakeGh(() => ({ code: 1, stderr: 'HTTP 401: Bad credentials\n' })).gh);
  assert.deepEqual(refused, { code: 1, out: '', err: 'could not read the repository of owner/project: HTTP 401: Bad credentials\n' });
  const project = projectWith();
  const noWorkflow = fakeGh((args) => (args.includes('-H') ? { code: 1, stderr: 'HTTP 502\n' } : project.gh(args)));
  assert.deepEqual(run([REPO], noWorkflow.gh), { code: 1, out: '', err: 'could not read the CI workflow of owner/project: HTTP 502\n' });
  assert.deepEqual(writes(noWorkflow.calls), []);
  const noRulesets = fakeGh((args) => (args.at(-1).includes('/rulesets') ? { stdout: '<html>' } : project.gh(args)));
  assert.deepEqual(run([REPO], noRulesets.gh), { code: 1, out: '', err: "could not read the rulesets of owner/project: GitHub's answer is not JSON\n" });
});

test('when GitHub refuses the change it exits 1 with what gh said, and leaves the change to the owner as it would without admin rights', () => {
  const created = run([REPO], projectWith({ refuse: 'HTTP 403: Resource not accessible\n' }).gh);
  assert.equal(created.code, 1);
  assert.equal(created.err, 'could not create the merge rule on owner/project: HTTP 403: Resource not accessible\n');
  const [said, command, ...rest] = created.out.trimEnd().split('\n');
  assert.deepEqual(rest, []);
  assert.equal(said, 'owner/project has no merge rule on its default branch, and GitHub refused this account when it tried to add it. Run this as an account that has admin rights on the project:');
  assert.deepEqual(JSON.parse(command.match(/^printf '%s' '(.*)' \| gh api --method POST repos\/owner\/project\/rulesets --input -$/)[1]), CREATED);

  const added = run([REPO], projectWith({ refuse: 'HTTP 422\n', rulesets: [ruleset({ rules: without('required_status_checks') })] }).gh);
  assert.equal(added.code, 1);
  assert.equal(added.err, 'could not add required checks to the merge rule of owner/project: HTTP 422\n');
  assert.match(
    added.out,
    /^The merge rule of owner\/project \(the ruleset "main merge gate"\) does not require the CI checks unit, lint, and GitHub refused this account when it tried to add them\. .* Run this as an account that has admin rights on the project:\nprintf '%s' '.*' \| gh api --method PUT repos\/owner\/project\/rulesets\/7 --input -\n$/,
  );

  const weaker = run([REPO], projectWith({ refuse: 'HTTP 422\n', rulesets: [ruleset({ enforcement: 'disabled', rules: without('required_status_checks') })] }).gh);
  assert.equal(weaker.code, 1);
  assert.match(weaker.out, /is weaker than the kit's: it is not active .* It also does not require the CI checks unit, lint: once the rest is right, /);
  assert.doesNotMatch(weaker.out, /printf|add required checks:/);
});

test('bad arguments exit 2', () => {
  for (const argv of [[], ['nope'], [REPO, 'extra'], ['--dry-run']]) {
    const result = run(argv, projectWith().gh);
    assert.equal(result.code, 2);
    assert.match(result.err, /^usage: /);
  }
});
