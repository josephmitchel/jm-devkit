import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  leftByPasses,
  passDecision,
  pollerStatus,
  repliesToRead,
  retryDelayMs,
  type EventRecord,
  type ProjectKnown,
  type ProjectSeen,
  type PullRequestSeen,
  type ReviewKnown,
} from './poller.js';
import type { Run } from './runs.js';

const at = (time: string) => new Date(`2026-11-20T${time}Z`);

/** A handled project as a pass saw it at 12:00, with the pull requests GitHub listed. */
const widgets = (pullRequests: PullRequestSeen[] | null, slug = 'acme/widgets'): ProjectSeen => ({
  project: { slug, state: 'handled', nightlyChecks: 0 },
  at: at('12:00:00'),
  pullRequests,
});

/** An open pull request, last changed at `when`, with nothing else about it unless given. */
const pull = (number: number, when: string, fields: Partial<PullRequestSeen> = {}): PullRequestSeen => ({
  number,
  updatedAt: at(when),
  mergedAt: null,
  open: true,
  draft: false,
  labels: [],
  comments: [],
  ...fields,
});

const merged = (number: number, when: string): PullRequestSeen => pull(number, when, { mergedAt: at(when), open: false });

/** What the database holds for a project whose first pass was at 09:00. */
const known = (events: EventRecord[] = [], slug = 'acme/widgets', reviews: ReviewKnown[] = []): Map<string, ProjectKnown> =>
  new Map([[slug, { startedAt: at('09:00:00'), seenTo: at('11:57:00'), events, reviews }]]);

const NOW = at('12:00:01');

describe('what a pass of the poller runs, from what it saw on GitHub and what was already handled', () => {
  it('runs landed once for a pull request that has merged', () => {
    const decision = passDecision({ projects: [widgets([merged(12, '11:59:00')])] }, { projects: known() }, NOW);
    expect(decision.commands).toEqual([
      { project: 'acme/widgets', event: 'merged:12', kind: 'landed', args: ['landed', 'acme/widgets', '12'], attempts: 0 },
    ]);
    expect(decision.projects).toEqual([
      { project: 'acme/widgets', firstPass: false, startedAt: at('09:00:00'), seenTo: at('11:59:00'), found: ['merged:12'] },
    ]);
  });

  it('runs nothing for the same merge seen again once it is handled', () => {
    const handled: EventRecord = { event: 'merged:12', handledAt: at('11:59:30'), attempts: 1, attemptedAt: at('11:59:20'), running: false };
    const decision = passDecision({ projects: [widgets([merged(12, '11:59:00')])] }, { projects: known([handled]) }, NOW);
    expect(decision.commands).toEqual([]);
    expect(decision.projects[0].found).toEqual([]);
  });

  it("starts a project's first pass from that moment: what merged before it is not acted on", () => {
    const decision = passDecision({ projects: [widgets([merged(12, '11:59:00'), merged(11, '08:00:00')])] }, { projects: new Map() }, NOW);
    expect(decision.commands).toEqual([]);
    expect(decision.projects).toEqual([
      { project: 'acme/widgets', firstPass: true, startedAt: at('12:00:00'), seenTo: at('12:00:00'), found: [] },
    ]);
  });

  it('never goes back over a merge from before the first pass, however often a later pass sees it', () => {
    // Merged at 08:00, an hour before the first pass, and commented on since.
    const old = pull(11, '11:59:00', { mergedAt: at('08:00:00'), open: false });
    const decision = passDecision({ projects: [widgets([old])] }, { projects: known() }, NOW);
    expect(decision.commands).toEqual([]);
    expect(decision.projects[0].found).toEqual([]);
  });

  it('runs nothing for a pull request that is open, or was closed without merging', () => {
    const closed = pull(14, '11:59:00', { open: false });
    expect(passDecision({ projects: [widgets([pull(13, '11:59:00'), closed])] }, { projects: known() }, NOW).commands).toEqual([]);
  });

  it('leaves alone a project the machine does not handle, whatever was seen of it', () => {
    const stillOnActions: ProjectSeen = {
      ...widgets([merged(7, '11:59:00')]),
      project: { slug: 'acme/gadgets', state: 'still on Actions', reason: 'its default branch has .github/workflows/nightly-sweep.yml' },
    };
    const noConfig: ProjectSeen = {
      ...widgets([merged(8, '11:59:00')]),
      project: { slug: 'acme/bare', state: 'skipped', reason: 'its default branch has no devkit.json' },
    };
    const decision = passDecision(
      { projects: [noConfig, stillOnActions, widgets([merged(12, '11:59:00')])] },
      { projects: new Map([...known(), ...known([], 'acme/gadgets'), ...known([], 'acme/bare')]) },
      NOW,
    );
    expect(decision.commands.map((c) => c.event)).toEqual(['merged:12']);
    expect(decision.projects.map((p) => p.project)).toEqual(['acme/widgets']);
    expect(decision.leftAlone).toEqual([noConfig.project, stillOnActions.project]);
  });

  it('runs nothing, and stays where it was, when GitHub says nothing has changed', () => {
    const decision = passDecision({ projects: [widgets(null)] }, { projects: known() }, NOW);
    expect(decision.commands).toEqual([]);
    expect(decision.projects).toEqual([
      { project: 'acme/widgets', firstPass: false, startedAt: at('09:00:00'), seenTo: at('11:57:00'), found: [] },
    ]);
  });
});

describe('a merge whose landed did not succeed', () => {
  const failed = (attempts: number, attemptedAt: string): EventRecord => ({
    event: 'merged:12',
    handledAt: null,
    attempts,
    attemptedAt: at(attemptedAt),
    running: false,
  });

  it('is tried again on the next pass, even when GitHub says nothing has changed since', () => {
    const decision = passDecision({ projects: [widgets(null)] }, { projects: known([failed(1, '11:57:10')]) }, NOW);
    expect(decision.commands).toEqual([
      { project: 'acme/widgets', event: 'merged:12', kind: 'landed', args: ['landed', 'acme/widgets', '12'], attempts: 1 },
    ]);
    // Already on record: it is not found a second time.
    expect(decision.projects[0].found).toEqual([]);
  });

  it('waits longer after each failure, up to six hours, so a merge that cannot be handled is not tried every pass for ever', () => {
    const minutes = (attempts: number) => retryDelayMs(attempts) / 60_000;
    expect([1, 2, 3, 4, 5].map(minutes)).toEqual([1, 2, 4, 8, 16]);
    expect(minutes(9)).toBe(256);
    expect(minutes(10)).toBe(360);
    expect(minutes(500)).toBe(360);
  });

  it('is left for a later pass until its wait is over', () => {
    const tried = (attemptedAt: string) => passDecision({ projects: [widgets(null)] }, { projects: known([failed(3, attemptedAt)]) }, NOW).commands;
    // Three failures: four minutes.
    expect(tried('11:57:00')).toEqual([]);
    expect(tried('11:56:00').map((c) => c.attempts)).toEqual([3]);
  });

  it('is not started again while its last attempt is still recorded as running', () => {
    const running: EventRecord = { ...failed(1, '11:00:00'), running: true };
    expect(passDecision({ projects: [widgets(null)] }, { projects: known([running]) }, NOW).commands).toEqual([]);
  });

  it('is left where it is when no rule knows what it is, as after a step back to older code', () => {
    const unknown: EventRecord = { event: 'eclipse:4', handledAt: null, attempts: 0, attemptedAt: null, running: false };
    expect(passDecision({ projects: [widgets(null)] }, { projects: known([unknown]) }, NOW).commands).toEqual([]);
  });

  it('is not tried for a project the machine no longer handles', () => {
    const moved: ProjectSeen = { ...widgets(null), project: { slug: 'acme/widgets', state: 'skipped', reason: 'its default branch has no devkit.json' } };
    expect(passDecision({ projects: [moved] }, { projects: known([failed(1, '11:00:00')]) }, NOW).commands).toEqual([]);
  });
});

describe('a pull request labelled review-now', () => {
  const labelled = (number: number, when: string, fields: Partial<PullRequestSeen> = {}) => pull(number, when, { labels: ['review-now'], ...fields });
  const found = (pullRequests: PullRequestSeen[], reviews: ReviewKnown[] = [], events: EventRecord[] = []) =>
    passDecision({ projects: [widgets(pullRequests)] }, { projects: known(events, 'acme/widgets', reviews) }, NOW);
  const review = (pr: number, state: string): ReviewKnown => ({ pr, state, since: at('10:00:00'), ownComments: [] });

  it('has its review put on record for the queue, and the pass does not run it', () => {
    const decision = found([labelled(12, '11:59:00', { labels: ['bug', 'review-now'] })]);
    expect(decision.projects[0].found).toEqual(['labelled:12']);
    expect(decision.queued).toEqual([
      { project: 'acme/widgets', event: 'labelled:12', kind: 'review', args: ['run', 'acme/widgets', '12', '--once'], attempts: 0 },
    ]);
    // A review runs for hours and a pass waits for what it runs.
    expect(decision.commands).toEqual([]);
  });

  it('is not found a second time, on a later pass or after its review has been tried', () => {
    const onRecord: EventRecord = { event: 'labelled:12', handledAt: null, attempts: 1, attemptedAt: at('11:00:00'), running: false };
    const decision = found([labelled(12, '11:59:00')], [review(12, 'pending')], [onRecord]);
    expect(decision.projects[0].found).toEqual([]);
    expect(decision.queued).toEqual([]);
    // Nor is the one on record run by the pass when its wait is over: the queue starts reviews.
    expect(decision.commands).toEqual([]);
  });

  it('is not reviewed while it is a draft', () => {
    expect(found([labelled(12, '11:59:00', { draft: true })]).projects[0].found).toEqual([]);
  });

  it('is reviewed once it leaves draft with the label still on', () => {
    // The draft was seen and nothing recorded; leaving draft changes it, so a later pass sees it again.
    expect(found([labelled(12, '11:59:30')]).projects[0].found).toEqual(['labelled:12']);
  });

  it('is not reviewed without the label, or once it is closed or merged', () => {
    const decision = found([pull(12, '11:59:00', { labels: ['bug'] }), labelled(13, '11:59:00', { open: false }), { ...merged(14, '11:58:00'), labels: ['review-now'] }]);
    expect(decision.queued).toEqual([]);
  });

  it('is not reviewed again when it already has a review, whatever state that is in', () => {
    for (const state of ['auditing', 'awaiting_answers', 'passed', 'failed']) {
      expect(found([labelled(12, '11:59:00')], [review(12, state)]).projects[0].found, state).toEqual([]);
    }
  });

  it('is queued when its only review never started: one left waiting for the slot before the machine took the project', () => {
    expect(found([labelled(12, '11:59:00')], [review(12, 'pending')]).projects[0].found).toEqual(['labelled:12']);
  });

  it("is not acted on when nothing about it has changed since the project's first pass", () => {
    expect(found([labelled(12, '08:30:00')]).projects[0].found).toEqual([]);
  });
});

describe("a comment on the pull request of a review that waits on the owner", () => {
  const owner = (id: number, when: string) => ({ id, at: at(when), authorAssociation: 'OWNER' });
  const waiting = (state = 'awaiting_answers', ownComments: number[] = []): ReviewKnown => ({ pr: 12, state, since: at('11:00:00'), ownComments });
  const found = (comments: PullRequestSeen['comments'], review: ReviewKnown = waiting(), fields: Partial<PullRequestSeen> = {}) =>
    passDecision({ projects: [widgets([pull(12, '11:59:00', { comments, ...fields })])] }, { projects: known([], 'acme/widgets', [review]) }, NOW);

  it("continues the review when it is the owner's, through the queue", () => {
    const decision = found([owner(900, '11:58:00')]);
    expect(decision.queued).toEqual([
      { project: 'acme/widgets', event: 'replied:12/900', kind: 'review', args: ['run', 'acme/widgets', '12', '--once'], attempts: 0 },
    ]);
    expect(decision.commands).toEqual([]);
  });

  it('counts a member or a collaborator as it counts the owner, as the review itself does when it reads answers', () => {
    for (const authorAssociation of ['MEMBER', 'COLLABORATOR']) {
      expect(found([{ ...owner(900, '11:58:00'), authorAssociation }]).projects[0].found).toEqual(['replied:12/900']);
    }
  });

  it("does nothing for anyone else's comment", () => {
    for (const authorAssociation of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR']) {
      expect(found([{ ...owner(900, '11:58:00'), authorAssociation }]).projects[0].found, authorAssociation).toEqual([]);
    }
  });

  it("does nothing for the code reviewer's own comments", () => {
    expect(found([owner(900, '11:58:00')], waiting('awaiting_answers', [900])).projects[0].found).toEqual([]);
  });

  it('does nothing for what was said before the review began to wait', () => {
    expect(found([owner(900, '10:59:00')]).projects[0].found).toEqual([]);
  });

  it("does nothing for what was said before the project's first pass", () => {
    const since0800: ReviewKnown = { ...waiting(), since: at('08:00:00') };
    expect(found([owner(900, '08:30:00')], since0800).projects[0].found).toEqual([]);
  });

  it('continues it once for several new comments: the event is the newest of them', () => {
    expect(found([owner(902, '11:58:30'), owner(900, '11:58:00'), owner(901, '11:58:10')]).projects[0].found).toEqual(['replied:12/902']);
  });

  it('does not continue it again for a comment already acted on, and does for a later one', () => {
    const acted: EventRecord = { event: 'replied:12/900', handledAt: at('11:58:40'), attempts: 1, attemptedAt: at('11:58:05'), running: false };
    const again = (comments: PullRequestSeen['comments']) =>
      passDecision({ projects: [widgets([pull(12, '11:59:00', { comments })])] }, { projects: known([acted], 'acme/widgets', [waiting()]) }, NOW).projects[0].found;
    expect(again([owner(900, '11:58:00')])).toEqual([]);
    expect(again([owner(900, '11:58:00'), owner(905, '11:59:00')])).toEqual(['replied:12/905']);
  });

  it('retries a review that stopped, as its notice on the pull request says a comment will', () => {
    expect(found([owner(900, '11:58:00')], waiting('failed')).projects[0].found).toEqual(['replied:12/900']);
  });

  it('does nothing for a review that is working, queued or finished', () => {
    for (const state of ['pending', 'auditing', 'fixing', 'passed']) {
      expect(found([owner(900, '11:58:00')], waiting(state)).projects[0].found, state).toEqual([]);
    }
  });

  it('does nothing once the pull request is closed', () => {
    expect(found([owner(900, '11:58:00')], waiting(), { open: false }).projects[0].found).toEqual([]);
  });
});

describe('the pull requests a pass reads the comments of', () => {
  const review = (pr: number, state: string, since = '11:00:00'): ReviewKnown => ({ pr, state, since: at(since), ownComments: [] });
  // The last pass read as far as 11:57.
  const position = (reviews: ReviewKnown[]) => known([], 'acme/widgets', reviews).get('acme/widgets')!;

  it('are those whose review waits on the owner and that have changed since the last pass, each from when its review began to wait', () => {
    const listing = [pull(12, '11:59:00'), pull(13, '11:58:00'), pull(14, '11:58:30')];
    const wanted = repliesToRead(listing, position([review(12, 'awaiting_answers'), review(13, 'auditing'), review(14, 'failed', '11:30:00')]));
    expect(wanted.map(({ pr, since }) => [pr.number, since])).toEqual([
      [12, at('11:00:00')],
      [14, at('11:30:00')],
    ]);
  });

  it('are not those the last pass already read, a closed one, or one with no review', () => {
    const listing = [pull(12, '11:50:00'), pull(13, '11:59:00', { open: false }), pull(14, '11:59:00')];
    expect(repliesToRead(listing, position([review(12, 'awaiting_answers'), review(13, 'awaiting_answers')]))).toEqual([]);
  });
});

describe('the order a pass works in', () => {
  it('takes what is waiting to be tried again first, then what it found, oldest first', () => {
    const waiting: EventRecord = { event: 'merged:9', handledAt: null, attempts: 2, attemptedAt: at('11:50:00'), running: false };
    const decision = passDecision(
      { projects: [widgets([merged(14, '11:59:30'), merged(12, '11:58:00')])] },
      { projects: known([waiting]) },
      NOW,
    );
    expect(decision.commands.map((c) => c.event)).toEqual(['merged:9', 'merged:12', 'merged:14']);
    expect(decision.projects[0]).toMatchObject({ found: ['merged:12', 'merged:14'], seenTo: at('11:59:30') });
  });

  it('takes the projects in the order they were seen', () => {
    const decision = passDecision(
      { projects: [widgets([merged(3, '11:59:00')], 'acme/anvils'), widgets([merged(12, '11:59:00')])] },
      { projects: new Map([...known([], 'acme/anvils'), ...known()]) },
      NOW,
    );
    expect(decision.commands.map((c) => c.args.join(' '))).toEqual(['landed acme/anvils 3', 'landed acme/widgets 12']);
  });
});

describe('the runs a starting pass finds still recorded as running', () => {
  const running = (id: string, fields: Partial<Run>): Run => ({
    id,
    kind: 'landed',
    project: 'acme/widgets',
    parentId: null,
    state: 'running',
    stage: null,
    errorType: null,
    startedAt: at('11:57:00'),
    finishedAt: null,
    ...fields,
  });

  it('are the landed runs of an earlier pass, which died before it could record them', () => {
    const rows = [running('run-20261120T115700Z-aaaaaa', {}), running('run-20261120T115400Z-bbbbbb', { state: 'succeeded', finishedAt: at('11:54:05') })];
    expect(leftByPasses(rows).map((r) => r.id)).toEqual(['run-20261120T115700Z-aaaaaa']);
  });

  it('are not a nightly run or its parts, nor a run of a kind no pass waits for', () => {
    const rows = [
      running('run-20261120T020000Z-cccccc', { kind: 'nightly', project: null }),
      running('run-20261120T020001Z-dddddd', { kind: 'sweep', parentId: 'run-20261120T020000Z-cccccc' }),
      // A review outlasts the pass that found it: the queue runs it and has its own rule for it.
      running('run-20261120T110000Z-eeeeee', { kind: 'review' }),
    ];
    expect(leftByPasses(rows)).toEqual([]);
  });
});

describe('what the last passes found, in status', () => {
  const outputAt = (id: string) => `/var/lib/code-reviewer/state/runs/${id}.log`;
  const position = (project: string, lastPassAt: string) => ({
    project,
    startedAt: at('09:00:00'),
    seenTo: at('11:59:00'),
    pullsEtag: 'W/"abc"',
    lastPassAt: at(lastPassAt),
  });
  const landed = (id: string, fields: Partial<Run> = {}): Run => ({
    id,
    kind: 'landed',
    project: 'acme/widgets',
    parentId: null,
    state: 'succeeded',
    stage: null,
    errorType: null,
    startedAt: at('11:57:00'),
    finishedAt: at('11:57:05'),
    ...fields,
  });
  const event = (key: string, fields: object = {}) => ({
    project: 'acme/widgets',
    event: key,
    attempts: 1,
    attemptedAt: at('11:57:00'),
    runId: null,
    handledAt: null,
    foundAt: at('11:57:00'),
    run: null,
    ...fields,
  });

  it("lists each project with when its last pass was, what was found, and each event's run", () => {
    const lines = pollerStatus(
      [position('acme/anvils', '12:00:02'), position('acme/widgets', '12:00:01')],
      [
        event('merged:12', { handledAt: at('11:57:05'), run: landed('run-20261120T115700Z-aaaaaa') }),
        event('merged:14', {
          attempts: 3,
          run: landed('run-20261120T115900Z-bbbbbb', { state: 'failed', stage: 'starting', errorType: 'exit 1' }),
        }),
        event('merged:15', { attempts: 0, attemptedAt: null }),
      ],
      outputAt,
    );
    expect(lines).toEqual([
      'the poller',
      '  acme/anvils: last pass 2026-11-20T12:00:02Z, watched since 2026-11-20T09:00:00Z, nothing found yet',
      '  acme/widgets: last pass 2026-11-20T12:00:01Z, watched since 2026-11-20T09:00:00Z',
      '    merged:12 handled: acme/widgets landed [succeeded] run-20261120T115700Z-aaaaaa',
      '    merged:14 not handled, tried 3 times: acme/widgets landed [failed in starting: exit 1] run-20261120T115900Z-bbbbbb' +
        ', output: /var/lib/code-reviewer/state/runs/run-20261120T115900Z-bbbbbb.log',
      '    merged:15 not handled, not tried yet',
    ]);
  });

  it('says so when no pass has got as far as a project', () => {
    expect(pollerStatus([], [], outputAt)).toEqual(['the poller: no pass yet']);
  });
});

describe("the poller's service on the machine", () => {
  const unit = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '../../vm/systemd', name), 'utf8').split('\n');
  const settings = (lines: string[], names: string[]) => lines.filter((line) => names.some((name) => line.startsWith(`${name}=`)));
  const poller = unit('code-reviewer-poller.service');

  it('runs as the same user, with the same credentials file and the same places, as the nightly run', () => {
    const shared = ['User', 'Group', 'EnvironmentFile', 'StateDirectory', 'StateDirectoryMode', 'WorkingDirectory', 'Environment'];
    expect(settings(poller, shared)).toEqual(settings(unit('code-reviewer-nightly.service'), shared));
    expect(settings(poller, ['EnvironmentFile'])).toEqual(['EnvironmentFile=/etc/code-reviewer/credentials.env']);
  });

  it('runs one pass of whatever is checked out, and cannot be started while one is going', () => {
    expect(settings(poller, ['Type', 'ExecStartPre', 'ExecStart'])).toEqual([
      'Type=oneshot',
      'ExecStart=/usr/bin/node --import tsx/esm src/cli.ts poll',
    ]);
  });

  it('is started three minutes after the last pass ended, unless the setting says otherwise', () => {
    expect(settings(unit('code-reviewer-poller.timer'), ['OnUnitInactiveSec'])).toEqual(['OnUnitInactiveSec=3min']);
    const setup = fs.readFileSync(path.join(import.meta.dirname, '../../vm/dev-vm-setup.sh'), 'utf8');
    // The setting replaces exactly that line, in a drop-in beside the timer.
    expect(setup).toContain("'# Written by dev-vm-setup.sh from POLL_EVERY.\\n[Timer]\\nOnUnitInactiveSec=\\nOnUnitInactiveSec=%s\\n' \"$POLL_EVERY\"");
    expect(setup).toContain('/etc/systemd/system/code-reviewer-poller.timer.d/interval.conf');
  });
});
