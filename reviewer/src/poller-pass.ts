import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import { db, pool, schema } from './db/client.js';
import { reportRun } from './failure-report.js';
import { appCredentials } from './gh-auth.js';
import { LOCK_CLASS } from './migrate.js';
import { commentsSeen, projectsSeen, pullRequestsSeen, type Asking, type Memory } from './poller-github.js';
import {
  commandFor,
  gatesOfPassedReviews,
  leftByPasses,
  passDecision,
  repliesToRead,
  type Command,
  type EventRecord,
  type EventRow,
  type ProjectKnown,
  type ProjectSeen,
  type ReviewKnown,
} from './poller.js';
import { ensureProjectRow } from './project-row.js';
import { classifyProjects, projectLine } from './projects.js';
import { OWN_COMMENT_KINDS } from './reply-authority.js';
import { errorType, finishRun, interruptRunsLeftRunning, runCommand, runLine, startRun, stopping, type RunResult } from './runs.js';

/**
 * One pass of the poller: ask GitHub what has happened in each handled project, let
 * {@link passDecision} say what to run, and run it. A review is not run here: its event goes on
 * record and the queue starts it (queue-run.ts). Everything that decides is in poller.ts and
 * everything that asks GitHub in poller-github.ts; this file only reads and writes the database
 * around them, in an order that keeps an event from being handled twice or lost.
 */

// Held for the whole of a pass, on a connection of its own, so it is let go when the process dies.
const PASS_LOCK_KEY = 2;
// Longer than GitHub ever takes to answer; a request that hangs must not hold every later pass.
const ANSWER_WITHIN_MS = 30_000;

export type PassOutcome = 'succeeded' | 'failed' | 'not started';

/**
 * Do a pass's work unless another pass is doing its own, in which case nothing is done. Passes
 * never overlap: the timer does not start a service that is still running, and this lock covers a
 * pass started by hand beside it.
 */
export async function underPassLock<T>(work: () => Promise<T>): Promise<T | 'not started'> {
  const lock = await pool.connect();
  try {
    const held = await lock.query('select pg_try_advisory_lock($1, $2) as held', [LOCK_CLASS, PASS_LOCK_KEY]);
    if (!held.rows[0].held) return 'not started';
    try {
      return await work();
    } finally {
      await lock.query('select pg_advisory_unlock($1, $2)', [LOCK_CLASS, PASS_LOCK_KEY]);
    }
  } finally {
    lock.release();
  }
}

/** Run one pass, unless another is still going. */
export async function runPass(say: (line: string) => void = console.log): Promise<PassOutcome> {
  const outcome = await underPassLock(() => pass(say));
  if (outcome === 'not started') say('another pass is still going: this one leaves it to finish');
  return outcome;
}

const inDatabase: Memory = {
  async recall(question) {
    const [row] = await db.select().from(schema.githubAnswers).where(eq(schema.githubAnswers.question, question));
    return row ? { etag: row.etag, answer: row.answer } : null;
  },
  async keep(question, { etag, answer }) {
    const kept = { etag, answer, askedAt: new Date() };
    await db
      .insert(schema.githubAnswers)
      .values({ question, ...kept })
      .onConflictDoUpdate({ target: schema.githubAnswers.question, set: kept });
  },
};

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function pass(say: (line: string) => void): Promise<PassOutcome> {
  // Under the lock no other pass is going, so a run of a pass still `running` has no process.
  for (const run of await interruptRunsLeftRunning(leftByPasses)) say(`an earlier pass never recorded how this ended: ${runLine(run)}`);

  const credentials = appCredentials();
  if (!credentials) throw new Error("a pass needs the code reviewer's App: set REVIEWER_APP_CLIENT_ID and REVIEWER_APP_PRIVATE_KEY");
  const asking: Asking = {
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(ANSWER_WITHIN_MS) }),
    credentials,
    memory: inDatabase,
    now: () => new Date(),
    tally: { asked: 0, unchanged: 0 },
  };
  // Projects GitHub did not answer about. They are left alone this pass and the pass ends failed.
  let unanswered = 0;

  const { projects: read, unread } = await projectsSeen(asking);
  for (const { slug, why: reason } of unread) {
    say(`${slug} left alone this pass: its default branch could not be read (${reason})`);
    unanswered++;
  }
  const found = new Map(read.map((p) => [p.slug, p]));

  const seen: ProjectSeen[] = [];
  const known = new Map<string, ProjectKnown>();
  const etags = new Map<string, string | null>();
  for (const project of classifyProjects(read.map(({ slug, observed }) => ({ slug, ...observed })))) {
    const { token, fresh } = found.get(project.slug)!;
    if (project.state !== 'handled') {
      // Said when it is learnt, not every few minutes.
      if (fresh) say(projectLine(project));
      seen.push({ project, at: asking.now(), pullRequests: null });
      continue;
    }
    try {
      const [position] = await db.select().from(schema.pollerProjects).where(eq(schema.pollerProjects.project, project.slug));
      const listing = await pullRequestsSeen(asking, project.slug, token, { etag: position?.pullsEtag ?? null, seenTo: position?.seenTo ?? null });
      if (position) {
        // Every event on record when the listing is read; otherwise only those still to be handled.
        const events = await eventsOnRecord(project.slug, listing.pullRequests === null);
        // Both asked of a pull request in the listing only, so not read when there is none.
        const passedGates = listing.pullRequests === null ? new Map<number, string[]>() : await passedGatesOnRecord(project.slug);
        // Read after the listing: a comment in the listing was then written before the reviews
        // were read, so a review that waits for it is seen to be waiting.
        const reviews = listing.pullRequests === null ? [] : await reviewsKnown(project.slug);
        const before: ProjectKnown = { startedAt: position.startedAt, seenTo: position.seenTo, events, passedGates, reviews };
        for (const { pr, since } of repliesToRead(listing.pullRequests ?? [], before)) {
          pr.comments = await commentsSeen(asking, project.slug, token, pr.number, since);
        }
        known.set(project.slug, before);
      }
      etags.set(project.slug, listing.etag);
      seen.push({ project, at: listing.at, pullRequests: listing.pullRequests });
    } catch (err) {
      say(`${project.slug} left alone this pass: its pull requests could not be read (${why(err)})`);
      unanswered++;
    }
  }

  const decision = passDecision({ projects: seen }, { projects: known }, asking.now());

  for (const p of decision.projects) {
    await recordPass(p.project, p.found, { startedAt: p.startedAt, seenTo: p.seenTo, pullsEtag: etags.get(p.project) ?? null, lastPassAt: asking.now() });
    if (p.firstPass) say(`${p.project}: first pass. Watched from ${p.startedAt.toISOString()}; nothing before that is acted on`);
  }
  // On record now, and not this pass's to run: the queue starts it when the machine is free.
  for (const job of decision.queued) say(`${job.project} ${job.event}: \`${job.args.join(' ')}\` queued`);

  const ended: string[] = [];
  for (const command of decision.commands) {
    // Whatever is not started stays on record for the next pass.
    if (stopping()) break;
    ended.push(await handle(command, say));
  }
  const count = (state: string) => ended.filter((e) => e === state).length;
  const left = decision.commands.length - ended.length;
  say(
    `pass over ${decision.projects.length} handled project(s), ${decision.leftAlone.length} not handled` +
      (unanswered > 0 ? `, ${unanswered} that could not be read` : '') +
      `: ${decision.projects.reduce((n, p) => n + p.found.length, 0)} event(s) found` +
      (decision.queued.length > 0 ? ` (${decision.queued.length} for the queue)` : '') +
      `, ${ended.length} command(s) run` +
      (ended.length > 0 ? ` (${count('succeeded')} succeeded, ${count('failed')} failed, ${count('interrupted')} interrupted)` : '') +
      (left > 0 ? `, ${left} left for the next pass` : '') +
      `. GitHub was asked ${asking.tally.asked} time(s) and answered "unchanged" to ${asking.tally.unchanged}`,
  );
  return unanswered > 0 || ended.some((e) => e !== 'succeeded' && e !== 'taken') || left > 0 ? 'failed' : 'succeeded';
}

/**
 * Put on record what a pass found in a project, together with where the pass got to, before
 * anything is run. From then on the record alone says what is still to be handled, so the next
 * pass can be told "unchanged" by GitHub and lose nothing. An event already on record stays as it
 * is. `startedAt` is kept from the project's first pass.
 */
export async function recordPass(
  project: string,
  found: string[],
  position: { startedAt: Date; seenTo: Date; pullsEtag: string | null; lastPassAt: Date },
): Promise<void> {
  const { startedAt, ...moving } = position;
  await db.transaction(async (tx) => {
    if (found.length > 0) {
      await tx.insert(schema.pollerEvents).values(found.map((event) => ({ project, event }))).onConflictDoNothing();
    }
    await tx
      .insert(schema.pollerProjects)
      .values({ project, startedAt, ...moving })
      .onConflictDoUpdate({ target: schema.pollerProjects.project, set: moving });
  });
}

const keyOf = (command: Pick<Command, 'project' | 'event'>) =>
  and(eq(schema.pollerEvents.project, command.project), eq(schema.pollerEvents.event, command.event));

/**
 * Take an event to run its command, or return false when it is not this pass's to take. The count
 * of attempts is raised only from the number the pass read, and only while the event is
 * unhandled, so of two passes that decided the same command one finds nothing to take.
 */
export async function takeEvent(command: Pick<Command, 'project' | 'event' | 'attempts'>, now: Date = new Date()): Promise<boolean> {
  const taken = await db
    .update(schema.pollerEvents)
    .set({ attempts: command.attempts + 1, attemptedAt: now, runId: null })
    .where(and(keyOf(command), isNull(schema.pollerEvents.handledAt), eq(schema.pollerEvents.attempts, command.attempts)))
    .returning();
  return taken.length > 0;
}

/** A project's reviews as the decision wants them, each with the comments the code reviewer posted for it. */
async function reviewsKnown(project: string): Promise<ReviewKnown[]> {
  const reviews = await db
    .select({ id: schema.reviews.id, pr: schema.reviews.prNumber, state: schema.reviews.state, since: schema.reviews.updatedAt })
    .from(schema.reviews)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.reviews.repoId))
    .where(eq(schema.repos.slug, project));
  if (reviews.length === 0) return [];
  const posted = await db
    .select({ reviewId: schema.githubArtifacts.reviewId, githubId: schema.githubArtifacts.githubId, kind: schema.githubArtifacts.kind })
    .from(schema.githubArtifacts)
    .where(inArray(schema.githubArtifacts.reviewId, reviews.map((r) => r.id)));
  return reviews.map(({ id, ...review }) => ({
    ...review,
    ownComments: posted
      .filter((a) => a.reviewId === id && OWN_COMMENT_KINDS.has(a.kind))
      .map((a) => Number(a.githubId))
      .filter(Number.isFinite),
  }));
}

/**
 * Forget that a pull request's review was ever asked for: `reset` deletes the review, and the
 * events that asked for it go with it, so labelling the pull request again starts a new one.
 */
export async function forgetReviewEvents(project: string, pr: number): Promise<void> {
  const rows = await db.select().from(schema.pollerEvents).where(eq(schema.pollerEvents.project, project));
  const asked = rows.filter((row) => {
    const command = commandFor(project, row.event, row.attempts);
    return command?.kind === 'review' && Number(command.args[2]) === pr;
  });
  if (asked.length === 0) return;
  await db
    .delete(schema.pollerEvents)
    .where(and(eq(schema.pollerEvents.project, project), inArray(schema.pollerEvents.event, asked.map((row) => row.event))));
}

/** A project's events as the decision wants them. `waitingOnly` leaves out the ones already handled. */
async function eventsOnRecord(project: string, waitingOnly: boolean): Promise<EventRecord[]> {
  const rows = await db
    .select({ event: schema.pollerEvents, runState: schema.runs.state })
    .from(schema.pollerEvents)
    .leftJoin(schema.runs, eq(schema.runs.id, schema.pollerEvents.runId))
    .where(and(eq(schema.pollerEvents.project, project), waitingOnly ? isNull(schema.pollerEvents.handledAt) : undefined))
    .orderBy(asc(schema.pollerEvents.foundAt), asc(schema.pollerEvents.event));
  return rows.map(({ event, runState }) => ({
    event: event.event,
    handledAt: event.handledAt,
    attempts: event.attempts,
    attemptedAt: event.attemptedAt,
    running: runState === 'running',
  }));
}

/** The commits the gate of each of a project's passed reviews is on, by pull request. */
async function passedGatesOnRecord(project: string): Promise<Map<number, string[]>> {
  const statuses = schema.githubArtifacts;
  const rows = await db
    .select({ prNumber: schema.reviews.prNumber, sha: statuses.sha, payload: statuses.payload })
    .from(schema.reviews)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.reviews.repoId))
    .leftJoin(statuses, and(eq(statuses.reviewId, schema.reviews.id), eq(statuses.kind, 'commit_status')))
    .where(and(eq(schema.repos.slug, project), eq(schema.reviews.state, 'passed')))
    .orderBy(asc(schema.reviews.prNumber), asc(statuses.id));
  return gatesOfPassedReviews(rows);
}

/**
 * Run one event's command as a recorded run of its own, and record the event as handled only if
 * the command succeeded. A failed or interrupted command leaves the event on record with one
 * more attempt against it, to be tried again by a later pass.
 */
async function handle(command: Command, say: (line: string) => void): Promise<'succeeded' | 'failed' | 'interrupted' | 'taken'> {
  const key = keyOf(command);
  if (!(await takeEvent(command))) {
    say(`${command.project} ${command.event}: already taken by another pass`);
    return 'taken';
  }
  try {
    // A project registers itself (ADR 0004): a command needs its row, and this may be its first run.
    await ensureProjectRow(command.project);
    const run = await startRun({ kind: command.kind, project: command.project });
    await db.update(schema.pollerEvents).set({ runId: run.id }).where(key);
    say(`${command.project} ${command.event}: \`${command.args.join(' ')}\` started as ${run.id}`);
    let result: RunResult;
    try {
      result = await runCommand(run, command.args);
    } catch (err) {
      result = { state: 'failed', stage: 'starting', errorType: errorType(err) };
    }
    // Before the run is recorded as over: if this process dies between the two writes, the event
    // must not be left looking unhandled after a command that succeeded.
    if (result.state === 'succeeded') await db.update(schema.pollerEvents).set({ handledAt: new Date() }).where(key);
    const finished = await finishRun(run, result);
    say(runLine(finished));
    await reportRun(finished, say);
    return finished.state === 'running' ? 'failed' : finished.state;
  } catch (err) {
    // The run could not be recorded at all (the database, the state directory).
    say(`${command.project} ${command.event} could not be run: ${why(err)}`);
    return 'failed';
  }
}

// How many handled events `status` shows for a project. Those still to be handled are all shown.
const RECENT_EVENTS = 5;

/** What `status` shows of the poller: each project's position, and its recent and unhandled events. */
export async function pollerStatusRows(slug?: string): Promise<{ projects: Array<typeof schema.pollerProjects.$inferSelect>; events: EventRow[] }> {
  const projects = await db
    .select()
    .from(schema.pollerProjects)
    .where(slug ? eq(schema.pollerProjects.project, slug) : undefined);
  // Name order, as everywhere else the projects are listed.
  projects.sort((a, b) => a.project.toLowerCase().localeCompare(b.project.toLowerCase()));
  const events: EventRow[] = [];
  for (const { project } of projects) {
    const of = (handled: boolean) =>
      db
        .select({ event: schema.pollerEvents, run: schema.runs })
        .from(schema.pollerEvents)
        .leftJoin(schema.runs, eq(schema.runs.id, schema.pollerEvents.runId))
        .where(and(eq(schema.pollerEvents.project, project), (handled ? isNotNull : isNull)(schema.pollerEvents.handledAt)))
        .orderBy(desc(schema.pollerEvents.foundAt));
    const rows = [...(await of(true).limit(RECENT_EVENTS)), ...(await of(false))];
    rows.sort((a, b) => a.event.foundAt.getTime() - b.event.foundAt.getTime() || a.event.event.localeCompare(b.event.event));
    events.push(...rows.map(({ event, run }) => ({ ...event, run })));
  }
  return { projects, events };
}
