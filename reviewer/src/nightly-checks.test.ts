import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { outputTail } from './failure-report.js';
import { checksAccount, checksDecision, checksNamed, checksOwner, checkTimeoutMs, runChecks, type CheckResult } from './nightly-checks.js';
import { errorTypeLine } from './run-vocabulary.js';
import { leftBehind, planDatabases } from './test-databases.js';
import { checksWorkspacePath, workspacePath } from './workspace.js';

const canvas = { name: 'canvas', command: 'npm run canvas:check' };
const links = { name: 'links', command: 'npm run check:links' };
const slow = { name: 'slow', command: 'make slow-check' };

const passed = (name: string): CheckResult => ({ name, passed: true, how: 'exit 0', tail: '' });
const failed = (name: string, how = 'exit 1', tail = ''): CheckResult => ({ name, passed: false, how, tail });

describe("what a run of a project's nightly checks does next", () => {
  const checks = [canvas, links, slow];

  it('takes the checks in the order written, one at a time', () => {
    expect(checksDecision(checks, [])).toEqual({ next: canvas });
    expect(checksDecision(checks, [passed('canvas')])).toEqual({ next: links });
    expect(checksDecision(checks, [passed('canvas'), passed('links')])).toEqual({ next: slow });
  });

  it('carries on to the next check after one that failed', () => {
    expect(checksDecision(checks, [failed('canvas')])).toEqual({ next: links });
    expect(checksDecision(checks, [failed('canvas'), failed('links')])).toEqual({ next: slow });
  });

  it('ends succeeded when every check passed', () => {
    expect(checksDecision(checks, [passed('canvas'), passed('links'), passed('slow')])).toEqual({ done: 'succeeded' });
  });

  it('ends failed when any check failed, wherever it was', () => {
    expect(checksDecision(checks, [failed('canvas'), passed('links'), passed('slow')])).toEqual({ done: 'failed' });
    expect(checksDecision(checks, [passed('canvas'), passed('links'), failed('slow')])).toEqual({ done: 'failed' });
  });

  it('ends succeeded at once when there is no check to run', () => {
    expect(checksDecision([], [])).toEqual({ done: 'succeeded' });
  });
});

describe('whether a project names nightly checks, from the project config on its default branch', () => {
  const config = (nightly?: unknown) =>
    JSON.stringify({ modules: ['process'], reviewer: { tests: [{ name: 'unit', command: 'npm test' }] }, ...(nightly ? { nightly } : {}) });

  it('is the checks it lists, in the order written', () => {
    expect(checksNamed(config({ checks: [links, canvas] }))).toEqual([links, canvas]);
  });

  it('is none for a project that lists none, or has no project config at all', () => {
    expect(checksNamed(config())).toEqual([]);
    expect(checksNamed(config({ checks: [] }))).toEqual([]);
    expect(checksNamed(null)).toEqual([]);
  });

  it('is refused, naming the fault, when the project config is invalid', () => {
    expect(() => checksNamed(config({ checks: [{ name: 'canvas' }] }))).toThrow('nightly.checks[0].command is required');
  });
});

describe("where a project's nightly checks run and what they are given", () => {
  it('is a checkout of their own, so a run by hand never resets the tree under a review or a sweep of the same project', () => {
    const root = path.dirname(workspacePath('acme/widgets'));
    expect(checksWorkspacePath('acme/widgets')).toBe(path.join(root, 'checks', 'acme__widgets'));
    expect(checksWorkspacePath('acme/widgets')).not.toBe(workspacePath('acme/widgets'));
    // No project's checkout can be the directory the checks' checkouts are in: an owner and a name are always both there.
    expect(path.basename(workspacePath('checks/checks'))).not.toBe('checks');
  });

  it("are test databases of their own, not the sweep's, which are gone by the time the checks start", () => {
    const records = [
      { name: 'reviewer_test_aaaaaaaaaaaaaaaa_0', owner: 'sweep:7' },
      { name: 'reviewer_test_bbbbbbbbbbbbbbbb_0', owner: checksOwner('acme/widgets') },
      { name: 'reviewer_test_cccccccccccccccc_0', owner: checksOwner('acme/widgets-two') },
    ];
    expect(checksOwner('acme/widgets')).toBe('checks:acme/widgets');
    expect(leftBehind(records, checksOwner('acme/widgets'))).toEqual(['reviewer_test_bbbbbbbbbbbbbbbb_0']);
  });
});

describe("the account that ends a run of a project's nightly checks", () => {
  it('names each check that failed and how, with the end of what it wrote, and counts them last', () => {
    const results = [
      failed('canvas', 'exit 1', 'comparing 12 boards\n3 boards differ from the code\n'),
      passed('links'),
      failed('slow', 'stopped after 10 minutes', ''),
    ];
    expect(checksAccount(results)).toBe(
      [
        '--- canvas: failed (exit 1); the end of what it wrote ---',
        'comparing 12 boards',
        '3 boards differ from the code',
        '--- slow: failed (stopped after 10 minutes); the end of what it wrote ---',
        '(it wrote nothing)',
        '2 of 3 nightly check(s) failed: canvas, slow',
      ].join('\n'),
    );
  });

  it('is one line when every check passed', () => {
    expect(checksAccount([passed('canvas'), passed('links')])).toBe('all 2 nightly check(s) passed');
  });

  it("fits whole in the end of the run's output that reaches the project's issue, however much each check wrote", () => {
    const ID = 'run-20261120T031502Z-a1b2c3';
    const noisy = (name: string) =>
      failed(name, 'exit 1', Array.from({ length: 500 }, (_, i) => `${name} line ${i + 1} ${'.'.repeat(150)}`).join('\n') + `\n${name} said why it failed\n`);
    const later = `${'output of a later check that passed\n'.repeat(200)}`;
    const account = checksAccount([noisy('canvas'), passed('links'), noisy('slow'), noisy('types')]);
    // As the run's output file ends: the checks' own output, the account as the error's message
    // under the log's timestamp, then the line that names the type of error.
    const output = `${later}[2026-11-20T03:15:02.000Z] ${account}\n${errorTypeLine(ID, new Error('x'))}\n`;
    const tail = outputTail(output, undefined);
    for (const name of ['canvas', 'slow', 'types']) {
      expect(tail).toContain(`--- ${name}: failed (exit 1); the end of what it wrote ---`);
      expect(tail).toContain(`${name} said why it failed`);
    }
    expect(tail).toContain('3 of 4 nightly check(s) failed: canvas, slow, types');
  });
});

/** Real commands in a real directory: what a check is given and what is kept of it. */
describe("running a project's nightly checks in its checkout", () => {
  let checkout: string;
  let wrote: string;
  const write = (chunk: string) => {
    wrote += chunk;
  };
  const ended = (results: CheckResult[]) => results.map((r) => `${r.name}: ${r.passed ? 'passed' : `failed (${r.how})`}`);

  beforeEach(() => {
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-checks-'));
    wrote = '';
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  it('runs every check from the project root in the order written, and a failing one does not stop those after it', async () => {
    const nightlyChecks = [
      { name: 'first', command: 'echo one >> order.txt && echo first ran' },
      { name: 'broken', command: 'echo two >> order.txt; echo 3 boards differ; echo and said so on stderr >&2; exit 3' },
      { name: 'last', command: 'echo three >> order.txt' },
    ];
    const results = await runChecks(checkout, { nightlyChecks, env: {} }, write);
    expect(ended(results)).toEqual(['first: passed', 'broken: failed (exit 3)', 'last: passed']);
    expect(fs.readFileSync(path.join(checkout, 'order.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(results[1].tail).toContain('3 boards differ');
    expect(results[1].tail).toContain('and said so on stderr');
  });

  it("writes out everything a check wrote, passing or failing, for the run's output file", async () => {
    const nightlyChecks = [
      { name: 'quiet', command: 'echo all 12 boards match' },
      { name: 'broken', command: 'echo 3 boards differ >&2; exit 1' },
    ];
    await runChecks(checkout, { nightlyChecks, env: {} }, write);
    expect(wrote).toContain('all 12 boards match\n');
    expect(wrote).toContain('3 boards differ\n');
  });

  it("gives a check the project's env and its databases' addresses, and none of the code reviewer's credentials", async () => {
    const server = 'postgres://tests:s3cret@db.example:5433/postgres';
    vi.stubEnv('DATABASE_URL', 'postgres://reviewer:reviewer-pw@db.example/reviewer');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-secret');
    vi.stubEnv('GH_TOKEN', 'ghs_secret');
    vi.stubEnv('REVIEWER_APP_PRIVATE_KEY', 'the-app-key');
    vi.stubEnv('REVIEWER_TEST_DATABASES_URL', server);
    vi.stubEnv('REVIEWER_RUN_ID', 'run-20261120T031502Z-a1b2c3');
    const [database] = planDatabases(['APP_DATABASE_URL'], server, '0123456789abcdef');
    const env = { LOG_LEVEL: 'error', APP_DATABASE_URL: database.address };

    const results = await runChecks(checkout, { nightlyChecks: [{ name: 'env', command: 'env' }], env }, write);
    expect(ended(results)).toEqual(['env: passed']);
    const given = wrote.split('\n');
    expect(given).toContain('LOG_LEVEL=error');
    expect(given).toContain('APP_DATABASE_URL=postgres://tests:s3cret@db.example:5433/reviewer_test_0123456789abcdef_0_test');
    expect(wrote).not.toMatch(/reviewer-pw|sk-ant-oat-secret|ghs_secret|the-app-key|REVIEWER_|db\.example:5433\/postgres/);
  });

  it('fails a check that runs past the time a project command may take, and still runs the next', async () => {
    const nightlyChecks = [
      { name: 'stuck', command: 'echo started; exec sleep 30' },
      { name: 'after', command: 'true' },
    ];
    const results = await runChecks(checkout, { nightlyChecks, env: {} }, write, 300);
    expect(ended(results)).toEqual(['stuck: failed (stopped after 0 minutes)', 'after: passed']);
    expect(results[0].tail).toContain('started');
  }, 20_000);

  it('gives a check thirty minutes unless the machine is set otherwise, three times what a test suite gets', () => {
    expect(checkTimeoutMs({})).toBe(30 * 60 * 1000);
    expect(checkTimeoutMs({ REVIEWER_CHECK_TIMEOUT_MS: '5400000' })).toBe(90 * 60 * 1000);
    expect(checkTimeoutMs({ REVIEWER_CHECK_TIMEOUT_MS: 'soon' })).toBe(30 * 60 * 1000);
    expect(checkTimeoutMs({ REVIEWER_COMMAND_TIMEOUT_MS: '1000' })).toBe(30 * 60 * 1000);
  });

  it('fails a check whose command does not exist, as the shell reports it', async () => {
    const results = await runChecks(checkout, { nightlyChecks: [{ name: 'typo', command: 'no-such-command-here' }], env: {} }, write);
    expect(ended(results)).toEqual(['typo: failed (exit 127)']);
  });
});
