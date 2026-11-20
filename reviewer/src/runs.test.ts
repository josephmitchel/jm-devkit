import { describe, expect, it } from 'vitest';

import { DevkitConfigError } from '../../plugin/devkit-config.mjs';
import { errorType, errorTypeLine, newRunId, nightlyStatus, runOutputPath, runResult, type Run } from './runs.js';

const at = (line: string) => `[2026-11-20T03:15:02.000Z] ${line}`;
const ID = 'run-20261120T031502Z-a1b2c3';

describe('how a run ended, from what was seen of its command', () => {
  it('succeeded when the command exited zero', () => {
    const output = [
      at('sweep 12 created for acme/widgets (main from 0123456789)'),
      '',
      at('=== sweep state: intake ==='),
      '',
      at('=== sweep state: publishing ==='),
      at('sweep 12 done for acme/widgets'),
      'outcome: swept',
    ].join('\n');
    expect(runResult(ID, { exitCode: 0, signal: null, output })).toEqual({ state: 'succeeded', stage: null, errorType: null });
  });

  it('failed in the stage it had reached, with the type of the error the command reported', () => {
    const output = [
      at('=== sweep state: intake ==='),
      at('=== sweep state: judging ==='),
      at('=== sweep state: auditing ==='),
      at('=== sweep state: failed ==='),
      at('devkit.json is malformed: reviewer is required'),
      `${ID} error type: DevkitConfigError`,
    ].join('\n');
    expect(runResult(ID, { exitCode: 1, signal: null, output })).toEqual({
      state: 'failed',
      stage: 'auditing',
      errorType: 'DevkitConfigError',
    });
  });

  it('failed in the stage a resumed run was in when it got no further', () => {
    const output = [
      at('resuming sweep 12 for acme/widgets in state synthesizing'),
      at('=== sweep state: failed ==='),
      at('setup command failed:'),
      'npm error code E404',
      `${ID} error type: Error`,
    ].join('\n');
    expect(runResult(ID, { exitCode: 1, signal: null, output })).toMatchObject({ state: 'failed', stage: 'synthesizing' });
  });

  it('reads the stages of a review as it reads those of a sweep', () => {
    const output = [
      at('resuming review 7 for acme/widgets#42 in state failed'),
      at('=== state: fixing ==='),
      at('=== state: failed ==='),
      `${ID} error type: Error`,
    ].join('\n');
    expect(runResult(ID, { exitCode: 1, signal: null, output })).toMatchObject({ state: 'failed', stage: 'fixing' });
  });

  it("reads the stages of a run of a project's nightly checks", () => {
    const output = [
      at('=== checks state: setup ==='),
      at('=== checks state: checking ==='),
      '3 boards differ from the code',
      at('1 of 2 nightly checks failed: canvas'),
      `${ID} error type: NightlyCheckError`,
    ].join('\n');
    expect(runResult(ID, { exitCode: 1, signal: null, output })).toEqual({
      state: 'failed',
      stage: 'checking',
      errorType: 'NightlyCheckError',
    });
    expect(runResult(ID, { exitCode: 1, signal: null, output: at('=== checks state: setup ===') })).toMatchObject({ stage: 'setup' });
  });

  it("takes no stage from a line that names none of the code reviewer's own, such as one in a project's output", () => {
    const output = [
      at('=== sweep state: intake ==='),
      at('=== sweep state: failed ==='),
      at('setup command failed:'),
      '=== sweep state: acme_widgets_secret ===',
      `${ID} error type: Error`,
    ].join('\n');
    expect(runResult(ID, { exitCode: 1, signal: null, output })).toMatchObject({ stage: 'intake' });
  });

  it('failed while starting when it stopped before any stage', () => {
    const output = [at('repo acme/widgets not registered — run: code-reviewer repo add acme/widgets …'), `${ID} error type: Error`].join('\n');
    expect(runResult(ID, { exitCode: 1, signal: null, output })).toEqual({
      state: 'failed',
      stage: 'starting',
      errorType: 'Error',
    });
  });

  it('names the exit code when the command reported no error of its own', () => {
    const output = at('=== sweep state: intake ===');
    expect(runResult(ID, { exitCode: 137, signal: null, output })).toEqual({
      state: 'failed',
      stage: 'intake',
      errorType: 'exit 137',
    });
  });

  it('names the signal when the command was killed', () => {
    const output = [at('=== sweep state: intake ==='), at('=== sweep state: auditing ===')].join('\n');
    expect(runResult(ID, { exitCode: null, signal: 'SIGTERM', output })).toEqual({
      state: 'failed',
      stage: 'auditing',
      errorType: 'killed by SIGTERM',
    });
  });

  it('failed while starting when the command could not be started at all', () => {
    expect(runResult(ID, { exitCode: null, signal: null, output: '' })).toEqual({
      state: 'failed',
      stage: 'starting',
      errorType: 'could not start',
    });
  });
});

describe('the type of an error', () => {
  it("is the error's class, which the run that started a command reads back from the command's last line", () => {
    const thrown = new DevkitConfigError('devkit.json is malformed: reviewer is required');
    const output = `${at(thrown.message)}\n${errorTypeLine(ID, thrown)}`;
    expect(runResult(ID, { exitCode: 1, signal: null, output })).toMatchObject({ errorType: 'DevkitConfigError' });
    expect(errorType(new TypeError('x is not a function'))).toBe('TypeError');
  });

  it("is not taken from a line a project's command printed, which cannot know the run id", () => {
    const output = [
      at('=== sweep state: intake ==='),
      at('setup command failed:'),
      'error type: acme/widgets',
      'run-20261120T031502Z-ffffff error type: Forged',
    ].join('\n');
    expect(runResult(ID, { exitCode: null, signal: 'SIGTERM', output })).toMatchObject({ errorType: 'killed by SIGTERM' });
  });

  it('never carries text of the thrower\'s choosing', () => {
    const named = Object.assign(new Error('boom'), { name: 'acme/widgets: src/secret.ts' });
    expect(errorType(named)).toBe('Error');
    expect(errorType('a thrown string')).toBe('Error');
  });
});

describe('a run id', () => {
  it('carries the time the run started and names no project', () => {
    expect(newRunId(new Date('2026-11-20T03:15:02.987Z'), 'a1b2c3')).toBe('run-20261120T031502Z-a1b2c3');
  });

  it('differs between two runs started in the same instant', () => {
    const now = new Date('2026-11-20T03:15:02Z');
    expect(newRunId(now)).not.toBe(newRunId(now));
  });
});

describe("where a run's output is kept", () => {
  const id = 'run-20261120T031502Z-a1b2c3';

  it("is a file named by the run id under the code reviewer's state directory", () => {
    expect(runOutputPath(id, { REVIEWER_STATE_DIR: '/var/lib/code-reviewer' }, '/home/reviewer')).toBe(
      '/var/lib/code-reviewer/runs/run-20261120T031502Z-a1b2c3.log',
    );
  });

  it("is under the user's own state directory when none is set", () => {
    expect(runOutputPath(id, {}, '/home/reviewer')).toBe(
      '/home/reviewer/.local/state/code-reviewer/runs/run-20261120T031502Z-a1b2c3.log',
    );
  });

  it("refuses a state directory inside the projects' checkouts, where a project's commands run", () => {
    const env = { REVIEWER_WORKSPACE_ROOT: '/srv/checkouts', REVIEWER_STATE_DIR: '/srv/checkouts/state' };
    expect(() => runOutputPath(id, env, '/home/reviewer')).toThrow(/REVIEWER_STATE_DIR .* inside .*\/srv\/checkouts/);
    expect(() => runOutputPath(id, { ...env, REVIEWER_STATE_DIR: '/srv/checkouts' }, '/home/reviewer')).toThrow();
  });
});

describe('the recent nightly runs in status', () => {
  const run = (id: string, fields: Partial<Run>): Run => ({
    id,
    kind: 'sweep',
    project: null,
    parentId: null,
    state: 'succeeded',
    stage: null,
    errorType: null,
    startedAt: new Date('2026-11-20T03:15:02Z'),
    finishedAt: new Date('2026-11-20T04:15:02Z'),
    ...fields,
  });
  const outputAt = (id: string) => `/var/lib/code-reviewer/runs/${id}.log`;
  const rows = [
    run('run-20261120T031502Z-aaaaaa', { kind: 'nightly', state: 'failed' }),
    run('run-20261120T031503Z-bbbbbb', { project: 'acme/anvils', parentId: 'run-20261120T031502Z-aaaaaa' }),
    run('run-20261120T041503Z-cccccc', {
      project: 'acme/widgets',
      parentId: 'run-20261120T031502Z-aaaaaa',
      state: 'failed',
      stage: 'auditing',
      errorType: 'DevkitConfigError',
    }),
    run('run-20261119T031500Z-dddddd', { kind: 'nightly', state: 'failed', stage: 'finding the projects', errorType: 'Error' }),
    run('run-20261118T031500Z-eeeeee', { kind: 'nightly' }),
    run('run-20261118T031501Z-ffffff', { project: 'acme/widgets', parentId: 'run-20261118T031500Z-eeeeee' }),
  ];

  it("lists each nightly run with every project's result, and where a failed run's output is", () => {
    expect(nightlyStatus(rows, outputAt)).toEqual([
      'nightly runs',
      '  run-20261120T031502Z-aaaaaa [failed]',
      '    acme/anvils sweep [succeeded] run-20261120T031503Z-bbbbbb',
      '    acme/widgets sweep [failed in auditing: DevkitConfigError] run-20261120T041503Z-cccccc' +
        ', output: /var/lib/code-reviewer/runs/run-20261120T041503Z-cccccc.log',
      '  run-20261119T031500Z-dddddd [failed in finding the projects: Error]' +
        ', output: /var/lib/code-reviewer/runs/run-20261119T031500Z-dddddd.log',
      '  run-20261118T031500Z-eeeeee [succeeded]',
      '    acme/widgets sweep [succeeded] run-20261118T031501Z-ffffff',
    ]);
  });

  it('shows a run that has not finished as running', () => {
    const unfinished = [
      run('run-20261120T031502Z-aaaaaa', { kind: 'nightly', state: 'running', finishedAt: null }),
      run('run-20261120T031503Z-bbbbbb', {
        project: 'acme/anvils',
        parentId: 'run-20261120T031502Z-aaaaaa',
        state: 'running',
        finishedAt: null,
      }),
    ];
    expect(nightlyStatus(unfinished, outputAt)).toEqual([
      'nightly runs',
      '  run-20261120T031502Z-aaaaaa [running]',
      '    acme/anvils sweep [running] run-20261120T031503Z-bbbbbb',
    ]);
  });

  it('says so when there has been no nightly run', () => {
    expect(nightlyStatus([], outputAt)).toEqual(['nightly runs: none yet']);
  });
});
