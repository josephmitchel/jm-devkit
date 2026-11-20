import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { leftByPasses, passDecision, pollerStatus, retryDelayMs, type EventRecord, type ProjectKnown, type ProjectSeen, type PullRequestSeen } from './poller.js';
import type { Run } from './runs.js';

const at = (time: string) => new Date(`2026-11-20T${time}Z`);

/** A handled project as a pass saw it at 12:00, with the pull requests GitHub listed. */
const widgets = (pullRequests: PullRequestSeen[] | null, slug = 'acme/widgets'): ProjectSeen => ({
  project: { slug, state: 'handled' },
  at: at('12:00:00'),
  pullRequests,
});

const merged = (number: number, when: string): PullRequestSeen => ({ number, updatedAt: at(when), mergedAt: at(when) });

/** What the database holds for a project whose first pass was at 09:00. */
const known = (events: EventRecord[] = [], slug = 'acme/widgets'): Map<string, ProjectKnown> =>
  new Map([[slug, { startedAt: at('09:00:00'), seenTo: at('11:57:00'), events }]]);

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
    const old: PullRequestSeen = { number: 11, updatedAt: at('11:59:00'), mergedAt: at('08:00:00') };
    const decision = passDecision({ projects: [widgets([old])] }, { projects: known() }, NOW);
    expect(decision.commands).toEqual([]);
    expect(decision.projects[0].found).toEqual([]);
  });

  it('runs nothing for a pull request that is open, or was closed without merging', () => {
    const open: PullRequestSeen = { number: 13, updatedAt: at('11:59:00'), mergedAt: null };
    expect(passDecision({ projects: [widgets([open])] }, { projects: known() }, NOW).commands).toEqual([]);
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
      // Not a kind of run today. A review the poller starts would outlast the pass that started it.
      running('run-20261120T110000Z-eeeeee', { kind: 'review' as Run['kind'] }),
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
