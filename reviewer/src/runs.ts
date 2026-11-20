import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asc, desc, eq, inArray } from 'drizzle-orm';

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
}

export interface RunResult {
  state: 'succeeded' | 'failed';
  /** The stage a failed run stopped in; `starting` before it reached one of its own. */
  stage: string | null;
  /** Never free text: an error's class name, `exit N`, `killed by SIG…` or `could not start`. */
  errorType: string | null;
}

// The lines the sweep's and the review's drivers print as they enter or resume a stage.
const STAGE_LINE = /=== (?:sweep )?state: (\w+) ===|resuming (?:sweep|review) \d+ for \S+ in state (\w+)/g;
const ERROR_TYPE_LINE = /^error type: (\S+)$/gm;

/** An error's class name, and nothing a message or a project could put there. */
export function errorType(err: unknown): string {
  return err instanceof Error && /^[A-Za-z]\w*$/.test(err.name) ? err.name : 'Error';
}

/** The last line of a command that threw while run under a run id; runResult reads it back. */
export function errorTypeLine(err: unknown): string {
  return `error type: ${errorType(err)}`;
}

/** How a run ended, from what was seen of its command. */
export function runResult(ended: Ended): RunResult {
  if (ended.exitCode === 0) return { state: 'succeeded', stage: null, errorType: null };
  const stages = [...ended.output.matchAll(STAGE_LINE)].map((m) => m[1] ?? m[2]).filter((s) => s !== 'failed');
  const reported = [...ended.output.matchAll(ERROR_TYPE_LINE)].at(-1)?.[1];
  const errorType =
    reported ??
    (ended.signal !== null
      ? `killed by ${ended.signal}`
      : ended.exitCode !== null
        ? `exit ${ended.exitCode}`
        : 'could not start');
  return { state: 'failed', stage: stages.at(-1) ?? 'starting', errorType };
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
  const how = run.state === 'failed' && run.stage !== null ? `failed in ${run.stage}: ${run.errorType}` : run.state;
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
 * Run one of the code reviewer's own commands for a run that has been started, in a process of
 * its own: App auth is one project per process, and a command that dies takes only itself. What it
 * writes goes to the log as it comes and to the run's output file.
 */
export async function runCommand(run: Run, args: string[]): Promise<RunResult> {
  const file = fs.createWriteStream(runOutputPath(run.id), { flags: 'a' });
  file.on('error', (err) => console.warn(`could not keep the output of ${run.id} (${err.message})`));
  const ended = await new Promise<Ended>((resolve) => {
    let output = '';
    const child = spawn(process.execPath, ['--import', 'tsx/esm', path.join(reviewerRoot, 'src/cli.ts'), ...args], {
      cwd: reviewerRoot,
      // The install repo is for git's credential helper, which git starts with no arguments.
      env: { ...process.env, REVIEWER_RUN_ID: run.id, ...(run.project ? { REVIEWER_APP_INSTALL_REPO: run.project } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      resolve({ exitCode: null, signal: null, output });
    });
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal, output }));
  });
  await new Promise((done) => {
    file.on('close', done);
    file.end();
  });
  return runResult(ended);
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
