import type { RunKind, pollerEvents, pollerProjects } from './db/schema.js';
import type { Project } from './projects.js';
import { runLine, runOutputPath, type Run } from './runs.js';

/**
 * The poller's pass as a decision: from what a pass saw on GitHub and what the database says was
 * already handled, to the commands to run. Nothing here asks GitHub or the database anything.
 */

/** A pull request as a pass saw it in a project's listing. */
export interface PullRequestSeen {
  number: number;
  /** When GitHub last changed anything about it. */
  updatedAt: Date;
  /** When it merged, or null when it has not. */
  mergedAt: Date | null;
}

/** What a pass saw of one handled project. */
export interface ProjectSeen {
  project: Project;
  /** GitHub's clock when it was asked. */
  at: Date;
  /** The pull requests changed since the last pass. */
  pullRequests: PullRequestSeen[] | null;
}

/** An event as the database records it. */
export interface EventRecord {
  /** The event's key, `<name>:<subject>`, such as `merged:12`. The same event always has the same key. */
  event: string;
  /** When its command succeeded, or null while it has not. */
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
}

/** One command for a pass to run, for one event. */
export interface Command {
  project: string;
  event: string;
  /** The kind of run it is recorded as. */
  kind: RunKind;
  /** The code reviewer's command line. */
  args: string[];
  /** How many times it has been tried before. */
  attempts: number;
}

export interface PassDecision {
  /** The commands to run now, in order. */
  commands: Command[];
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
  /** The kind of run its command is recorded as. */
  kind: RunKind;
  /**
   * What identifies the event on this pull request, or null when the pull request shows none. The
   * same event must always give the same subject, and a new one a new subject.
   */
  subject(pr: PullRequestSeen, known: ProjectKnown): string | null;
  /** The code reviewer's command line for it, from the subject alone, so it can be tried again from the record. */
  command(project: string, subject: string): string[];
}

/** Every event the poller acts on. A new event is a new entry here. */
const EVENTS: Record<string, EventRule> = {
  merged: {
    kind: 'landed',
    subject: (pr, known) => (pr.mergedAt !== null && pr.mergedAt > known.startedAt ? String(pr.number) : null),
    command: (project, pr) => ['landed', project, pr],
  },
};

/** The command for a recorded event, or null when no rule knows its key. */
function commandFor(project: string, event: string, attempts: number): Command | null {
  const [name, ...subject] = event.split(':');
  if (!Object.hasOwn(EVENTS, name)) return null;
  const rule = EVENTS[name];
  return { project, event, kind: rule.kind, args: rule.command(project, subject.join(':')), attempts };
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

export function passDecision(
  seen: { projects: ProjectSeen[] },
  known: { projects: ReadonlyMap<string, ProjectKnown> },
  now: Date,
): PassDecision {
  const decision: PassDecision = { commands: [], projects: [], leftAlone: [] };
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
      if (command) decision.commands.push(command);
    }
    const newest = Math.max(before.seenTo.getTime(), ...(pullRequests ?? []).map((pr) => pr.updatedAt.getTime()));
    decision.projects.push({ project: project.slug, firstPass: false, startedAt: before.startedAt, seenTo: new Date(newest), found });
  }
  return decision;
}

/**
 * Of the runs still recorded as `running`, those an earlier pass left behind: its process died
 * before it could record how they ended. A pass waits for every command it starts and no two
 * passes run at once, so a pass that is starting may call these dead. A kind of run that outlasts
 * the pass that started it would need a rule of its own and must not be counted here.
 */
export function leftByPasses(rows: Run[]): Run[] {
  const waitedFor = new Set<string>(Object.values(EVENTS).map((rule) => rule.kind));
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
