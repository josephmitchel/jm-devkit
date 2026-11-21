import type { RunKind, pollerEvents, pollerProjects } from './db/schema.js';
import type { Project } from './projects.js';
import { countsAsReply } from './reply-authority.js';
import { AGENT_KINDS, commandKind, runLine, runOutputPath, type ProjectCommand, type Run } from './runs.js';

/**
 * The poller's pass as a decision: from what a pass saw on GitHub and what the database says was
 * already handled, to the commands to run and the reviews to queue. Nothing here asks GitHub or
 * the database anything.
 */

/** A pull request as a pass saw it in a project's listing. */
export interface PullRequestSeen {
  number: number;
  /** When GitHub last changed anything about it. */
  updatedAt: Date;
  /** When it merged, or null when it has not. */
  mergedAt: Date | null;
  /** Whether it is open: neither merged nor closed. */
  open: boolean;
  /** The commit its branch is at. */
  headSha: string;
  draft: boolean;
  /** The names of its labels. */
  labels: string[];
  /**
   * What has been said on it, comments and submitted reviews alike. Read only for a pull request
   * whose review waits on the owner, and empty for every other.
   */
  comments: CommentSeen[];
}

/** A comment on a pull request, as far as the poller needs it. */
export interface CommentSeen {
  id: number;
  /** When it was written. */
  at: Date;
  /** What GitHub says its author is to the project: `OWNER`, `MEMBER`, `NONE` and so on. */
  authorAssociation: string;
}

/** A pull request's review, as the database has it. */
export interface ReviewKnown {
  pr: number;
  /** One of the review's states: `pending`, `auditing`, `awaiting_answers`, `passed`, `failed` and the rest. */
  state: string;
  /** When it entered that state. */
  since: Date;
  /** The comments the code reviewer posted for it, which are never the owner's word. */
  ownComments: number[];
}

/** What a pass saw of one project. Its pull requests are asked for only when the machine handles it. */
export interface ProjectSeen {
  project: Project;
  /** GitHub's clock when it was asked. */
  at: Date;
  /**
   * Its pull requests, as far back as the last pass got to. Null when GitHub answered that
   * nothing about any of them has changed since that pass.
   */
  pullRequests: PullRequestSeen[] | null;
}

/** An event as the database records it. */
export interface EventRecord {
  /** The event's key, `<name>:<subject>`, such as `merged:12`. The same event always has the same key. */
  event: string;
  /** When it was handled, or null while it has not been. */
  handledAt: Date | null;
  /** How many times its command has been started. */
  attempts: number;
  /** When it was last started, or null when it never was. */
  attemptedAt: Date | null;
  /** Whether the run of its last attempt is still recorded as running. */
  running: boolean;
}

/** What the database holds about a project the poller has passed over before. */
export interface ProjectKnown {
  /** When its first pass was. Nothing that happened before it is acted on. */
  startedAt: Date;
  /** How far the last pass's reading of the pull requests got: the newest change it saw. */
  seenTo: Date;
  events: EventRecord[];
  /** The project's reviews, one per pull request that has one. */
  reviews: ReviewKnown[];
  /** For each pull request whose review has passed: the commits that review's gate is on, carried ones included. */
  passedGates: ReadonlyMap<number, readonly string[]>;
}

/**
 * A project's passed reviews as {@link ProjectKnown} holds them, from one row per review and gate
 * status on record. A review with no status on record has a row with no commit.
 */
export function gatesOfPassedReviews(rows: Array<{ prNumber: number; sha: string | null; payload: unknown }>): Map<number, string[]> {
  const gates = new Map<number, string[]>();
  for (const { prNumber, sha, payload } of rows) {
    const gated = gates.get(prNumber) ?? [];
    if (sha && (payload as { state?: string } | null)?.state === 'success') gated.push(sha);
    gates.set(prNumber, gated);
  }
  return gates;
}

/** One command for a pass to run, for one event. */
export interface Command extends ProjectCommand {
  event: string;
  /** The kind of run it is recorded as. */
  kind: RunKind;
  /** How many times it has been tried before. */
  attempts: number;
}

export interface PassDecision {
  /** The commands for the pass to run now, in order. */
  commands: Command[];
  /** The agent jobs found for the first time: on record for the queue, which starts them. */
  queued: Command[];
  /** For each handled project: the events found for the first time, and where this pass got to. */
  projects: Array<{ project: string; firstPass: boolean; startedAt: Date; seenTo: Date; found: string[] }>;
  /** The projects the machine does not handle. Nothing is run for them and nothing recorded. */
  leftAlone: Project[];
}

/**
 * One kind of event: how a pass finds it on a pull request, and the command that handles it. An
 * event's key is the rule's name and the subject the rule gives, `<name>:<subject>`.
 */
interface EventRule {
  /** The command that handles it, run for the event's pull request. */
  command: ProjectCommand['command'];
  /**
   * What identifies the event on this pull request, or null when the pull request shows none. The
   * same event must always give the same subject, and a new one a new subject. It starts with the
   * pull request's number, which is all its command is built from, so that the command can be
   * tried again from the record ({@link commandFor}).
   */
  subject(pr: PullRequestSeen, known: ProjectKnown): string | null;
}

// The label that asks for a pull request's review (plugin/install/label.mjs creates it).
const REVIEW_LABEL = 'review-now';
// The states in which a review does nothing until the owner says something on its pull request:
// waiting for answers, or stopped with a notice that says a comment retries it.
const WAITS_ON_OWNER = new Set(['awaiting_answers', 'failed']);

/** The review that waits for the owner's word on this pull request, or null when none does. */
function waitingOn(pr: PullRequestSeen, reviews: ReviewKnown[]): ReviewKnown | null {
  const waiting = reviews.find((r) => r.pr === pr.number && WAITS_ON_OWNER.has(r.state));
  return pr.open && waiting ? waiting : null;
}

/**
 * The pull requests whose comments a pass has to read before it can decide, each with the time to
 * read from: those whose review waits on the owner, and that have changed since the last pass's
 * reading. A comment moves its pull request's time of last change, so nothing new is on any other.
 */
export function repliesToRead(pullRequests: PullRequestSeen[], known: ProjectKnown): Array<{ pr: PullRequestSeen; since: Date }> {
  return pullRequests.flatMap((pr) => {
    const waiting = waitingOn(pr, known.reviews);
    // Not later-than: GitHub's times are whole seconds, and a second comment can share one.
    return waiting && pr.updatedAt >= known.seenTo ? [{ pr, since: waiting.since }] : [];
  });
}

/** Every event the poller acts on. A new event is a new entry here. */
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
  // An open pull request labelled for review that has no review. A label has no time of its own,
  // so "since the first pass" is the pull request having changed since. A review that never left
  // `pending` has not started: it counts as none. One command starts a review, continues it and
  // retries it: the review's own state says which.
  labelled: {
    command: 'run',
    subject: (pr, known) => {
      const asked = pr.open && !pr.draft && pr.labels.includes(REVIEW_LABEL) && pr.updatedAt > known.startedAt;
      const started = known.reviews.some((r) => r.pr === pr.number && r.state !== 'pending');
      return asked && !started ? String(pr.number) : null;
    },
  },
  // The owner's word on a review that waits for it. The event is the newest such comment, so
  // several written before a pass are one event and the review is continued once for them.
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

/** The command for a recorded event, or null when no rule knows its key. */
export function commandFor(project: string, event: string, attempts: number): Command | null {
  const [, name, pr] = EVENT_KEY.exec(event) ?? [];
  if (name === undefined || !Object.hasOwn(EVENTS, name)) return null;
  const { command } = EVENTS[name];
  return { project, event, kind: commandKind(command), command, pr: Number(pr), attempts };
}

const MINUTE_MS = 60_000;
const LONGEST_WAIT_MS = 6 * 60 * MINUTE_MS;

/**
 * How long an event whose command has been started `attempts` times without succeeding waits
 * before the next: a minute, then twice as long each time, up to six hours. The first wait is
 * shorter than any interval between passes, so one failure is tried again on the very next pass.
 * It is never given up on, and an event that cannot be handled costs four runs a day, not 480.
 */
export function retryDelayMs(attempts: number): number {
  return Math.min(MINUTE_MS * 2 ** Math.min(attempts - 1, 30), LONGEST_WAIT_MS);
}

/** Whether a recorded event's command should be started now. */
function due(event: EventRecord, now: Date): boolean {
  if (event.handledAt !== null || event.running) return false;
  return event.attemptedAt === null || now.getTime() - event.attemptedAt.getTime() >= retryDelayMs(event.attempts);
}

/**
 * What a pass does. For each project the machine handles: nothing on its first pass, which only
 * marks where the project starts from; after that, the command for every event the rules find
 * that is not on record, and again for every event on record whose command has not succeeded and
 * whose wait is over. An agent job's event is found the same way and never run here: it is
 * returned as queued. `known` has an entry for each project that has had its first pass.
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
 * Of the runs still recorded as `running`, those an earlier pass left behind: its process died
 * before it could record how they ended. A pass waits for every command it starts and no two
 * passes run at once, so a pass that is starting may call these dead. An agent job outlasts the
 * pass that found it and is not counted here: the queue has the rule for those (leftByQueue).
 */
export function leftByPasses(rows: Run[]): Run[] {
  const waitedFor = new Set<string>([...EVENT_RUN_KINDS].filter((kind) => !AGENT_KINDS.has(kind)));
  return rows.filter((r) => r.state === 'running' && r.parentId === null && waitedFor.has(r.kind));
}

/** An event's row, with the run of its last attempt. */
export type EventRow = typeof pollerEvents.$inferSelect & { run: Run | null };

const time = (when: Date) => when.toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * The `status` section for the poller: each project it has passed over, when its last pass was,
 * and the events given, each with how its last run ended.
 */
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
