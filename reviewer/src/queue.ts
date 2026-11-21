import type { RunState } from './db/schema.js';
import { toTheSecond as time } from './log.js';
import { commandFor, retryDelayMs, type Command } from './poller.js';
import type { Project } from './projects.js';
import { AGENT_KINDS, commandArgs, type ProjectCommand, type Run, type RunResult } from './runs.js';

/** Nothing here asks the database or GitHub anything. */

export interface Machine {
  /** An agent job is running: a review, or the nightly run with its sweeps. */
  agentJobRunning: boolean;
  /** Working, or waiting for a review to finish. */
  nightlyGoing: boolean;
  /** The asker held the machine's lock and the connection holding it has been lost. */
  lockLost?: boolean;
}

/**
 * The nightly run comes first: it waits only for a review that is already running, and once it is
 * going no review starts until it is over.
 */
export function machineFor(asker: 'nightly run' | 'review', machine: Machine): { take: true } | { take: false; why: string } {
  if (asker === 'nightly run') {
    return machine.agentJobRunning ? { take: false, why: 'a review is running: the nightly run starts when it has finished' } : { take: true };
  }
  if (machine.lockLost) return { take: false, why: "the connection holding the machine's lock was lost: nothing more starts this turn" };
  if (machine.nightlyGoing) return { take: false, why: 'the nightly run has the machine' };
  if (machine.agentJobRunning) return { take: false, why: 'another agent job is running' };
  return { take: true };
}

/**
 * From the projects as the last pass saw them. A project is queued for only while it is handled, so
 * one missing from what the pass saw has had the App removed.
 */
export function noLongerHandled(projects: string[], lastSeen: Project[]): Map<string, string> {
  const why = new Map<string, string>();
  for (const slug of projects) {
    const seen = lastSeen.find((p) => p.slug === slug);
    if (!seen) why.set(slug, "the code reviewer's App is no longer installed on it");
    else if (seen.state !== 'handled') why.set(slug, `${seen.state}: ${seen.reason.replace(/\s+/g, ' ')}`);
  }
  return why;
}

export interface QueuedEvent {
  project: string;
  event: string;
  foundAt: Date;
  attempts: number;
  attemptedAt: Date | null;
  /** `running` while it has not ended, null when there is none. */
  lastRun: RunState | null;
}

/**
 * A command and every event on record that it answers. `event` is the first found, the one its
 * attempts are counted on.
 */
export interface Job extends Command {
  /** One run handles them all. */
  covers: string[];
  foundAt: Date;
}

export interface QueueDecision {
  start: Job | null;
  /** In the order found, each with why it is not starting. */
  waiting: Array<{ job: Job; why: string }>;
}

/**
 * A review turned away from its project's slot exited 0 with its event unhandled. It starts again
 * when no other review holds the slot, and also after the same wait as a failure: a holder whose
 * pull request closed never finishes, and only a review claiming the slot retires it.
 */
function notYet(first: QueuedEvent, job: Job, holders: number[], now: Date): string | null {
  if (first.lastRun === 'running') return 'its last run is still going';
  if (first.attemptedAt === null) return null;
  const tryAgainAt = new Date(first.attemptedAt.getTime() + retryDelayMs(first.attempts));
  const waited = now >= tryAgainAt;
  if (first.lastRun === 'succeeded') {
    const ahead = holders.filter((pr) => pr !== job.pr);
    return ahead.length === 0 || waited ? null : `waits for its project's review slot, held by the review of #${ahead[0]}`;
  }
  return waited ? null : `tried ${first.attempts} time${first.attempts === 1 ? '' : 's'}: tried again after ${time(tryAgainAt)}`;
}

/**
 * `slots` gives the pull requests whose reviews hold a project's review slot; `notHandled` gives
 * why for a project the machine no longer handles. Events that ask for the same command are one
 * job. Jobs are taken in the order found, across projects.
 */
export function queueDecision(
  events: QueuedEvent[],
  slots: ReadonlyMap<string, number[]>,
  machine: Machine,
  now: Date,
  notHandled: ReadonlyMap<string, string> = new Map(),
): QueueDecision {
  const jobs = new Map<string, { job: Job; first: QueuedEvent }>();
  const oldestFirst = [...events].sort((a, b) => a.foundAt.getTime() - b.foundAt.getTime() || a.event.localeCompare(b.event));
  for (const event of oldestFirst) {
    const command = commandFor(event.project, event.event, event.attempts);
    if (!command || !AGENT_KINDS.has(command.kind)) continue;
    const key = commandArgs(command).join(' ');
    const same = jobs.get(key);
    if (same) same.job.covers.push(event.event);
    else jobs.set(key, { job: { ...command, covers: [], foundAt: event.foundAt }, first: event });
  }

  const decision: QueueDecision = { start: null, waiting: [] };
  const turn = machineFor('review', machine);
  for (const { job, first } of jobs.values()) {
    const left = notHandled.get(job.project);
    const why = left === undefined ? notYet(first, job, slots.get(job.project) ?? [], now) : `the machine no longer handles its project (${left})`;
    if (why !== null) decision.waiting.push({ job, why });
    else if (!turn.take) decision.waiting.push({ job, why: turn.why });
    else if (decision.start !== null) decision.waiting.push({ job, why: 'its turn comes after the job ahead of it' });
    else decision.start = job;
  }
  return decision;
}

export type EventVerdict = 'handled' | 'waits for the slot' | 'try again';

// How many times in a row a review stopped by its time limit is resumed before it is left stopped.
const RESUMED_AT_MOST = 2;

/**
 * Exit 0 does not mean the review finished. Handled: it passed or waits for answers; it stopped in
 * a stage and said so on the pull request, where the owner's comment retries it; or its time limit
 * stopped it a third time running. Turned away: it still waits for the slot. Otherwise it is tried
 * again, which resumes the review.
 */
export function afterReviewRun(result: Pick<RunResult, 'state' | 'stage' | 'errorType'>, review: string | null, timeLimitStops = 0): EventVerdict {
  if (result.state === 'succeeded') return review === 'pending' || review === 'failed' ? 'waits for the slot' : 'handled';
  if (result.state === 'interrupted') return result.errorType === 'time limit' && timeLimitStops >= RESUMED_AT_MOST ? 'handled' : 'try again';
  // Before a review's first stage nothing is recorded on it and nothing is said on its pull request.
  return result.stage === 'starting' || result.stage === 'pending' ? 'try again' : 'handled';
}

/** One more for a stop that is resumed, none once the event is handled, unchanged otherwise. */
export function timeLimitStopsAfter(result: Pick<RunResult, 'state' | 'stage' | 'errorType'>, verdict: EventVerdict, before: number): number {
  if (verdict === 'handled') return 0;
  return result.state === 'interrupted' && result.errorType === 'time limit' ? before + 1 : before;
}

/**
 * The queue runs a job only while it holds the machine, so whoever holds the machine may call these
 * dead. A review among them still holds its project's slot until it is recorded as stopped.
 */
export function leftByQueue(rows: Run[]): Run[] {
  return rows.filter((r) => r.state === 'running' && r.parentId === null && AGENT_KINDS.has(r.kind));
}

export interface RunningJob {
  run: Run;
  command: ProjectCommand | null;
}

const jobLine = (job: Job) =>
  `${job.project} \`${commandArgs(job).join(' ')}\` (${[job.event, ...job.covers].join(', ')}), found ${time(job.foundAt)}`;

export function queueStatus(decision: QueueDecision, running: RunningJob[], machine: Machine): string[] {
  const lines = [
    ...(machine.nightlyGoing ? ['  a nightly run is going: reviews wait until it is over'] : []),
    ...running.map(
      ({ run, command }) =>
        `  running: ${run.project} ${run.kind}${command ? ` \`${commandArgs(command).join(' ')}\`` : ''} since ${time(run.startedAt)}, ${run.id}`,
    ),
    ...(decision.start ? [`  next: ${jobLine(decision.start)}`] : []),
    ...decision.waiting.map(({ job, why }) => `  waiting: ${jobLine(job)}: ${why}`),
  ];
  return lines.length === 0 ? ['the queue: nothing running, nothing waiting'] : ['the queue: agent jobs, one at a time on this machine', ...lines];
}
