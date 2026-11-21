import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, asc, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';

import { streamChild } from './child.js';
import { db, schema } from './db/client.js';
import type { RunKind } from './db/schema.js';
import { toTheSecond } from './log.js';
import { howEnded, reportedErrorType, stageReached, type StopReason } from './run-vocabulary.js';
import { reviewerRoot, workspaceRoot } from './workspace.js';

export type Run = typeof schema.runs.$inferSelect;

/** Both null: it never started. */
export interface Ended {
  exitCode: number | null;
  signal: string | null;
  output: string;
  stopped?: StopReason | null;
}

export interface RunResult {
  state: 'succeeded' | 'failed' | 'interrupted';
  /** `starting` before it reached a stage of its own. */
  stage: string | null;
  /**
   * Never free text: an error's class name, `exit N`, `killed by SIG…` or `could not start` on a
   * failed run, and a {@link StopReason} on an interrupted one.
   */
  errorType: string | null;
}

export function runResult(runId: string, ended: Ended): RunResult {
  if (ended.exitCode === 0) return { state: 'succeeded', stage: null, errorType: null };
  const stage = stageReached(ended.output);
  // Stopped, not broken: how the command died says nothing about the code, so it is not a failure.
  if (ended.stopped) return { state: 'interrupted', stage, errorType: ended.stopped };
  return { state: 'failed', stage, errorType: reportedErrorType(runId, ended.output) ?? howEnded(ended.exitCode, ended.signal) };
}

/** They go one at a time on the machine and get the long time limit. */
export const AGENT_KINDS: ReadonlySet<RunKind> = new Set<RunKind>(['sweep', 'review']);

export interface ProjectCommand {
  command: 'sweep' | 'summary' | 'checks' | 'landed' | 'carry-gate' | 'run';
  project: string;
  /** Null for a command that is the whole project's. */
  pr: number | null;
}

/** The one place a command becomes arguments. A review is run to return, not to wait (`--once`). */
export function commandArgs({ command, project, pr }: ProjectCommand): string[] {
  const args = [command, project, ...(pr === null ? [] : [String(pr)])];
  return command === 'run' ? [...args, '--once'] : args;
}

/** The kind it is named for, but for a review's. */
export function commandKind(command: ProjectCommand['command']): RunKind {
  return command === 'run' ? 'review' : command;
}
// What a run on GitHub Actions was given (`timeout-minutes: 330`).
const AGENT_JOB_LIMIT_MS = 5.5 * 60 * 60 * 1000;
// They finish in seconds; the limit is for a call that hangs.
const SHORT_STEPS: ReadonlySet<ProjectCommand['command']> = new Set(['landed', 'carry-gate', 'summary'] as const);
const SHORT_STEP_LIMIT_MS = 10 * 60 * 1000;

/** Null: no limit. A project's nightly checks have none as a whole, since each check has its own. */
export function timeLimitMs({ command }: Pick<ProjectCommand, 'command'>, env: NodeJS.ProcessEnv = process.env): number | null {
  if (SHORT_STEPS.has(command)) return SHORT_STEP_LIMIT_MS;
  if (!AGENT_KINDS.has(commandKind(command))) return null;
  const set = Number(env.REVIEWER_AGENT_JOB_LIMIT_MS);
  return Number.isInteger(set) && set > 0 ? set : AGENT_JOB_LIMIT_MS;
}

/**
 * A sweep needs nothing: it resumes from its own state. A review killed mid-stage would hold its
 * project's slot and restart from the wrong place, so it is recorded as stopped, as a cancelled run
 * on GitHub Actions is.
 */
export function afterInterruption({ command, project, pr }: ProjectCommand, reason: StopReason): string[] | null {
  if (command !== 'run') return null;
  return ['abandon', project, String(pr), `the run on the machine was interrupted (${reason})`];
}

/**
 * Only a starting nightly run may call these dead: one goes at a time. A run that is no part of a
 * nightly run may be going on beside it.
 */
export function leftByNightlyRuns(rows: Run[]): Run[] {
  return rows.filter((r) => r.state === 'running' && (r.kind === 'nightly' || r.parentId !== null));
}

/** `run-<UTC time it started>-<random>`. It names no project, so it can be printed anywhere. */
export function newRunId(now: Date = new Date(), suffix: string = crypto.randomBytes(3).toString('hex')): string {
  const time = toTheSecond(now).replace(/[-:]/g, '');
  return `run-${time}-${suffix}`;
}

/**
 * A run's output can carry a project's code, so it stays on the machine and out of the checkouts,
 * where a project's commands run and a fixer commits from.
 */
export function runOutputPath(runId: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const configured = env.REVIEWER_STATE_DIR?.trim();
  const stateDir = path.resolve(configured || path.join(home, '.local/state/code-reviewer'));
  const checkouts = path.resolve(workspaceRoot(env));
  const fromCheckouts = path.relative(checkouts, stateDir);
  if (fromCheckouts !== '..' && !fromCheckouts.startsWith(`..${path.sep}`)) {
    throw new Error(`REVIEWER_STATE_DIR (${stateDir}) is inside the projects' checkouts (${checkouts}): move it out`);
  }
  return path.join(stateDir, 'runs', `${runId}.log`);
}

export function runLine(run: Run, outputPath: (runId: string) => string = runOutputPath): string {
  const what = run.project === null ? run.id : `${run.project} ${run.kind}`;
  const how =
    run.errorType === null
      ? run.state
      : `${run.state}${run.stage === null ? '' : ` in ${run.stage}`}: ${run.errorType}`;
  return (
    `${what} [${how}]` +
    (run.project === null ? '' : ` ${run.id}`) +
    (run.errorType === null ? '' : `, output: ${outputPath(run.id)}`)
  );
}

export function nightlyStatus(rows: Run[], outputPath: (runId: string) => string = runOutputPath): string[] {
  const nightlies = rows.filter((r) => r.kind === 'nightly');
  if (nightlies.length === 0) return ['nightly runs: none yet'];
  return [
    'nightly runs',
    ...nightlies.flatMap((nightly) => [
      `  ${runLine(nightly, outputPath)}`,
      ...rows.filter((r) => r.parentId === nightly.id).map((part) => `    ${runLine(part, outputPath)}`),
    ]),
  ];
}

/**
 * The runs no other section shows: part of no nightly run and started for no event (`eventKinds`),
 * such as nightly checks run by hand.
 */
export function otherRunsStatus(rows: Run[], eventKinds: ReadonlySet<RunKind>, outputPath: (runId: string) => string = runOutputPath): string[] {
  const byHand = rows.filter((r) => r.parentId === null && r.kind !== 'nightly' && !eventKinds.has(r.kind));
  if (byHand.length === 0) return ['runs started by hand: none yet'];
  return ['runs started by hand', ...byHand.map((r) => `  ${runLine(r, outputPath)}`)];
}

/** The output file is made first, so a state directory that cannot be used leaves no row behind. */
export async function startRun(run: { kind: RunKind; project?: string; parentId?: string }): Promise<Run> {
  const id = newRunId();
  const file = runOutputPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  const [row] = await db
    .insert(schema.runs)
    .values({ id, kind: run.kind, project: run.project ?? null, parentId: run.parentId ?? null })
    .returning();
  return row;
}

export async function finishRun(run: Run, result: RunResult): Promise<Run> {
  const [row] = await db
    .update(schema.runs)
    .set({ ...result, finishedAt: new Date() })
    .where(eq(schema.runs.id, run.id))
    .returning();
  return row;
}

export function runLog(run: Run): (line: string) => void {
  const file = runOutputPath(run.id);
  return (line) => {
    console.log(line);
    try {
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
    } catch {
      // The log has the line; a full disk must not end the run.
    }
  };
}

/**
 * `leftBehind` says which of the running runs the caller may call dead: by default a starting
 * nightly run's, to be called before it records itself.
 */
export async function interruptRunsLeftRunning(leftBehind: (running: Run[]) => Run[] = leftByNightlyRuns): Promise<Run[]> {
  const left = leftBehind(await db.select().from(schema.runs).where(eq(schema.runs.state, 'running')));
  if (left.length === 0) return [];
  const reason: StopReason = 'found running';
  return db
    .update(schema.runs)
    .set({ state: 'interrupted', errorType: reason, finishedAt: new Date() })
    .where(and(inArray(schema.runs.id, left.map((r) => r.id)), eq(schema.runs.state, 'running')))
    .returning();
}

// How long a command told to stop has before it is killed outright.
const KILL_AFTER_MS = 30_000;
// Something the command started and left behind can hold the pipe, and must not hold the run.
const OUTPUT_CLOSES_WITHIN_MS = 10_000;
// Short, so a stopping service still gets to it.
const CLEANUP_LIMIT_MS = 60_000;

// One entry per command of ours that is going: tells it to stop.
const going = new Set<() => void>();
let stopRequested = false;

export function stopping(): boolean {
  return stopRequested;
}

/**
 * Without this a stop signal ends the process at once, its runs left as `running`. For a command
 * that runs others through {@link runCommand}; it asks {@link stopping} before starting more.
 */
export function stopCommandsOnSignal(): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      stopRequested = true;
      for (const stop of going) stop();
    });
  }
}

/**
 * In a process of its own: App auth is one project per process, and a command that dies takes only
 * itself. The one place a command is given its time limit and told to stop; a stopped command ends
 * the run `interrupted`.
 */
export async function runCommand(run: Run, command: ProjectCommand): Promise<RunResult> {
  const result = runResult(run.id, await runChild(run, commandArgs(command), timeLimitMs(command), true));
  if (result.state === 'interrupted') await tidyAfterInterruption(run, command, result.errorType as StopReason);
  return result;
}

/** runCommand does this for a command it stopped; whoever finds a run dead calls it for that run. */
export async function tidyAfterInterruption(run: Run, command: ProjectCommand, reason: StopReason): Promise<void> {
  const cleanup = afterInterruption(command, reason);
  if (!cleanup) return;
  // Not stopped with the rest: it is what a stopping service still has to get done.
  const cleaned = await runChild(run, cleanup, CLEANUP_LIMIT_MS, false);
  if (cleaned.exitCode !== 0) console.warn(`${run.id}: could not record the interrupted work as stopped (${cleanup[0]})`);
}

async function runChild(run: Run, args: string[], limitMs: number | null, stoppable: boolean): Promise<Ended> {
  const file = fs.createWriteStream(runOutputPath(run.id), { flags: 'a' });
  file.on('error', (err) => console.warn(`could not keep the output of ${run.id} (${err.message})`));
  let output = '';
  let stopWithService = () => {};
  const child = await streamChild(
    process.execPath,
    ['--import', 'tsx/esm', path.join(reviewerRoot, 'src/cli.ts'), ...args],
    {
      cwd: reviewerRoot,
      // The project to authenticate for, told to git's credential helper, which git starts with no arguments.
      env: { ...process.env, REVIEWER_RUN_ID: run.id, ...(run.project ? { REVIEWER_APP_INSTALL_REPO: run.project } : {}) },
      // So its agents and any project command it started are stopped with it.
      ownGroup: true,
      limitMs,
      killAfterMs: KILL_AFTER_MS,
      closesWithinMs: OUTPUT_CLOSES_WITHIN_MS,
    },
    (chunk, from) => {
      output += chunk;
      file.write(chunk);
      process[from].write(chunk);
    },
    (stop) => {
      if (!stoppable) return;
      stopWithService = stop;
      going.add(stopWithService);
      // The stop may have come between the decision to run this and its start.
      if (stopRequested) stop();
    },
  );
  going.delete(stopWithService);
  if (child.error) file.write(`${child.error.message}\n`);
  const stoppedBy = { limit: 'time limit', caller: 'service stopped' } as const;
  const ended: Ended = { exitCode: child.exitCode, signal: child.signal, output, stopped: child.stoppedBy && stoppedBy[child.stoppedBy] };
  await new Promise((done) => {
    file.on('close', done);
    file.end();
  });
  // A service being stopped signals every process in it at once, so the command can be seen to
  // die a moment before this process hears why. Give the signal that moment to arrive.
  if (stoppable && !ended.stopped && ended.signal !== null && !stopRequested) {
    await new Promise((heard) => setTimeout(heard, 500));
  }
  return { ...ended, stopped: ended.stopped ?? (stoppable && stopRequested && ended.exitCode !== 0 ? 'service stopped' : null) };
}

/** Newest first, each followed by its parts in the order they ran. */
export async function recentNightlyRuns(limit: number): Promise<Run[]> {
  const nightlies = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.kind, 'nightly'))
    .orderBy(desc(schema.runs.startedAt))
    .limit(limit);
  if (nightlies.length === 0) return [];
  const parts = await db
    .select()
    .from(schema.runs)
    .where(inArray(schema.runs.parentId, nightlies.map((n) => n.id)))
    .orderBy(asc(schema.runs.startedAt));
  return [...nightlies, ...parts];
}

/** The most recent runs that are part of no other run and are of none of `kinds`, newest first. */
export async function recentRunsOnTheirOwn(kinds: RunKind[], limit: number, project?: string): Promise<Run[]> {
  return db
    .select()
    .from(schema.runs)
    .where(and(isNull(schema.runs.parentId), notInArray(schema.runs.kind, kinds), project ? eq(schema.runs.project, project) : undefined))
    .orderBy(desc(schema.runs.startedAt))
    .limit(limit);
}
