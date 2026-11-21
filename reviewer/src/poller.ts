import type { RunKind, pollerEvents, pollerProjects } from './db/schema.js';
import { toTheSecond as time } from './log.js';
import type { Project } from './projects.js';
import { countsAsReply } from './reply-authority.js';
import { AGENT_KINDS, commandKind, runLine, runOutputPath, type ProjectCommand, type Run } from './runs.js';

/** Nothing here asks GitHub or the database anything. */

export interface PullRequestSeen {
  number: number;
  updatedAt: Date;
  mergedAt: Date | null;
  open: boolean;
  headSha: string;
  draft: boolean;
  labels: string[];
  /**
   * Comments and submitted reviews alike. Read only for a pull request whose review waits on the
   * owner; empty for every other.
   */
  comments: CommentSeen[];
}

export interface CommentSeen {
  id: number;
  at: Date;
  /** What GitHub says its author is to the project: `OWNER`, `MEMBER`, `NONE` and so on. */
  authorAssociation: string;
}

export interface ReviewKnown {
  pr: number;
  state: string;
  /** When it entered that state. */
  since: Date;
  /** The comments the code reviewer posted for it, which are never the owner's word. */
  ownComments: number[];
}

/** Its pull requests are asked for only when the machine handles it. */
export interface ProjectSeen {
  project: Project;
  /** GitHub's clock when it was asked. */
  at: Date;
  /** As far back as the last pass got to. Null when GitHub answered that nothing has changed since that pass. */
  pullRequests: PullRequestSeen[] | null;
}

export interface EventRecord {
  /** The event's key, `<name>:<subject>`, such as `merged:12`. The same event always has the same key. */
  event: string;
  handledAt: Date | null;
  attempts: number;
  attemptedAt: Date | null;
  /** Whether the run of its last attempt is still recorded as running. */
  running: boolean;
}

export interface ProjectKnown {
  /** Nothing that happened before the first pass is acted on. */
  startedAt: Date;
  /** The newest change the last pass's reading saw. */
  seenTo: Date;
  events: EventRecord[];
  reviews: ReviewKnown[];
  /** For each pull request whose review has passed: the commits that review's gate is on, carried ones included. */
  passedGates: ReadonlyMap<number, readonly string[]>;
}

/** A review with no status on record has a row with no commit. */
export function gatesOfPassedReviews(rows: Array<{ prNumber: number; sha: string | null; payload: unknown }>): Map<number, string[]> {
  const gates = new Map<number, string[]>();
  for (const { prNumber, sha, payload } of rows) {
    const gated = gates.get(prNumber) ?? [];
    if (sha && (payload as { state?: string } | null)?.state === 'success') gated.push(sha);
    gates.set(prNumber, gated);
  }
  return gates;
}

export interface Command extends ProjectCommand {
  event: string;
  kind: RunKind;
  attempts: number;
}

export interface PassDecision {
  commands: Command[];
  /** Found for the first time: on record for the queue, which starts them. */
  queued: Command[];
  /** For each handled project: the events found for the first time, and where this pass got to. */
  projects: Array<{ project: string; firstPass: boolean; startedAt: Date; seenTo: Date; found: string[] }>;
  /** Nothing is run for them and nothing recorded. */
  leftAlone: Project[];
}

/** An event's key is the rule's name and the subject the rule gives, `<name>:<subject>`. */
interface EventRule {
  command: ProjectCommand['command'];
  /**
   * Null when the pull request shows no such event. The same event always gives the same subject, a
   * new one a new subject. It starts with the pull request's number, all the command is built from,
   * so the command can be retried from the record ({@link commandFor}).
   */
  subject(pr: PullRequestSeen, known: ProjectKnown): string | null;
}

// The label that asks for a pull request's review (plugin/install/label.mjs creates it).
const REVIEW_LABEL = 'review-now';
// Waiting for answers, or stopped with a notice that says a comment retries it.
const WAITS_ON_OWNER = new Set(['awaiting_answers', 'failed']);

function waitingOn(pr: PullRequestSeen, reviews: ReviewKnown[]): ReviewKnown | null {
  const waiting = reviews.find((r) => r.pr === pr.number && WAITS_ON_OWNER.has(r.state));
  return pr.open && waiting ? waiting : null;
}

/**
 * A comment moves its pull request's time of last change, so only those changed since the last
 * pass's reading can have a new one.
 */
export function repliesToRead(pullRequests: PullRequestSeen[], known: ProjectKnown): Array<{ pr: PullRequestSeen; since: Date }> {
  return pullRequests.flatMap((pr) => {
    const waiting = waitingOn(pr, known.reviews);
    // Not later-than: GitHub's times are whole seconds, and a second comment can share one.
    return waiting && pr.updatedAt >= known.seenTo ? [{ pr, since: waiting.since }] : [];
  });
}

/** A new event is a new entry here. */
const EVENTS: Record<string, EventRule> = {
  merged: {
    command: 'landed',
    subject: (pr, known) => (pr.mergedAt !== null && pr.mergedAt > known.startedAt ? String(pr.number) : null),
  },
  // `carry-gate` decides whether the new head holds only reviewed code; this only notices the head.
  'head-moved': {
    command: 'carry-gate',
    subject: (pr, known) => {
      // The listing has no time for a head. A push changes the pull request, so one not changed
      // since the first pass still has the head it had then.
      if (!pr.open || pr.updatedAt <= known.startedAt) return null;
      const gated = known.passedGates.get(pr.number);
      return gated && !gated.includes(pr.headSha) ? `${pr.number}@${pr.headSha}` : null;
    },
  },
  // A label has no time of its own, so "since the first pass" is the pull request having changed
  // since. A review that never left `pending` has not started and counts as none. One command
  // starts, continues and retries a review: its own state says which.
  labelled: {
    command: 'run',
    subject: (pr, known) => {
      const asked = pr.open && !pr.draft && pr.labels.includes(REVIEW_LABEL) && pr.updatedAt > known.startedAt;
      const started = known.reviews.some((r) => r.pr === pr.number && r.state !== 'pending');
      return asked && !started ? String(pr.number) : null;
    },
  },
  // The event is the newest such comment, so several written before a pass are one event.
  replied: {
    command: 'run',
    subject: (pr, known) => {
      const waiting = waitingOn(pr, known.reviews);
      if (!waiting) return null;
      const own = new Set(waiting.ownComments);
      const newest = pr.comments
        .filter((c) => c.at > waiting.since && c.at > known.startedAt && countsAsReply(c, own))
        // Of two written in the same second, the one listed later: GitHub lists them as written.
        .reduce<CommentSeen | null>((last, c) => (last === null || c.at >= last.at ? c : last), null);
      return newest === null ? null : `${pr.number}/${newest.id}`;
    },
  },
};

/** The kinds of run that are started for an event, by a pass or by the queue. */
export const EVENT_RUN_KINDS: ReadonlySet<RunKind> = new Set(Object.values(EVENTS).map((rule) => commandKind(rule.command)));

// The one place an event's key is read back: its rule's name, then its pull request's number.
const EVENT_KEY = /^([^:]+):(\d+)/;

/** Null when no rule knows the key. */
export function commandFor(project: string, event: string, attempts: number): Command | null {
  const [, name, pr] = EVENT_KEY.exec(event) ?? [];
  if (name === undefined || !Object.hasOwn(EVENTS, name)) return null;
  const { command } = EVENTS[name];
  return { project, event, kind: commandKind(command), command, pr: Number(pr), attempts };
}

const MINUTE_MS = 60_000;
const LONGEST_WAIT_MS = 6 * 60 * MINUTE_MS;

/**
 * A minute, then twice as long each time, up to six hours. The first wait is shorter than any
 * interval between passes, so one failure is tried again on the next pass. An event is never given
 * up on.
 */
export function retryDelayMs(attempts: number): number {
  return Math.min(MINUTE_MS * 2 ** Math.min(attempts - 1, 30), LONGEST_WAIT_MS);
}

function due(event: EventRecord, now: Date): boolean {
  if (event.handledAt !== null || event.running) return false;
  return event.attemptedAt === null || now.getTime() - event.attemptedAt.getTime() >= retryDelayMs(event.attempts);
}

/**
 * A project's first pass only marks where it starts from. After that: the command for every new
 * event, and for every event on record whose command has not succeeded and whose wait is over. An
 * agent job's event is never run here: it is returned as queued. `known` has an entry for each
 * project past its first pass.
 */
export function passDecision(
  seen: { projects: ProjectSeen[] },
  known: { projects: ReadonlyMap<string, ProjectKnown> },
  now: Date,
): PassDecision {
  const decision: PassDecision = { commands: [], queued: [], projects: [], leftAlone: [] };
  for (const { project, at, pullRequests } of seen.projects) {
    if (project.state !== 'handled') {
      decision.leftAlone.push(project);
      continue;
    }
    const before = known.projects.get(project.slug);
    if (!before) {
      decision.projects.push({ project: project.slug, firstPass: true, startedAt: at, seenTo: at, found: [] });
      continue;
    }
    const recorded = new Set(before.events.map((e) => e.event));
    const found: string[] = [];
    const oldestFirst = [...(pullRequests ?? [])].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.number - b.number);
    for (const pr of oldestFirst) {
      for (const [name, rule] of Object.entries(EVENTS)) {
        const subject = rule.subject(pr, before);
        const event = `${name}:${subject}`;
        if (subject === null || recorded.has(event)) continue;
        recorded.add(event);
        found.push(event);
      }
    }
    const again = before.events.filter((e) => due(e, now)).map((e) => ({ event: e.event, attempts: e.attempts }));
    for (const { event, attempts } of [...again, ...found.map((event) => ({ event, attempts: 0 }))]) {
      const command = commandFor(project.slug, event, attempts);
      if (!command) continue;
      if (!AGENT_KINDS.has(command.kind)) decision.commands.push(command);
      else if (found.includes(event)) decision.queued.push(command);
    }
    const newest = Math.max(before.seenTo.getTime(), ...(pullRequests ?? []).map((pr) => pr.updatedAt.getTime()));
    decision.projects.push({ project: project.slug, firstPass: false, startedAt: before.startedAt, seenTo: new Date(newest), found });
  }
  return decision;
}

/**
 * A pass waits for every command it starts and no two passes run at once, so a starting pass may
 * call these dead. An agent job outlasts the pass that found it: leftByQueue is the rule for those.
 */
export function leftByPasses(rows: Run[]): Run[] {
  const waitedFor = new Set<string>([...EVENT_RUN_KINDS].filter((kind) => !AGENT_KINDS.has(kind)));
  return rows.filter((r) => r.state === 'running' && r.parentId === null && waitedFor.has(r.kind));
}

export type EventRow = typeof pollerEvents.$inferSelect & { run: Run | null };

export function pollerStatus(
  projects: Array<typeof pollerProjects.$inferSelect>,
  events: EventRow[],
  outputPath: (runId: string) => string = runOutputPath,
): string[] {
  if (projects.length === 0) return ['the poller: no pass yet'];
  return [
    'the poller',
    ...projects.flatMap((p) => {
      const found = events.filter((e) => e.project === p.project);
      return [
        `  ${p.project}: last pass ${time(p.lastPassAt)}, watched since ${time(p.startedAt)}${found.length === 0 ? ', nothing found yet' : ''}`,
        ...found.map((e) => {
          const tried = e.attempts === 0 ? 'not tried yet' : `tried ${e.attempts} time${e.attempts === 1 ? '' : 's'}`;
          const state = e.handledAt === null ? `not handled, ${tried}` : 'handled';
          return `    ${e.event} ${state}${e.run ? `: ${runLine(e.run, outputPath)}` : ''}`;
        }),
      ];
    }),
  ];
}
