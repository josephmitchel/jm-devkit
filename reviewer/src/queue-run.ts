import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';

import { db, schema } from './db/client.js';
import { lockFault, locksHeld, MACHINE_LOCK, NIGHTLY_LOCK, tryLock } from './locks.js';
import { projectsLastSeen } from './poller-github.js';
import { inDatabase, takeEvent } from './poller-pass.js';
import { commandFor } from './poller.js';
import { classifyProjects } from './projects.js';
import {
  afterReviewRun,
  leftByQueue,
  noLongerHandled,
  queueDecision,
  timeLimitStopsAfter,
  type EventVerdict,
  type Job,
  type Machine,
  type QueueDecision,
  type QueuedEvent,
  type RunningJob,
} from './queue.js';
import { takeRecordedStepOrSayWhy } from './recorded-step.js';
import { errorType, interruptRunsLeftRunning, runLine, stopping, tidyAfterInterruption } from './runs.js';
import { OFF_THE_SLOT } from './stages/intake.js';

/**
 * One turn of the queue: if the machine is free, start the next queued review and see it through.
 * Everything that decides is in queue.ts; this file reads and writes the database around it. A
 * pass of the poller finds the events and leaves them on record; the machine starts a turn after
 * every pass, so a review that could not start on one turn is looked at again on the next.
 */

export type TurnOutcome = 'nothing started' | 'succeeded' | 'failed' | 'interrupted';

/**
 * Take one turn: at most one review does any work, and the turn lasts as long as it does. A
 * review that is turned away from its project's slot did none and took a moment, so the turn goes
 * on to the next job, and a project with reviews waiting for its slot does not hold up another's.
 */
export async function runQueueTurn(say: (line: string) => void = console.log): Promise<TurnOutcome> {
  const nightlyGoing = async () => (await locksHeld()).has(NIGHTLY_LOCK);
  // Taken before anything is decided, so nothing else can start an agent job meanwhile. Not
  // touched while a nightly run is going: it may be waiting to take it.
  const machine = (await nightlyGoing()) ? null : await tryLock(MACHINE_LOCK);
  try {
    // Before anything trusts the lock: no agent job is started under one that does not hold.
    const fault = machine && (await lockFault(machine));
    if (fault) say(fault.message);
    // With the machine held no agent job has a process, so a review still `running` has died.
    if (machine && !fault) await recordDeadRuns(say);
    const turnedAway = new Set<string>();
    for (;;) {
      // Looked at afresh before each job: a nightly run that has started since comes first.
      const seen: Machine = { agentJobRunning: machine === null, nightlyGoing: await nightlyGoing(), lockLost: machine?.lost() ?? false };
      const decision = await decide(seen);
      const next = decision.start;
      // A job turned away twice in one turn would be turned away for ever: leave it for the next.
      if (!next || !machine || stopping() || turnedAway.has(`${next.project} ${next.event}`)) {
        const waiting = [...(next ? [{ job: next, why: 'left for the next turn' }] : []), ...decision.waiting];
        say(
          waiting.length === 0
            ? 'nothing is queued'
            : `${waiting.length} job(s) left queued: ${waiting.map(({ job, why: reason }) => `${job.project} ${job.event} (${reason})`).join('; ')}`,
        );
        return 'nothing started';
      }
      const ran = await runJob(next, say, fault);
      if (ran.verdict !== 'waits for the slot') return ran.outcome;
      turnedAway.add(`${next.project} ${next.event}`);
    }
  } finally {
    await machine?.release();
  }
}

/**
 * The queue's decision from what is on record now. Whether a queued project is still handled is
 * read from what the last pass saw, which a turn follows by moments; GitHub is not asked again.
 */
async function decide(machine: Machine): Promise<QueueDecision> {
  const events = await queuedEvents();
  const queuedFor = [...new Set(events.map((e) => e.project))];
  const lastSeen = queuedFor.length === 0 ? [] : classifyProjects(await projectsLastSeen(inDatabase));
  return queueDecision(events, await slotsHeld(), machine, new Date(), noLongerHandled(queuedFor, lastSeen));
}

/** Every event still to be handled, with how the run of its last attempt ended. */
async function queuedEvents(): Promise<QueuedEvent[]> {
  const rows = await db
    .select({ event: schema.pollerEvents, runState: schema.runs.state })
    .from(schema.pollerEvents)
    .leftJoin(schema.runs, eq(schema.runs.id, schema.pollerEvents.runId))
    .where(isNull(schema.pollerEvents.handledAt));
  return rows.map(({ event, runState }) => ({
    project: event.project,
    event: event.event,
    foundAt: event.foundAt,
    attempts: event.attempts,
    attemptedAt: event.attemptedAt,
    lastRun: runState,
  }));
}

/** For each project, the pull requests whose reviews hold its review slot. */
async function slotsHeld(): Promise<Map<string, number[]>> {
  const rows = await db
    .select({ project: schema.repos.slug, pr: schema.reviews.prNumber })
    .from(schema.reviews)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.reviews.repoId))
    .where(notInArray(schema.reviews.state, [...OFF_THE_SLOT]));
  const slots = new Map<string, number[]>();
  for (const { project, pr } of rows) slots.set(project, [...(slots.get(project) ?? []), pr]);
  return slots;
}

/** A pull request's review as the verdict wants it, or null when it has none. */
async function reviewOnRecord(project: string, pr: number): Promise<{ id: number; state: string; timeLimitStops: number } | null> {
  const [row] = await db
    .select({ id: schema.reviews.id, state: schema.reviews.state, timeLimitStops: schema.reviews.timeLimitStops })
    .from(schema.reviews)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.reviews.repoId))
    .where(and(eq(schema.repos.slug, project), eq(schema.reviews.prNumber, pr)));
  return row ?? null;
}

/**
 * Record as interrupted the agent jobs an earlier turn left `running`, and for each do what its
 * work needs before it is taken up again: a review killed mid-stage is recorded as stopped, which
 * frees its project's slot. Its event is then tried again like any interrupted one.
 */
async function recordDeadRuns(say: (line: string) => void): Promise<void> {
  for (const run of await interruptRunsLeftRunning(leftByQueue)) {
    say(`an earlier turn of the queue never recorded how this ended: ${runLine(run)}`);
    const [event] = await db.select().from(schema.pollerEvents).where(eq(schema.pollerEvents.runId, run.id));
    const command = event ? commandFor(event.project, event.event, event.attempts) : null;
    if (command) await tidyAfterInterruption(run, command.args, 'found running');
    else say(`${run.id}: no event on record names it, so nothing more is done for it`);
  }
}

const VERDICT_WORDS = {
  handled: 'handled',
  'waits for the slot': "turned away: another review holds its project's slot, and this one starts when that has finished",
  'try again': 'not handled: tried again later',
} as const;

/**
 * Run one job as a recorded run of its own kind. Whether its event is then handled is not whether
 * the command exited 0: {@link afterReviewRun} says, from how the run ended and where it left the
 * review. Every event the job covers is handled with it. A job that is `refused` is recorded as a
 * run that failed with that error before it began, and its command is never started.
 */
async function runJob(job: Job, say: (line: string) => void, refused: Error | null = null): Promise<{ outcome: TurnOutcome; verdict: EventVerdict | null }> {
  if (!(await takeEvent(job))) {
    say(`${job.project} ${job.event}: already taken by another turn`);
    return { outcome: 'nothing started', verdict: null };
  }
  const events = and(eq(schema.pollerEvents.project, job.project), inArray(schema.pollerEvents.event, [job.event, ...job.covers]));
  const name = `${job.project} ${job.event}`;
  let verdict: EventVerdict | null = null;
  const finished = await takeRecordedStepOrSayWhy(
    {
      kind: job.kind,
      project: job.project,
      args: job.args,
      name,
      started: (run) =>
        `${name}: \`${job.args.join(' ')}\` started as ${run.id}` + (job.covers.length > 0 ? `, which also answers ${job.covers.join(', ')}` : ''),
      needsProjectRow: true,
      refused: refused && { why: refused.message, result: { state: 'failed', stage: 'starting', errorType: errorType(refused) } },
      onStart: async (run) => void (await db.update(schema.pollerEvents).set({ runId: run.id }).where(events)),
      beforeFinish: async (result) => {
        const review = await reviewOnRecord(job.project, Number(job.args[2]));
        const stops = review?.timeLimitStops ?? 0;
        verdict = afterReviewRun(result, review?.state ?? null, stops);
        const stopsNow = timeLimitStopsAfter(result, verdict, stops);
        if (review && stopsNow !== stops) await db.update(schema.reviews).set({ timeLimitStops: stopsNow }).where(eq(schema.reviews.id, review.id));
        // Before the run is recorded as over, as a pass does: an event must not be left looking
        // unhandled after the run that handled it.
        if (verdict === 'handled') await db.update(schema.pollerEvents).set({ handledAt: new Date() }).where(events);
        // A review turned away did no work: it is no success to close a failure issue on.
        return { note: `; ${job.event} ${VERDICT_WORDS[verdict]}`, report: verdict !== 'waits for the slot' };
      },
    },
    say,
  );
  if (finished === null) return { outcome: 'failed', verdict: null };
  return { outcome: finished.state === 'running' ? 'failed' : finished.state, verdict };
}

/** What `status` shows of the queue: the decision as it stands, the agent jobs running, and the machine. */
export async function queueStatusFacts(): Promise<{ decision: QueueDecision; running: RunningJob[]; machine: Machine }> {
  const held = await locksHeld();
  const machine: Machine = { agentJobRunning: held.has(MACHINE_LOCK), nightlyGoing: held.has(NIGHTLY_LOCK) };
  const rows = await db
    .select({ run: schema.runs, event: schema.pollerEvents })
    .from(schema.runs)
    .leftJoin(schema.pollerEvents, eq(schema.pollerEvents.runId, schema.runs.id))
    .where(and(eq(schema.runs.state, 'running'), inArray(schema.runs.kind, ['review', 'sweep'])))
    .orderBy(schema.runs.startedAt);
  const running = new Map<string, RunningJob>();
  for (const { run, event } of rows) {
    running.set(run.id, { run, args: event ? (commandFor(event.project, event.event, event.attempts)?.args ?? null) : null });
  }
  return { decision: await decide(machine), running: [...running.values()], machine };
}
