import type { RunState } from './db/schema.js';
import { toTheSecond as time } from './log.js';
import { commandFor, retryDelayMs, type Command } from './poller.js';
import type { Project } from './projects.js';
import { AGENT_KINDS, commandArgs, type ProjectCommand, type Run, type RunResult } from './runs.js';

/**
 * The queue of agent jobs as decisions: who has the machine, which queued review starts next, and
 * what a review's run leaves of the event that asked for it. Nothing here asks the database or
 * GitHub anything. A pass of the poller puts the events on record (poller.ts); queue-run.ts takes
 * one turn of the queue around these decisions.
 */

/** The machine, as a job that wants it finds it. */
export interface Machine {
  /** An agent job is running: a review, or the nightly run with its sweeps. */
  agentJobRunning: boolean;
  /** A nightly run is going: working, or waiting for a review to finish. */
  nightlyGoing: boolean;
  /** The asker held the machine's lock and the connection holding it has been lost. */
  lockLost?: boolean;
}

/**
 * Whether the machine is `asker`'s to take now. Agent jobs run one at a time, and the nightly run
 * comes first: it waits only for a review that is already running, and once it is going no review
 * starts until it is over, so a night's sweeps are never put back by a queue of reviews.
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
 * Why the machine no longer handles each of `projects` that it does not, from the projects as the
 * last pass saw them. A project is queued for only while it is handled, so one that is missing
 * from what the pass saw has had the App removed.
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

/** An agent job's event, as the record of events has it. */
export interface QueuedEvent {
  project: string;
  /** The event's key, such as `labelled:12`. */
  event: string;
  /** When a pass first found it. */
  foundAt: Date;
  /** How many times its command has been started. */
  attempts: number;
  /** When it was last started, or null when it never was. */
  attemptedAt: Date | null;
  /** How the run of its last attempt ended, `running` while it has not, null when there is none. */
  lastRun: RunState | null;
}

/**
 * One agent job: a command for the machine, and every event on record that it answers. `event` is
 * the first found that asks for it, the one its attempts are counted on.
 */
export interface Job extends Command {
  /** The later events still on record that the same command answers. One run handles them all. */
  covers: string[];
  foundAt: Date;
}

export interface QueueDecision {
  /** The job to start now, or null. */
  start: Job | null;
  /** Every other job, in the order found, with why it is not starting. */
  waiting: Array<{ job: Job; why: string }>;
}

/**
 * Why a job cannot be started yet, whatever the machine is doing, or null when it can.
 *
 * A review turned away from its project's review slot exited 0 with its event unhandled. It
 * starts again when no other review holds that slot, which is how a finished review starts the
 * next one queued behind it. It is also tried after the same wait as a failure, because a holder
 * whose pull request closed never finishes, and only a review claiming the slot retires it.
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
 * What the queue does now: the one job to start, if any, and why every other waits. `events` are
 * the unhandled events on record; `slots` gives, for a project, the pull requests whose reviews
 * hold its review slot; `notHandled` gives, for a project the machine no longer handles, why
 * ({@link noLongerHandled}), and no job of such a project starts. Events that ask for the same
 * command are one job, so a label and three replies on one pull request are one run. Jobs are
 * taken in the order found, across projects.
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

/** What becomes of the event a review's run was started for. */
export type EventVerdict = 'handled' | 'waits for the slot' | 'try again';

// How many times in a row a review stopped by its time limit is resumed before it is left stopped.
const RESUMED_AT_MOST = 2;

/**
 * What a review's run leaves of the event that asked for it, from how the run ended, the state the
 * review is in afterwards (null when it has no review) and how many times in a row its time limit
 * had already stopped it. Exit 0 does not mean the review finished; an event is handled once its
 * review needs nothing more from it:
 *
 * - the review passed, or waits for answers (the owner's reply is an event of its own);
 * - the review stopped in one of its stages: it has said so on the pull request, and the owner's
 *   comment there retries it, so it is not started again unasked;
 * - its time limit stopped it for the third time running: the same, so a review that keeps running
 *   out its limit cannot spend the subscription all night.
 *
 * A review turned away from its project's slot still waits for it. A run that failed before the
 * review did anything, or that its time limit, the service stopping or a restart interrupted, is
 * tried again, which resumes the review from the stage it was in.
 */
export function afterReviewRun(result: Pick<RunResult, 'state' | 'stage' | 'errorType'>, review: string | null, timeLimitStops = 0): EventVerdict {
  if (result.state === 'succeeded') return review === 'pending' || review === 'failed' ? 'waits for the slot' : 'handled';
  if (result.state === 'interrupted') return result.errorType === 'time limit' && timeLimitStops >= RESUMED_AT_MOST ? 'handled' : 'try again';
  // Before a review's first stage nothing is recorded on it and nothing is said on its pull request.
  return result.stage === 'starting' || result.stage === 'pending' ? 'try again' : 'handled';
}

/**
 * How many times in a row a review's time limit has stopped it, after a run of it: one more for a
 * stop that is resumed, none once its event is handled, and unchanged by any other run.
 */
export function timeLimitStopsAfter(result: Pick<RunResult, 'state' | 'stage' | 'errorType'>, verdict: EventVerdict, before: number): number {
  if (verdict === 'handled') return 0;
  return result.state === 'interrupted' && result.errorType === 'time limit' ? before + 1 : before;
}

/**
 * Of the runs still recorded as `running`, the agent jobs an earlier turn of the queue left
 * behind: its process died before it could record how they ended. The queue runs a job only
 * while it holds the machine, so whoever holds the machine may call these dead. A review among
 * them is still recorded as working and holds its project's slot until it is recorded as stopped.
 */
export function leftByQueue(rows: Run[]): Run[] {
  return rows.filter((r) => r.state === 'running' && r.parentId === null && AGENT_KINDS.has(r.kind));
}

/** An agent job that is running, with its command when the record of events has it. */
export interface RunningJob {
  run: Run;
  command: ProjectCommand | null;
}

const jobLine = (job: Job) =>
  `${job.project} \`${commandArgs(job).join(' ')}\` (${[job.event, ...job.covers].join(', ')}), found ${time(job.foundAt)}`;

/** The `status` section for the queue: what is running, what starts next, and what waits and why. */
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
