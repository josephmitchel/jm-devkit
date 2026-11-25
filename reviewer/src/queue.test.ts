import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  afterReviewRun,
  leftByQueue,
  machineFor,
  noLongerHandled,
  queueDecision,
  queueStatus,
  timeLimitStopsAfter,
  type Machine,
  type QueuedEvent,
} from './queue.js';
import { classifyProjects } from './projects.js';
import type { Run } from './runs.js';

const at = (time: string) => new Date(`2026-11-20T${time}Z`);
const NOW = at('12:00:00');

const FREE: Machine = { agentJobRunning: false, nightlyGoing: false };

/** An agent job's event on record, found at `foundAt` and never started unless said otherwise. */
const queued = (event: string, foundAt: string, fields: Partial<QueuedEvent> = {}): QueuedEvent => ({
  project: 'acme/widgets',
  event,
  foundAt: at(foundAt),
  attempts: 0,
  attemptedAt: null,
  lastRun: null,
  ...fields,
});

/** An event whose review was started and turned away: another review held its project's slot. */
const turnedAway = (event: string, foundAt: string, attemptedAt: string, attempts = 1) =>
  queued(event, foundAt, { attempts, attemptedAt: at(attemptedAt), lastRun: 'succeeded' });

const noSlotsHeld = new Map<string, number[]>();
const decide = (events: QueuedEvent[], machine: Machine = FREE, slots: ReadonlyMap<string, number[]> = noSlotsHeld) =>
  queueDecision(events, slots, machine, NOW);
const started = (decision: ReturnType<typeof decide>) => decision.start && `${decision.start.project} ${decision.start.event}`;

describe('a review queued for a project the machine no longer handles', () => {
  const config = JSON.stringify({ modules: ['process'], reviewer: { tests: [{ name: 'unit', command: 'npm test' }] } });
  const lastSeen = classifyProjects([
    { slug: 'acme/widgets', config, sweepWorkflow: true },
    { slug: 'acme/gadgets', config, sweepWorkflow: false },
    { slug: 'acme/bare', config: null, sweepWorkflow: false },
  ]);

  it('is known from what the last pass saw: back on Actions, without a project config, or without the App', () => {
    expect(noLongerHandled(['acme/widgets', 'acme/gadgets', 'acme/bare', 'Zenith/anvils'], lastSeen)).toEqual(
      new Map([
        ['acme/widgets', 'still on Actions: its default branch has .github/workflows/nightly-sweep.yml'],
        ['acme/bare', 'skipped: its default branch has no devkit.json: run /devkit:install in the project to bring it under the kit'],
        ['Zenith/anvils', "the code reviewer's App is no longer installed on it"],
      ]),
    );
  });

  it('is not started: its event stays queued with that reason, and the next job is not held up', () => {
    const events = [queued('labelled:12', '11:00:00'), queued('labelled:3', '11:05:00', { project: 'acme/gadgets' })];
    const decision = queueDecision(events, noSlotsHeld, FREE, NOW, noLongerHandled(['acme/widgets', 'acme/gadgets'], lastSeen));
    expect(started(decision)).toBe('acme/gadgets labelled:3');
    expect(decision.waiting.map(({ job, why }) => `${job.project} ${job.event}: ${why}`)).toEqual([
      'acme/widgets labelled:12: the machine no longer handles its project (still on Actions: its default branch has .github/workflows/nightly-sweep.yml)',
    ]);
  });
});

describe('who has the machine when a review and the nightly run both want it', () => {
  it('is the review when nothing else is going', () => {
    expect(machineFor('review', FREE)).toEqual({ take: true });
  });

  it('is not a review while another agent job is running', () => {
    expect(machineFor('review', { agentJobRunning: true, nightlyGoing: false })).toEqual({ take: false, why: 'another agent job is running' });
  });

  it("is nobody's once the connection holding its lock is lost: the turn can no longer say it has the machine", () => {
    expect(machineFor('review', { ...FREE, lockLost: true })).toMatchObject({ take: false });
    expect(decide([queued('labelled:12', '11:00:00')], { ...FREE, lockLost: true })).toMatchObject({
      start: null,
      waiting: [{ why: "the connection holding the machine's lock was lost: nothing more starts this turn" }],
    });
  });

  it('is the nightly run once it is going, even in a moment when the machine is free: the review waits for the night to be over', () => {
    expect(machineFor('review', { agentJobRunning: false, nightlyGoing: true })).toEqual({ take: false, why: 'the nightly run has the machine' });
    expect(machineFor('review', { agentJobRunning: true, nightlyGoing: true })).toEqual({ take: false, why: 'the nightly run has the machine' });
  });

  it('is not the nightly run while a review is running: it waits for that review, and is not skipped', () => {
    expect(machineFor('nightly run', { agentJobRunning: true, nightlyGoing: true })).toEqual({
      take: false,
      why: 'a review is running: the nightly run starts when it has finished',
    });
  });

  it('is the nightly run as soon as that review has finished, whatever reviews are queued', () => {
    expect(machineFor('nightly run', { agentJobRunning: false, nightlyGoing: true })).toEqual({ take: true });
  });
});

describe('the next review the machine starts', () => {
  it('is the one queued review, with the command that runs it', () => {
    const decision = decide([queued('labelled:12', '11:58:00')]);
    expect(decision.start).toEqual({
      project: 'acme/widgets',
      event: 'labelled:12',
      covers: [],
      kind: 'review',
      command: 'run',
      pr: 12,
      attempts: 0,
      foundAt: at('11:58:00'),
    });
    expect(decision.waiting).toEqual([]);
  });

  it('is none when nothing is queued', () => {
    expect(decide([])).toEqual({ start: null, waiting: [] });
  });

  it('is the one found first, across projects, and the others wait their turn', () => {
    const decision = decide([
      queued('labelled:14', '11:59:00'),
      queued('labelled:3', '11:57:00', { project: 'acme/anvils' }),
      queued('replied:12/900', '11:58:00'),
    ]);
    expect(started(decision)).toBe('acme/anvils labelled:3');
    expect(decision.waiting.map(({ job, why }) => `${job.event}: ${why}`)).toEqual([
      'replied:12/900: its turn comes after the job ahead of it',
      'labelled:14: its turn comes after the job ahead of it',
    ]);
  });

  it('is none while an agent job is running: every review stays queued for a later pass', () => {
    const decision = decide([queued('labelled:12', '11:58:00')], { agentJobRunning: true, nightlyGoing: false });
    expect(decision.start).toBeNull();
    expect(decision.waiting.map(({ job, why }) => `${job.event}: ${why}`)).toEqual(['labelled:12: another agent job is running']);
  });

  it('is none while the nightly run is going, and the review is still there afterwards', () => {
    const events = [queued('labelled:12', '01:58:00')];
    const during = decide(events, { agentJobRunning: true, nightlyGoing: true });
    expect(during.start).toBeNull();
    expect(during.waiting[0].why).toBe('the nightly run has the machine');
    expect(started(decide(events))).toBe('acme/widgets labelled:12');
  });

  it('is one run for every queued event that asks for the same review', () => {
    const decision = decide([queued('replied:12/905', '11:59:00'), queued('labelled:12', '11:57:00'), queued('replied:12/900', '11:58:00')]);
    expect(decision.start).toMatchObject({ event: 'labelled:12', covers: ['replied:12/900', 'replied:12/905'], command: 'run', pr: 12 });
    expect(decision.waiting).toEqual([]);
  });

  it('leaves alone an event no rule knows, and those a pass runs itself', () => {
    const notTheQueues = [queued('eclipse:4', '11:58:00'), queued('merged:12', '11:58:00'), queued(`head-moved:12@${'b2'.repeat(20)}`, '11:58:00')];
    expect(decide(notTheQueues)).toEqual({ start: null, waiting: [] });
  });
});

describe("a review turned away because another review holds its project's slot", () => {
  const holds12 = new Map([['acme/widgets', [12]]]);

  it('waits while that review holds the slot', () => {
    const decision = decide([turnedAway('labelled:14', '11:30:00', '11:59:50')], FREE, holds12);
    expect(decision.start).toBeNull();
    expect(decision.waiting.map(({ job, why }) => `${job.event}: ${why}`)).toEqual([
      "labelled:14: waits for its project's review slot, held by the review of #12",
    ]);
  });

  it('starts once the review ahead of it has finished and freed the slot', () => {
    expect(started(decide([turnedAway('labelled:14', '11:30:00', '11:59:50')]))).toBe('acme/widgets labelled:14');
  });

  it('starts in the order found: of two waiting in one project, the first found goes next', () => {
    const decision = decide([turnedAway('labelled:15', '11:40:00', '11:41:00'), turnedAway('labelled:14', '11:30:00', '11:31:00')]);
    expect(started(decision)).toBe('acme/widgets labelled:14');
    expect(decision.waiting.map(({ job }) => job.event)).toEqual(['labelled:15']);
  });

  it("does not wait for a slot held in another project", () => {
    const decision = decide([turnedAway('labelled:14', '11:30:00', '11:59:50')], FREE, new Map([['acme/anvils', [12]]]));
    expect(started(decision)).toBe('acme/widgets labelled:14');
  });

  it('is not held up by its own review holding the slot: a reply continues the review that waits for it', () => {
    expect(started(decide([queued('replied:12/900', '11:58:00')], FREE, holds12))).toBe('acme/widgets replied:12/900');
  });

  it('is tried again after a wait all the same, so a holder that will never finish is found and retired', () => {
    // Turned away once: a minute's wait. The review itself retires a holder whose pull request has closed.
    expect(started(decide([turnedAway('labelled:14', '11:30:00', '11:58:59')], FREE, holds12))).toBe('acme/widgets labelled:14');
  });

  it('is started the first time whoever holds the slot: the review itself decides, and queues itself there', () => {
    expect(started(decide([queued('labelled:14', '11:59:00')], FREE, holds12))).toBe('acme/widgets labelled:14');
  });
});

describe('a review whose run did not get as far as the review', () => {
  const failed = (attempts: number, attemptedAt: string, lastRun: QueuedEvent['lastRun'] = 'failed') =>
    queued('labelled:12', '11:00:00', { attempts, attemptedAt: at(attemptedAt), lastRun });

  it('is tried again after a wait that doubles, as a failed landed is', () => {
    // Three attempts: four minutes.
    expect(decide([failed(3, '11:56:30')]).waiting.map(({ why }) => why)).toEqual(['tried 3 times: tried again after 2026-11-20T12:00:30Z']);
    expect(started(decide([failed(3, '11:56:00')]))).toBe('acme/widgets labelled:12');
  });

  it('is tried again after an interruption the same way', () => {
    expect(decide([failed(1, '11:59:30', 'interrupted')]).start).toBeNull();
    expect(started(decide([failed(1, '11:59:00', 'interrupted')]))).toBe('acme/widgets labelled:12');
  });

  it('is not started again while its last run is still recorded as running', () => {
    const decision = decide([failed(1, '09:00:00', 'running')]);
    expect(decision.start).toBeNull();
    expect(decision.waiting.map(({ why }) => why)).toEqual(['its last run is still going']);
  });

  it('does not hold up the review queued behind it', () => {
    const decision = decide([failed(3, '11:59:00'), queued('labelled:3', '11:58:00', { project: 'acme/anvils' })]);
    expect(started(decision)).toBe('acme/anvils labelled:3');
  });
});

describe("what a review's run leaves of the event that asked for it", () => {
  const succeeded = { state: 'succeeded', stage: null, errorType: null } as const;

  it('is handled when the review passed', () => {
    expect(afterReviewRun(succeeded, 'passed')).toBe('handled');
  });

  it("is handled when the review now waits for answers: the owner's reply is an event of its own", () => {
    expect(afterReviewRun(succeeded, 'awaiting_answers')).toBe('handled');
  });

  it("still waits when the review was turned away from its project's slot, though the command exited 0", () => {
    expect(afterReviewRun(succeeded, 'pending')).toBe('waits for the slot');
    // A stopped review turned away on its retry is left stopped, and is still owed its turn.
    expect(afterReviewRun(succeeded, 'failed')).toBe('waits for the slot');
  });

  it('is handled when the review stopped in one of its stages: it says so on the pull request, and a comment there retries it', () => {
    expect(afterReviewRun({ state: 'failed', stage: 'auditing', errorType: 'Error' }, 'failed')).toBe('handled');
    expect(afterReviewRun({ state: 'failed', stage: 'intake', errorType: 'SetupCommandError' }, 'failed')).toBe('handled');
  });

  it('is tried again when the run failed before the review did anything: nothing on the pull request says it stopped', () => {
    expect(afterReviewRun({ state: 'failed', stage: 'starting', errorType: 'Error' }, null)).toBe('try again');
    expect(afterReviewRun({ state: 'failed', stage: 'starting', errorType: 'could not start' }, 'failed')).toBe('try again');
    expect(afterReviewRun({ state: 'failed', stage: 'pending', errorType: 'Error' }, 'pending')).toBe('try again');
  });

  it('is tried again when the service stopping or a restart interrupted it, so the next run resumes the review', () => {
    expect(afterReviewRun({ state: 'interrupted', stage: 'auditing', errorType: 'service stopped' }, 'failed')).toBe('try again');
    expect(afterReviewRun({ state: 'interrupted', stage: null, errorType: 'found running' }, 'failed')).toBe('try again');
  });

  const atItsLimit = { state: 'interrupted', stage: 'fixing', errorType: 'time limit' } as const;

  it('is tried again when its time limit stopped it, so the next run resumes the review from the stage it was in', () => {
    expect(afterReviewRun(atItsLimit, 'failed', 0)).toBe('try again');
    expect(afterReviewRun(atItsLimit, 'failed', 1)).toBe('try again');
  });

  it('is handled at the third stop in a row by the time limit: the review stays stopped until the owner comments', () => {
    expect(afterReviewRun(atItsLimit, 'failed', 2)).toBe('handled');
  });

  describe('the count of time-limit stops the review carries afterwards', () => {
    it('is one more for a stop that is resumed', () => {
      expect(timeLimitStopsAfter(atItsLimit, 'try again', 0)).toBe(1);
      expect(timeLimitStopsAfter(atItsLimit, 'try again', 1)).toBe(2);
    });

    it("starts from none once the event is handled, so the owner's retry of an abandoned review is resumed twice again", () => {
      expect(timeLimitStopsAfter(atItsLimit, 'handled', 2)).toBe(0);
      expect(timeLimitStopsAfter(succeeded, 'handled', 2)).toBe(0);
      expect(timeLimitStopsAfter({ state: 'failed', stage: 'auditing', errorType: 'Error' }, 'handled', 1)).toBe(0);
    });

    it('is kept by a run that says nothing about the limit: turned away, stopped with the service, failed before it began', () => {
      expect(timeLimitStopsAfter(succeeded, 'waits for the slot', 1)).toBe(1);
      expect(timeLimitStopsAfter({ state: 'interrupted', stage: 'auditing', errorType: 'service stopped' }, 'try again', 2)).toBe(2);
      expect(timeLimitStopsAfter({ state: 'failed', stage: 'starting', errorType: 'Error' }, 'try again', 1)).toBe(1);
    });
  });
});

const run = (id: string, fields: Partial<Run> = {}): Run => ({
  id,
  kind: 'review',
  project: 'acme/widgets',
  parentId: null,
  state: 'running',
  stage: null,
  errorType: null,
  startedAt: at('11:57:00'),
  finishedAt: null,
  ...fields,
});

describe('the review runs the queue finds still recorded as running', () => {
  it('are the ones an earlier turn of the queue left: its process died before it could record them', () => {
    const rows = [run('run-20261120T115700Z-aaaaaa'), run('run-20261120T100000Z-bbbbbb', { state: 'succeeded', finishedAt: at('10:30:00') })];
    expect(leftByQueue(rows).map((r) => r.id)).toEqual(['run-20261120T115700Z-aaaaaa']);
  });

  it('are not a landed run, which a pass waits for, nor a nightly run or its parts', () => {
    const rows = [
      run('run-20261120T115900Z-cccccc', { kind: 'landed' }),
      run('run-20261120T020000Z-dddddd', { kind: 'nightly', project: null }),
      run('run-20261120T020001Z-eeeeee', { kind: 'sweep', parentId: 'run-20261120T020000Z-dddddd' }),
    ];
    expect(leftByQueue(rows)).toEqual([]);
  });
});

describe('the queue, in status', () => {
  it('says what is running, what is next and what waits, with why', () => {
    const decision = decide(
      [queued('labelled:3', '11:58:00', { project: 'acme/anvils' }), turnedAway('labelled:14', '11:30:00', '11:59:50')],
      { agentJobRunning: true, nightlyGoing: false },
      new Map([['acme/widgets', [12]]]),
    );
    const running = [{ run: run('run-20261120T115700Z-aaaaaa'), command: { command: 'run' as const, project: 'acme/widgets', pr: 12 } }];
    expect(queueStatus(decision, running, { agentJobRunning: true, nightlyGoing: false })).toEqual([
      'the queue: agent jobs, one at a time on this machine',
      '  running: acme/widgets review `run acme/widgets 12 --once` since 2026-11-20T11:57:00Z, run-20261120T115700Z-aaaaaa',
      "  waiting: acme/widgets `run acme/widgets 14 --once` (labelled:14), found 2026-11-20T11:30:00Z: waits for its project's review slot, held by the review of #12",
      '  waiting: acme/anvils `run acme/anvils 3 --once` (labelled:3), found 2026-11-20T11:58:00Z: another agent job is running',
    ]);
  });

  it('names the job that starts next when the machine is free', () => {
    const decision = decide([queued('replied:12/905', '11:59:00'), queued('replied:12/900', '11:58:00')]);
    expect(queueStatus(decision, [], FREE)).toEqual([
      'the queue: agent jobs, one at a time on this machine',
      '  next: acme/widgets `run acme/widgets 12 --once` (replied:12/900, replied:12/905), found 2026-11-20T11:58:00Z',
    ]);
  });

  it("shows a sweep of the nightly run as what is running, and that reviews wait for the night", () => {
    const sweep = run('run-20261120T020001Z-eeeeee', { kind: 'sweep', parentId: 'run-20261120T020000Z-dddddd', startedAt: at('02:00:01') });
    const machine = { agentJobRunning: true, nightlyGoing: true };
    expect(queueStatus(decide([queued('labelled:12', '02:10:00')], machine), [{ run: sweep, command: null }], machine)).toEqual([
      'the queue: agent jobs, one at a time on this machine',
      '  a nightly run is going: reviews wait until it is over',
      '  running: acme/widgets sweep since 2026-11-20T02:00:01Z, run-20261120T020001Z-eeeeee',
      '  waiting: acme/widgets `run acme/widgets 12 --once` (labelled:12), found 2026-11-20T02:10:00Z: the nightly run has the machine',
    ]);
  });

  it('says so when a nightly run is waiting for a review to finish', () => {
    const machine = { agentJobRunning: true, nightlyGoing: true };
    const running = [{ run: run('run-20261120T015000Z-aaaaaa', { startedAt: at('01:50:00') }), command: { command: 'run' as const, project: 'acme/widgets', pr: 12 } }];
    expect(queueStatus(decide([], machine), running, machine).slice(1)).toEqual([
      '  a nightly run is going: reviews wait until it is over',
      '  running: acme/widgets review `run acme/widgets 12 --once` since 2026-11-20T01:50:00Z, run-20261120T015000Z-aaaaaa',
    ]);
  });

  it('says so when there is nothing', () => {
    expect(queueStatus(decide([]), [], FREE)).toEqual(['the queue: nothing running, nothing waiting']);
  });
});

describe("the queue's service on the machine", () => {
  const unit = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '../../vm/systemd', name), 'utf8').split('\n');
  const settings = (lines: string[], names: string[]) => lines.filter((line) => names.some((name) => line.startsWith(`${name}=`)));
  const queue = unit('code-reviewer-queue.service');
  const nightly = unit('code-reviewer-nightly.service');

  it('runs as the same user, with the same credentials file and the same places, as the nightly run', () => {
    const shared = ['User', 'Group', 'EnvironmentFile', 'StateDirectory', 'StateDirectoryMode', 'WorkingDirectory', 'Environment'];
    expect(settings(queue, shared)).toEqual(settings(nightly, shared));
  });

  it('takes one turn of whatever is checked out, and leaves the time limit to the review, which has its own', () => {
    expect(settings(queue, ['Type', 'ExecStartPre', 'ExecStart', 'TimeoutStartSec'])).toEqual([
      'Type=oneshot',
      'ExecStart=/usr/bin/node --import tsx/esm src/cli.ts queue',
      'TimeoutStartSec=infinity',
    ]);
  });

  it('is started when a pass of the poller ends, however the pass ended', () => {
    expect(settings(unit('code-reviewer-poller.service'), ['OnSuccess', 'OnFailure'])).toEqual([
      'OnSuccess=code-reviewer-queue.service',
      'OnFailure=code-reviewer-queue.service',
    ]);
  });

  it('is not started while the nightly unit is active, its update step included, and that unit waits for a turn that is going', () => {
    // The nightly unit's runtime directory is there exactly as long as the unit is active.
    expect(settings(nightly, ['RuntimeDirectory', 'After'])).toEqual([
      'After=network-online.target postgresql.service code-reviewer-queue.service',
      'RuntimeDirectory=code-reviewer-nightly',
    ]);
    expect(settings(queue, ['ConditionPathExists'])).toContain('ConditionPathExists=!/run/code-reviewer-nightly');
  });
});
