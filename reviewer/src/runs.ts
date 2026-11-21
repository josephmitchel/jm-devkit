import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, asc, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';

import { UPDATE_STAGES } from '../bin/update.mjs';

import { db, schema } from './db/client.js';
import type { RunKind } from './db/schema.js';
import { reviewerRoot, workspaceRoot } from './workspace.js';

export type Run = typeof schema.runs.$inferSelect;

/** What was seen of a run's command once it was over. Both null: it never started. */
export interface Ended {
  exitCode: number | null;
  signal: string | null;
  /** Everything it wrote, stdout and stderr together. */
  output: string;
  /** Set when the command was told to stop before it had finished, with what stopped it. */
  stopped?: StopReason | null;
}

/** What stops a run that did not end of itself. `found running` is a run whose process died unrecorded. */
export type StopReason = 'time limit' | 'service stopped' | 'found running';

export interface RunResult {
  state: 'succeeded' | 'failed' | 'interrupted';
  /** The stage a run stopped in, by its fixed name; `starting` before it reached one of its own. */
  stage: string | null;
  /**
   * Never free text: an error's class name, `exit N`, `killed by SIG…` or `could not start` on a
   * failed run, and a {@link StopReason} on an interrupted one.
   */
  errorType: string | null;
}

/** The stages of a run of a project's nightly checks: its setup command, then the checks themselves. */
export const CHECKS_STAGES = ['setup', 'checking'] as const;
// The lines the sweep's, the review's and the nightly checks' drivers print as they enter or resume a stage.
const STAGE_LINE = /=== (?:sweep |checks )?state: (\w+) ===|resuming (?:sweep|review) \d+ for \S+ in state (\w+)/g;
// Only these count as a stage, so a line in a project's output cannot name one of its choosing.
const STAGES = new Set<string>([...schema.sweepState.enumValues, ...schema.reviewState.enumValues, ...CHECKS_STAGES]);
/** The stages of a nightly run itself, apart from its projects' runs. */
export const NIGHTLY_STAGES = ['finding the projects', 'working through the projects'] as const;
/**
 * Every stage a run can be recorded as having stopped in: the ones above, `starting` before any
 * of them, the nightly run's own, and the steps of bringing the code reviewer up to date before it.
 */
export const RUN_STAGES: ReadonlySet<string> = new Set([...STAGES, 'starting', ...NIGHTLY_STAGES, ...UPDATE_STAGES]);

/** An error's class name, and nothing a message or a project could put there. */
export function errorType(err: unknown): string {
  return err instanceof Error && /^[A-Za-z]\w*$/.test(err.name) ? err.name : 'Error';
}

/**
 * The last line of a command that threw while run under a run id; runResult reads it back. It
 * carries the run id because a project's own commands are never given it, so a line in their
 * output cannot pass for this one.
 */
export function errorTypeLine(runId: string, err: unknown): string {
  return `${runId} error type: ${errorType(err)}`;
}

/** How a run ended, from what was seen of its command. */
export function runResult(runId: string, ended: Ended): RunResult {
  if (ended.exitCode === 0) return { state: 'succeeded', stage: null, errorType: null };
  const stages = [...ended.output.matchAll(STAGE_LINE)]
    .map((m) => m[1] ?? m[2])
    .filter((s) => STAGES.has(s) && s !== 'failed');
  const stage = stages.at(-1) ?? 'starting';
  // Stopped, not broken: how the command died says nothing about the code, so it is not a failure.
  if (ended.stopped) return { state: 'interrupted', stage, errorType: ended.stopped };
  const reported = ended.output
    .split('\n')
    .findLast((line) => line.startsWith(`${runId} error type: `))
    ?.slice(`${runId} error type: `.length);
  const errorType =
    reported ??
    (ended.signal !== null
      ? `killed by ${ended.signal}`
      : ended.exitCode !== null
        ? `exit ${ended.exitCode}`
        : 'could not start');
  return { state: 'failed', stage, errorType };
}

// The commands that run agents.
const AGENT_JOBS = new Set(['sweep', 'run']);
// What a run on GitHub Actions was given (`timeout-minutes: 330`).
const AGENT_JOB_LIMIT_MS = 5.5 * 60 * 60 * 1000;
// The commands that run no agents and only talk to GitHub and the database. They finish in
// seconds; the limit is for a call that hangs.
const SHORT_STEPS = new Set(['landed', 'carry-gate', 'summary']);
const SHORT_STEP_LIMIT_MS = 10 * 60 * 1000;

/**
 * How long one of the code reviewer's commands may run before it is stopped, or null for no
 * limit: a project's nightly checks have none as a whole, since each check has its own.
 */
export function timeLimitMs(args: string[], env: NodeJS.ProcessEnv = process.env): number | null {
  if (SHORT_STEPS.has(args[0])) return SHORT_STEP_LIMIT_MS;
  if (!AGENT_JOBS.has(args[0])) return null;
  const set = Number(env.REVIEWER_AGENT_JOB_LIMIT_MS);
  return Number.isInteger(set) && set > 0 ? set : AGENT_JOB_LIMIT_MS;
}

/**
 * What an interrupted command needs before its work can be taken up again, as a command to run. A
 * sweep needs nothing: it resumes from its own recorded state when it is next run. A review killed
 * mid-stage would hold its project's review slot and restart from the wrong place, so it is
 * recorded as stopped, the way a cancelled run on GitHub Actions is.
 */
export function afterInterruption(args: string[], reason: StopReason): string[] | null {
  const [command, slug, pr] = args;
  if (command !== 'run') return null;
  return ['abandon', slug, pr, `the run on the machine was interrupted (${reason})`];
}

/**
 * Of the runs still recorded as `running`, those a nightly run left behind: an earlier nightly run
 * and its parts. Only a nightly run that is starting may call them dead, because one nightly run
 * goes at a time (it holds the nightly run's lock). A run that is no part of a nightly run (a
 * `landed` or a review) may be going on beside it and is not this rule's to judge.
 */
export function leftByNightlyRuns(rows: Run[]): Run[] {
  return rows.filter((r) => r.state === 'running' && (r.kind === 'nightly' || r.parentId !== null));
}

/** `run-<UTC time it started>-<random>`. It names no project, so it can be printed anywhere. */
export function newRunId(now: Date = new Date(), suffix: string = crypto.randomBytes(3).toString('hex')): string {
  const time = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  return `run-${time}-${suffix}`;
}

/**
 * The file holding everything a run's command wrote. It stays on the machine: a run's output can
 * carry a project's code, so it is kept out of the checkouts, where a project's commands run and
 * where a fixer commits from.
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

/** A run's line in a log and in `status`: what it was, how it ended, and its id. */
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

/** The `status` section for nightly runs, from the rows of the recent ones and of their parts. */
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
 * The `status` section for the runs no other section shows: those that are part of no nightly run
 * and were started for no event, such as a project's nightly checks run by hand. `eventKinds` are
 * the kinds of run a pass or the queue starts, which the poller's section shows with their events.
 */
export function otherRunsStatus(rows: Run[], eventKinds: ReadonlySet<RunKind>, outputPath: (runId: string) => string = runOutputPath): string[] {
  const byHand = rows.filter((r) => r.parentId === null && r.kind !== 'nightly' && !eventKinds.has(r.kind));
  if (byHand.length === 0) return ['runs started by hand: none yet'];
  return ['runs started by hand', ...byHand.map((r) => `  ${runLine(r, outputPath)}`)];
}

/**
 * Record that a run has started. `parentId` is the run it is part of, such as the nightly run.
 * Its output file is made first, so a state directory that cannot be used leaves no row behind.
 */
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

/** Record how a run ended. */
export async function finishRun(run: Run, result: RunResult): Promise<Run> {
  const [row] = await db
    .update(schema.runs)
    .set({ ...result, finishedAt: new Date() })
    .where(eq(schema.runs.id, run.id))
    .returning();
  return row;
}

/** Writes a line of a run's own to the log and to the run's output file. */
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
 * Record as interrupted what an earlier nightly run left as `running`: its process was killed, or
 * the machine went down, before it could record how it ended. For a nightly run that is starting,
 * before it records itself. The sweeps it left resume when tonight's run reaches their projects.
 * `leftBehind` says which of the running runs the caller may call dead; the poller and the queue
 * have their own.
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
// How long a command's output may stay open once the command itself has exited: something it
// started and left behind can hold the pipe, and must not hold the run.
const OUTPUT_CLOSES_WITHIN_MS = 10_000;
// A command run to tidy up after an interrupted one. Short, so a stopping service still gets to it.
const CLEANUP_LIMIT_MS = 60_000;

// One entry per command of ours that is going: tells it to stop.
const going = new Set<() => void>();
let stopRequested = false;

/** Whether this process has been told to stop (see {@link stopCommandsOnSignal}). */
export function stopping(): boolean {
  return stopRequested;
}

/**
 * Have a stop signal to this process stop the commands it is running, and let it record how they
 * ended, where the default would end it at once with its runs left as `running`. For a command
 * that runs others through {@link runCommand}; it then asks {@link stopping} before starting more.
 */
export function stopCommandsOnSignal(): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      stopRequested = true;
      for (const stop of going) stop();
    });
  }
}

// A command leads a process group of its own, so its agents and any project command it started
// are signalled with it.
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Run one of the code reviewer's own commands for a run that has been started, in a process of
 * its own: App auth is one project per process, and a command that dies takes only itself. What it
 * writes goes to the log as it comes and to the run's output file.
 *
 * This is the one place a command is given its time limit and told to stop. A command stopped by
 * its limit, or because this process was told to stop, ends the run `interrupted`, and whatever
 * its kind of work needs before it can be taken up again is done here ({@link afterInterruption}).
 */
export async function runCommand(run: Run, args: string[]): Promise<RunResult> {
  const result = runResult(run.id, await runChild(run, args, timeLimitMs(args), true));
  if (result.state === 'interrupted') await tidyAfterInterruption(run, args, result.errorType as StopReason);
  return result;
}

/**
 * Do what an interrupted command's work needs before it can be taken up again
 * ({@link afterInterruption}), as part of the same run. runCommand does it for a command it
 * stopped; whoever finds a run dead, its process gone unrecorded, calls it for that run.
 */
export async function tidyAfterInterruption(run: Run, args: string[], reason: StopReason): Promise<void> {
  const cleanup = afterInterruption(args, reason);
  if (!cleanup) return;
  // Not stopped with the rest: it is what a stopping service still has to get done.
  const cleaned = await runChild(run, cleanup, CLEANUP_LIMIT_MS, false);
  if (cleaned.exitCode !== 0) console.warn(`${run.id}: could not record the interrupted work as stopped (${cleanup[0]})`);
}

async function runChild(run: Run, args: string[], limitMs: number | null, stoppable: boolean): Promise<Ended> {
  const file = fs.createWriteStream(runOutputPath(run.id), { flags: 'a' });
  file.on('error', (err) => console.warn(`could not keep the output of ${run.id} (${err.message})`));
  const ended = await new Promise<Ended>((resolve) => {
    let output = '';
    let stopped: StopReason | null = null;
    const timers: NodeJS.Timeout[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx/esm', path.join(reviewerRoot, 'src/cli.ts'), ...args], {
      cwd: reviewerRoot,
      // The project to authenticate for, told to git's credential helper, which git starts with no arguments.
      env: { ...process.env, REVIEWER_RUN_ID: run.id, ...(run.project ? { REVIEWER_APP_INSTALL_REPO: run.project } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const stop = (reason: StopReason) => {
      if (stopped !== null) return;
      stopped = reason;
      signalGroup(child, 'SIGTERM');
      timers.push(setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_AFTER_MS));
    };
    const stopWithService = () => stop('service stopped');
    if (stoppable) going.add(stopWithService);
    // The stop may have come between the decision to run this and its start.
    if (stoppable && stopRequested) stopWithService();
    if (limitMs !== null) timers.push(setTimeout(() => stop('time limit'), limitMs));

    const finish = (exitCode: number | null, signal: string | null) => {
      going.delete(stopWithService);
      for (const timer of timers) clearTimeout(timer);
      resolve({ exitCode, signal, output, stopped });
    };
    for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
      from.setEncoding('utf8');
      from.on('data', (chunk: string) => {
        output += chunk;
        file.write(chunk);
        to.write(chunk);
      });
    }
    child.on('error', (err) => {
      file.write(`${err.message}\n`);
      finish(null, null);
    });
    child.on('exit', (exitCode, signal) => {
      timers.push(
        setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(exitCode, signal);
        }, OUTPUT_CLOSES_WITHIN_MS),
      );
    });
    child.on('close', finish);
  });
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

/** The most recent nightly runs, newest first, each followed by its parts in the order they ran. */
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
