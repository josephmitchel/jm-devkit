import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ciChecks } from './ci-checks.mjs';

const workflow = (jobs, on = 'on:\n  pull_request:\n  push:\n    branches: [main]\n') => `name: CI\n\n${on}\npermissions:\n  contents: read\n\njobs:\n${jobs}`;

const STEPS = '    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Test\n        run: npm test\n';

const read = (text) => ciChecks(text, 'main');
const required = (...checks) => ({ checks, unsure: [], problem: null, unrun: [] });
const unsureJobs = (text) => read(text).unsure.map(({ job, why }) => `${job} ${why}`);

test("a plain job's check is named for the job's id", () => {
  const text = workflow(`  unit:\n${STEPS}\n  # the slow one\n  end-to-end:\n${STEPS}`);
  assert.deepEqual(read(text), required('unit', 'end-to-end'));
});

test('a job with a name reports under that name, however the name is quoted', () => {
  const text = workflow(
    `  unit:\n    name: Unit tests # every push\n${STEPS}` +
      `  types:\n    name: "Type check"\n${STEPS}` +
      `  lint:\n    name: 'It''s lint'\n${STEPS}` +
      `  sharp:\n    name: C# build\n${STEPS}` +
      `  word:\n    name: "true"\n${STEPS}`,
  );
  assert.deepEqual(read(text), required('Unit tests', 'Type check', "It's lint", 'C# build', 'true'));
});

test('a job whose steps sit at the same indent as `steps:` is read like any other', () => {
  const text = workflow('  unit:\n    runs-on: ubuntu-latest\n    steps:\n    - uses: actions/checkout@v4\n    - name: Test\n      run: npm test\n  lint:\n    name: Lint\n    steps:\n    - run: npm run lint\n');
  assert.deepEqual(read(text), required('unit', 'Lint'));
});

test('a job whose check names the text does not settle is left out and said to be unsure', () => {
  const text = workflow(
    `  plain:\n${STEPS}` +
      `  matrix:\n    strategy:\n      matrix:\n        node: [22, 24]\n${STEPS}` +
      '  called:\n    uses: ./.github/workflows/build.yml\n' +
      `  computed:\n    name: Test \${{ github.ref }}\n${STEPS}` +
      `  folded:\n    name: >\n      A long\n      name\n${STEPS}` +
      `  wrapped:\n    name: A long\n      name\n${STEPS}` +
      `  escaped:\n    name: "a \\"b\\""\n${STEPS}` +
      `  merged:\n    <<: *defaults\n${STEPS}` +
      `  anchored: &job\n${STEPS}` +
      '  inline: { runs-on: ubuntu-latest, steps: [] }\n' +
      '  spilled:\n    if: "github.actor != \'x\'\n    name: Fake"\n    runs-on: ubuntu-latest\n',
  );
  const { checks, problem } = read(text);
  assert.deepEqual(checks, ['plain']);
  assert.equal(problem, null);
  assert.deepEqual(unsureJobs(text), [
    'matrix has a matrix, and reports one check for each combination',
    'called calls another workflow, whose jobs name its checks',
    'computed has a name the kit cannot read for certain',
    'folded has a name the kit cannot read for certain',
    'wrapped has a name the kit cannot read for certain',
    'escaped has a name the kit cannot read for certain',
    'merged is written in a form the kit does not read',
    'anchored is written in a form the kit does not read',
    'inline is written in a form the kit does not read',
    'spilled is written in a form the kit does not read',
  ]);
});

test('a name YAML does not read as the string it looks like is unsure, not a check name', () => {
  const names = ['~', 'null', 'Null', '""', "''", 'true', 'False', 'yes', 'off', '1.0', '0x10', '010', '0o17', '1_000', '.5', '1e3', '-3', '.inf', '2026-11-22', '1:30', '- dash', '? q', 'a: b', '[x]'];
  const text = workflow(names.map((name, i) => `  job${i}:\n    name: ${name}\n${STEPS}`).join(''));
  assert.deepEqual(read(text).checks, []);
  assert.deepEqual(unsureJobs(text), names.map((_, i) => `job${i} has a name the kit cannot read for certain`));
});

test('a workflow that runs on every pull request into the default branch, however that is written, gives its jobs', () => {
  for (const on of [
    'on: pull_request\n',
    'on: [push, pull_request] # both\n',
    '"on":\n  - push\n  - pull_request\n',
    'on:\n- push\n- pull_request\n',
    'on:\n  push:\n  pull_request: {}\n',
    "'on':\n  pull_request:\n  workflow_dispatch:\n",
    'on:\n  pull_request:\n    branches: [main]\n',
    'on:\n  pull_request:\n    branches: [ release, "main" ] # both\n',
    "on:\n  pull_request:\n    branches:\n      - 'main'\n      - release\n",
    'on:\n  pull_request:\n    branches:\n    - main\n  push:\n',
    'on:\n  pull_request:\n    branches: main\n',
  ]) {
    assert.deepEqual(read(workflow(`  unit:\n${STEPS}`, on)), required('unit'), on);
  }
});

test('a workflow that does not run on every pull request gives no checks to require, says why, and says what its jobs would report', () => {
  const jobs = `  unit:\n${STEPS}  matrix:\n    strategy:\n      matrix:\n        node: [22, 24]\n${STEPS}`;
  const idle = (problem) => ({ checks: [], unsure: [], problem, unrun: ['unit'] });
  for (const on of ['on: push\n', 'on: [push, workflow_dispatch]\n', 'on:\n  push:\n    branches: [main]\n  pull_request_target:\n', 'on:\n  - push\n']) {
    assert.deepEqual(read(workflow(jobs, on)), idle('does not run on pull requests'), on);
  }
  for (const on of [
    'on:\n  pull_request:\n    paths: [src/**]\n',
    'on:\n  pull_request:\n    paths-ignore: [docs/**]\n',
    'on:\n  pull_request:\n    types: [labeled]\n',
    'on:\n  pull_request:\n    branches-ignore: [wip]\n',
    'on:\n  pull_request:\n    branches: [main]\n    paths: [src/**]\n',
    'on:\n  pull_request:\n    branches: [release]\n',
    'on:\n  pull_request:\n    branches: [ma*]\n',
    'on:\n  pull_request:\n    branches: ["**"]\n',
    'on:\n  pull_request:\n    branches: [main, "!main"]\n',
    'on:\n  pull_request:\n    branches:\n',
    'on:\n  pull_request: { branches: [main] }\n',
    'on:\n  push: &filters\n    branches: [main]\n  pull_request: *filters\n',
  ]) {
    assert.deepEqual(read(workflow(jobs, on)), idle('runs on some pull requests only: its pull_request trigger has filters'), on);
  }
  for (const on of ['on: { pull_request: {} }\n', '']) {
    assert.deepEqual(read(workflow(jobs, on)), idle('has triggers written in a form the kit does not read'), on);
  }
});

test('the default branch is the one a `branches` filter must name', () => {
  const on = 'on:\n  pull_request:\n    branches: [main]\n';
  assert.equal(ciChecks(workflow(`  unit:\n${STEPS}`, on), 'trunk').problem, 'runs on some pull requests only: its pull_request trigger has filters');
});

test('a workflow with no jobs to read says so', () => {
  assert.deepEqual(read('on: pull_request\n'), { checks: [], unsure: [], problem: 'has no jobs the kit can read', unrun: [] });
  assert.deepEqual(read(''), { checks: [], unsure: [], problem: 'has triggers written in a form the kit does not read', unrun: [] });
});

test('Windows line endings and blank lines change nothing', () => {
  const text = workflow(`  unit:\n\n    name: Unit\n${STEPS}`).replaceAll('\n', '\r\n');
  assert.deepEqual(read(text), required('Unit'));
});
