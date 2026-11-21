import { eq } from 'drizzle-orm';

import { CONFIG_FILE, parseDevkitConfig } from '../../plugin/devkit-config.mjs';
import { db, schema } from './db/client.js';
import type { TestCommand } from './db/schema.js';
import { NightlyCheckError, SetupCommandError } from './failure-side.js';
import { getBranchHead, getDefaultBranch, getDefaultBranchFile } from './github.js';
import { markStage } from './heartbeat.js';
import { CHECKS_LOCK_CLASS, checksLockKey, locksHeld, tryLock } from './locks.js';
import { readProjectSetup, type ProjectRow, type ProjectSetup } from './project-config.js';
import { cloneUrl } from './project-row.js';
import { takeRecordedStep } from './recorded-step.js';
import { howEnded, type CHECKS_STAGES } from './run-vocabulary.js';
import type { Run } from './runs.js';
import { droppingTestDatabases, provideTestDatabases, type RunOwner } from './test-databases.js';
import { checksWorkspacePath, prepareWorkspace, runRepoCommand, streamRepoCommand, type StreamedCommand } from './workspace.js';

/** Read without a checkout, so a project that names none costs nothing more. */
export function checksNamed(config: string | null): TestCommand[] {
  return config === null ? [] : (parseDevkitConfig(config).nightly?.checks ?? []).map(({ name, command }) => ({ name, command }));
}

/**
 * The project, not the run: the checks have no row to resume, so what a killed run left is dropped
 * by the project's next run of them, or by the next nightly run.
 */
export function checksOwner(slug: string): RunOwner {
  return `checks:${slug}`;
}

/** Another run of the same project's checks is going. This one has touched nothing. */
export class ChecksRunningError extends Error {
  constructor(slug: string) {
    super(`another run of ${slug}'s nightly checks is going: this one starts nothing and touches nothing`);
    this.name = 'ChecksRunningError';
  }
}

export interface CheckResult {
  name: string;
  passed: boolean;
  /** `exit N`, `killed by SIG…`, `stopped after N minutes` or `could not start`. */
  how: string;
  tail: string;
}

/** A check that failed costs only itself: the checks after it still run, and the run ends failed. */
export function checksDecision(checks: TestCommand[], results: CheckResult[]): { next: TestCommand } | { done: 'succeeded' | 'failed' } {
  if (results.length < checks.length) return { next: checks[results.length] };
  return { done: results.every((r) => r.passed) ? 'succeeded' : 'failed' };
}

// Sized to fit, with the error type's line, inside the end of the output that outputTail sends to
// the project's failure issue.
const ACCOUNT_LINES = 36;
const ACCOUNT_CHARS = 3400;

/**
 * The failed checks share the room, so a failing check's output reaches the issue however much the
 * checks after it wrote.
 */
export function checksAccount(results: CheckResult[]): string {
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) return `all ${results.length} nightly check(s) passed`;
  const lines = Math.max(1, Math.floor(ACCOUNT_LINES / failed.length) - 1);
  const chars = Math.floor(ACCOUNT_CHARS / failed.length);
  const sections = failed.map((r) => {
    const heading = `--- ${r.name}: failed (${r.how}); the end of what it wrote ---`;
    const wrote = r.tail.trimEnd().split('\n').slice(-lines).join('\n').slice(-Math.max(0, chars - heading.length - 2));
    return `${heading}\n${wrote.trim() === '' ? '(it wrote nothing)' : wrote}`;
  });
  return [...sections, `${failed.length} of ${results.length} nightly check(s) failed: ${failed.map((r) => r.name).join(', ')}`].join('\n');
}

// A check is in the nightly run because it is slow, so it gets longer than a test suite does.
const CHECK_TIMEOUT_MS = 30 * 60 * 1000;

export function checkTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env.REVIEWER_CHECK_TIMEOUT_MS);
  return Number.isInteger(set) && set > 0 ? set : CHECK_TIMEOUT_MS;
}

function checkResult(name: string, ended: StreamedCommand): CheckResult {
  const how =
    ended.timedOutAfterMs !== null ? `stopped after ${Math.round(ended.timedOutAfterMs / 60_000)} minutes` : howEnded(ended.exitCode, ended.signal);
  return { name, passed: ended.exitCode === 0 && ended.timedOutAfterMs === null, how, tail: ended.tail };
}

/**
 * Each check is one of the project's own commands: it gets `project.env` and none of the code
 * reviewer's credentials (repoCommandEnv).
 */
export async function runChecks(
  checkoutDir: string,
  project: Pick<ProjectSetup, 'nightlyChecks' | 'env'>,
  write: (chunk: string) => void = (chunk) => void process.stdout.write(chunk),
  timeoutMs: number = checkTimeoutMs(),
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  let decision = checksDecision(project.nightlyChecks, results);
  while ('next' in decision) {
    const { name, command } = decision.next;
    console.log(`running nightly check: ${name} (${command})`);
    const result = checkResult(name, await streamRepoCommand(checkoutDir, command, project.env, write, timeoutMs));
    console.log(`  ${name}: ${result.passed ? 'pass' : `FAIL (${result.how})`}`);
    results.push(result);
    decision = checksDecision(project.nightlyChecks, results);
  }
  return results;
}

// A project that names checks has a project config, so nothing is ever taken from a database row.
const NO_ROW: ProjectRow = { setupCommand: null, testCommands: [], redundancy: 1, harnessNotes: null, extraContext: null };

function enter(stage: (typeof CHECKS_STAGES)[number]): void {
  markStage(stage);
  console.log(`\n=== checks state: ${stage} ===`);
}

/**
 * The checks get a checkout of their own at the default branch's head as it is now: the head the
 * sweep audited or a newer one. It is set up the way the sweep's is, with fresh databases, since
 * the sweep's were dropped when it ended.
 *
 * One run per project at a time: a second would reset the first's checkout and drop its databases,
 * so it throws {@link ChecksRunningError} before touching either.
 */
export async function runProjectChecks(slug: string): Promise<void> {
  const lock = await tryLock(checksLockKey(slug), CHECKS_LOCK_CLASS);
  if (!lock) throw new ChecksRunningError(slug);
  try {
    await checkProject(slug);
  } finally {
    await lock.release();
  }
}

async function checkProject(slug: string): Promise<void> {
  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.slug, slug));
  const branch = await getDefaultBranch(slug);
  const head = await getBranchHead(slug, branch);
  // The checks need no row of the project's; one that is there says where it is cloned from.
  const dir = await prepareWorkspace(slug, repo?.cloneUrl ?? cloneUrl(slug), branch, head, checksWorkspacePath(slug));
  console.log(`checkout of ${branch} at ${head.slice(0, 10)} ready at ${dir}`);
  const read = readProjectSetup(dir, NO_ROW);
  if (read.nightlyChecks.length === 0) {
    console.log(`${slug} names no nightly checks at ${head.slice(0, 10)}: nothing to run`);
    return;
  }
  const owner = checksOwner(slug);
  await droppingTestDatabases(owner, async () => {
    const project = await provideTestDatabases(owner, read);
    enter('setup');
    if (project.setupCommand) {
      console.log(`running setup: ${project.setupCommand}`);
      const setup = await runRepoCommand(dir, project.setupCommand, project.env);
      if (!setup.passed) throw new SetupCommandError(setup.trimmedOutput);
    }
    enter('checking');
    const results = await runChecks(dir, project);
    const account = checksAccount(results);
    if (results.some((r) => !r.passed)) throw new NightlyCheckError(account);
    console.log(account);
  });
}

/** By hand. A project that names no checks, or whose checks are already running, gets no run and no checkout. */
export async function runChecksOnDemand(slug: string): Promise<'no checks' | 'already running' | Run['state']> {
  if (checksNamed(await getDefaultBranchFile(slug, CONFIG_FILE)).length === 0) {
    console.log(`${slug} names no nightly checks: nothing to run`);
    return 'no checks';
  }
  // Before a run is recorded, so a second run by hand leaves no run and no report. The run itself
  // takes the lock.
  if ((await locksHeld(CHECKS_LOCK_CLASS)).has(checksLockKey(slug))) {
    console.log(new ChecksRunningError(slug).message);
    return 'already running';
  }
  const name = `${slug} checks`;
  const finished = await takeRecordedStep({
    command: { command: 'checks', project: slug, pr: null },
    name,
    started: (run) => `${name} started as ${run.id}`,
    needsProjectRow: false,
  });
  return finished.state;
}
