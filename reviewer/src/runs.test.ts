import { describe, expect, it } from 'vitest';

import { DevkitConfigError } from '../../plugin/devkit-config.mjs';
import { errorType, errorTypeLine } from './run-vocabulary.js';
import {
  afterInterruption,
  commandArgs,
  leftByNightlyRuns,
  newRunId,
  nightlyStatus,
  otherRunsStatus,
  runOutputPath,
  runResult,
  timeLimitMs,
  type Run,
} from './runs.js';

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
    const output = [at('connect ECONNREFUSED 127.0.0.1:5432'), `${ID} error type: Error`].join('\n');
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

describe('a run that was stopped before its command finished', () => {
  const output = [at('=== sweep state: intake ==='), at('=== sweep state: auditing ===')].join('\n');

  it('is interrupted, not failed, when its time limit stopped it', () => {
    expect(runResult(ID, { exitCode: null, signal: 'SIGTERM', output, stopped: 'time limit' })).toEqual({
      state: 'interrupted',
      stage: 'auditing',
      errorType: 'time limit',
    });
  });

  it('is interrupted when the service was stopping, even if the command had to be killed outright', () => {
    expect(runResult(ID, { exitCode: null, signal: 'SIGKILL', output, stopped: 'service stopped' })).toEqual({
      state: 'interrupted',
      stage: 'auditing',
      errorType: 'service stopped',
    });
  });

  it('succeeded all the same when the command had finished by the time it was told to stop', () => {
    expect(runResult(ID, { exitCode: 0, signal: null, output, stopped: 'service stopped' })).toMatchObject({ state: 'succeeded' });
  });
});

describe("a command's arguments", () => {
  const of = (command: Parameters<typeof commandArgs>[0]['command'], pr: number | null = null) =>
    commandArgs({ command, project: 'acme/widgets', pr }).join(' ');

  it('are the command and its project, for a command that is the whole project\'s', () => {
    expect(of('sweep')).toBe('sweep acme/widgets');
    expect(of('summary')).toBe('summary acme/widgets');
    expect(of('checks')).toBe('checks acme/widgets');
  });

  it('name the pull request, for a command that is one pull request\'s', () => {
    expect(of('landed', 12)).toBe('landed acme/widgets 12');
    expect(of('carry-gate', 12)).toBe('carry-gate acme/widgets 12');
  });

  it('run a review to return, not to wait', () => {
    expect(of('run', 12)).toBe('run acme/widgets 12 --once');
  });
});

describe("a command's time limit", () => {
  it('is five and a half hours for a job that runs agents: a sweep or a review', () => {
    expect(timeLimitMs({ command: 'sweep' }, {})).toBe(19_800_000);
    expect(timeLimitMs({ command: 'run' }, {})).toBe(19_800_000);
  });

  it('is ten minutes for a step that runs no agents and only talks to GitHub, so one call that hangs cannot hold a pass or the night', () => {
    expect(timeLimitMs({ command: 'landed' }, {})).toBe(600_000);
    expect(timeLimitMs({ command: 'carry-gate' }, {})).toBe(600_000);
    expect(timeLimitMs({ command: 'summary' }, {})).toBe(600_000);
  });

  it("is none for a project's nightly checks as a whole: each check has a limit of its own", () => {
    expect(timeLimitMs({ command: 'checks' }, {})).toBeNull();
  });

  it('is not the agent jobs\' setting for a step that runs no agents', () => {
    expect(timeLimitMs({ command: 'landed' }, { REVIEWER_AGENT_JOB_LIMIT_MS: '2000' })).toBe(600_000);
  });

  it('can be set for the machine, and a setting that is no number of milliseconds is ignored', () => {
    expect(timeLimitMs({ command: 'sweep' }, { REVIEWER_AGENT_JOB_LIMIT_MS: '2000' })).toBe(2000);
    expect(timeLimitMs({ command: 'sweep' }, { REVIEWER_AGENT_JOB_LIMIT_MS: 'soon' })).toBe(19_800_000);
    expect(timeLimitMs({ command: 'sweep' }, { REVIEWER_AGENT_JOB_LIMIT_MS: '0' })).toBe(19_800_000);
  });
});

describe('what an interrupted command needs before its work can be taken up again', () => {
  it('is nothing for a sweep, which resumes from its own recorded state when it is next run', () => {
    expect(afterInterruption({ command: 'sweep', project: 'acme/widgets', pr: null }, 'time limit')).toBeNull();
  });

  it("is the review recorded as stopped mid-stage, so the next run retries the stage and the project's slot is free", () => {
    expect(afterInterruption({ command: 'run', project: 'acme/widgets', pr: 42 }, 'service stopped')).toEqual([
      'abandon',
      'acme/widgets',
      '42',
      'the run on the machine was interrupted (service stopped)',
    ]);
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

describe('the runs a starting nightly run finds still recorded as running', () => {
  const running = { state: 'running', finishedAt: null } as const;

  it('are an earlier nightly run and its parts, whose process died before it could record them', () => {
    const rows = [
      run('run-20261119T031500Z-aaaaaa', { kind: 'nightly', ...running }),
      run('run-20261119T031501Z-bbbbbb', { project: 'acme/anvils', parentId: 'run-20261119T031500Z-aaaaaa' }),
      run('run-20261119T041501Z-cccccc', { project: 'acme/widgets', parentId: 'run-20261119T031500Z-aaaaaa', ...running }),
    ];
    expect(leftByNightlyRuns(rows).map((r) => r.id)).toEqual(['run-20261119T031500Z-aaaaaa', 'run-20261119T041501Z-cccccc']);
  });

  it('are not a run that is no part of a nightly run, which may be going on beside this one', () => {
    const rows = [run('run-20261120T031000Z-dddddd', { project: 'acme/widgets', ...running })];
    expect(leftByNightlyRuns(rows)).toEqual([]);
  });
});

describe('the recent nightly runs in status', () => {
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

  it('shows an interrupted run with the stage it had reached and what stopped it', () => {
    const interrupted = [
      run('run-20261120T031502Z-aaaaaa', { kind: 'nightly', state: 'interrupted', errorType: 'service stopped' }),
      run('run-20261120T031503Z-bbbbbb', {
        project: 'acme/anvils',
        parentId: 'run-20261120T031502Z-aaaaaa',
        state: 'interrupted',
        stage: 'auditing',
        errorType: 'time limit',
      }),
    ];
    expect(nightlyStatus(interrupted, outputAt)).toEqual([
      'nightly runs',
      '  run-20261120T031502Z-aaaaaa [interrupted: service stopped]' +
        ', output: /var/lib/code-reviewer/runs/run-20261120T031502Z-aaaaaa.log',
      '    acme/anvils sweep [interrupted in auditing: time limit] run-20261120T031503Z-bbbbbb' +
        ', output: /var/lib/code-reviewer/runs/run-20261120T031503Z-bbbbbb.log',
    ]);
  });

  it('says so when there has been no nightly run', () => {
    expect(nightlyStatus([], outputAt)).toEqual(['nightly runs: none yet']);
  });
});

describe('what status shows of the runs that are part of no nightly run and were started for no event', () => {
  const outputAt = (runId: string) => `/var/lib/code-reviewer/runs/${runId}.log`;
  const startedForEvents = new Set(['landed', 'carry-gate', 'review'] as const);
  const row = (id: string, fields: Partial<Run>): Run => ({
    id,
    kind: 'checks',
    project: 'acme/widgets',
    parentId: null,
    state: 'succeeded',
    stage: null,
    errorType: null,
    startedAt: new Date('2026-11-20T10:00:00Z'),
    finishedAt: new Date('2026-11-20T10:05:00Z'),
    ...fields,
  });

  it("lists a project's nightly checks run by hand, with how each ended", () => {
    const rows = [
      row('run-20261120T100000Z-aaaaaa', {}),
      row('run-20261119T100000Z-bbbbbb', { state: 'failed', stage: 'checking', errorType: 'NightlyCheckError' }),
    ];
    expect(otherRunsStatus(rows, startedForEvents, outputAt)).toEqual([
      'runs started by hand',
      '  acme/widgets checks [succeeded] run-20261120T100000Z-aaaaaa',
      '  acme/widgets checks [failed in checking: NightlyCheckError] run-20261119T100000Z-bbbbbb' +
        ', output: /var/lib/code-reviewer/runs/run-20261119T100000Z-bbbbbb.log',
    ]);
  });

  it('leaves out what the other sections show: nightly runs, their parts, and the runs a pass or the queue started', () => {
    const rows = [
      row('run-20261120T031502Z-aaaaaa', { kind: 'nightly', project: null }),
      row('run-20261120T031503Z-bbbbbb', { parentId: 'run-20261120T031502Z-aaaaaa' }),
      row('run-20261120T101500Z-cccccc', { kind: 'landed' }),
      row('run-20261120T101600Z-dddddd', { kind: 'review' }),
      row('run-20261120T110000Z-eeeeee', {}),
    ];
    expect(otherRunsStatus(rows, startedForEvents, outputAt)).toEqual(['runs started by hand', '  acme/widgets checks [succeeded] run-20261120T110000Z-eeeeee']);
  });

  it('says so when there is none', () => {
    expect(otherRunsStatus([], startedForEvents, outputAt)).toEqual(['runs started by hand: none yet']);
  });
});
