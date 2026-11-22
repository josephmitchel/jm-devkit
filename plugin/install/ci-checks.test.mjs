import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ciChecks } from './ci-checks.mjs';

const workflow = (jobs, on = 'on:\n  pull_request:\n  push:\n    branches: [main]\n') => `name: CI\n\n${on}\npermissions:\n  contents: read\n\njobs:\n${jobs}`;

const STEPS = '    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Test\n        run: npm test\n';

test("a plain job's check is named for the job's id", () => {
  const text = workflow(`  unit:\n${STEPS}\n  # the slow one\n  end-to-end:\n${STEPS}`);
  assert.deepEqual(ciChecks(text), { checks: ['unit', 'end-to-end'], unsure: [], problem: null });
});

test('a job with a name reports under that name, however the name is quoted', () => {
  const text = workflow(
    `  unit:\n    name: Unit tests # every push\n${STEPS}` +
      `  types:\n    name: "Type check"\n${STEPS}` +
      `  lint:\n    name: 'It''s lint'\n${STEPS}`,
  );
  assert.deepEqual(ciChecks(text), { checks: ['Unit tests', 'Type check', "It's lint"], unsure: [], problem: null });
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
      '  inline: { runs-on: ubuntu-latest, steps: [] }\n',
  );
  const { checks, unsure, problem } = ciChecks(text);
  assert.deepEqual(checks, ['plain']);
  assert.equal(problem, null);
  assert.deepEqual(
    unsure.map(({ job, why }) => `${job} ${why}`),
    [
      'matrix has a matrix, and reports one check for each combination',
      'called calls another workflow, whose jobs name its checks',
      'computed has a name the kit cannot read for certain',
      'folded has a name the kit cannot read for certain',
      'wrapped has a name the kit cannot read for certain',
      'escaped has a name the kit cannot read for certain',
      'merged is written in a form the kit does not read',
      'anchored is written in a form the kit does not read',
      'inline is written in a form the kit does not read',
    ],
  );
});

test('a workflow that runs on every pull request, however that is written, gives its jobs', () => {
  for (const on of [
    'on: pull_request\n',
    'on: [push, pull_request] # both\n',
    '"on":\n  - push\n  - pull_request\n',
    'on:\n  push:\n  pull_request: {}\n',
    "'on':\n  pull_request:\n  workflow_dispatch:\n",
  ]) {
    assert.deepEqual(ciChecks(workflow(`  unit:\n${STEPS}`, on)), { checks: ['unit'], unsure: [], problem: null }, on);
  }
});

test('a workflow that does not run on every pull request gives no checks and says why', () => {
  const jobs = `  unit:\n${STEPS}`;
  for (const on of ['on: push\n', 'on: [push, workflow_dispatch]\n', 'on:\n  push:\n    branches: [main]\n  pull_request_target:\n', 'on:\n  - push\n']) {
    assert.deepEqual(ciChecks(workflow(jobs, on)), { checks: [], unsure: [], problem: 'does not run on pull requests' }, on);
  }
  for (const on of ['on:\n  pull_request:\n    paths: [src/**]\n', 'on:\n  pull_request:\n    types: [labeled]\n', 'on:\n  pull_request: { branches: [main] }\n']) {
    assert.deepEqual(ciChecks(workflow(jobs, on)), { checks: [], unsure: [], problem: 'runs on some pull requests only: its pull_request trigger has filters' }, on);
  }
  for (const on of ['on: { pull_request: {} }\n', '']) {
    assert.deepEqual(ciChecks(workflow(jobs, on)), { checks: [], unsure: [], problem: 'has triggers written in a form the kit does not read' }, on);
  }
});

test('a workflow with no jobs to read says so', () => {
  assert.deepEqual(ciChecks('on: pull_request\n'), { checks: [], unsure: [], problem: 'has no jobs the kit can read' });
  assert.deepEqual(ciChecks(''), { checks: [], unsure: [], problem: 'has triggers written in a form the kit does not read' });
});

test('Windows line endings and blank lines change nothing', () => {
  const text = workflow(`  unit:\n\n    name: Unit\n${STEPS}`).replaceAll('\n', '\r\n');
  assert.deepEqual(ciChecks(text), { checks: ['Unit'], unsure: [], problem: null });
});
