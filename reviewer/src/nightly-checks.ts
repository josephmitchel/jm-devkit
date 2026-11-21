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
import type { CHECKS_STAGES, Run } from './runs.js';
import { droppingTestDatabases, provideTestDatabases, type RunOwner } from './test-databases.js';
import { checksWorkspacePath, prepareWorkspace, runRepoCommand, streamRepoCommand, type StreamedCommand } from './workspace.js';

/**
 * A project's nightly checks (`nightly.checks` in its project config): commands too slow for
 * every pull request, run once a night after the project's sweep, or by hand. No agent runs.
 */

/**
 * The checks a project names, from the text of the project config on its default branch (null:
 * it has none). Read without a checkout, so a project that names none costs nothing more.
 */
export function checksNamed(config: string | null): TestCommand[] {
  return config === null ? [] : (parseDevkitConfig(config).nightly?.checks ?? []).map(({ name, command }) => ({ name, command }));
}

/**
 * Who a project's checks' test databases belong to. The project, not the run: the checks have no
 * row of their own to resume, so what a killed run left is dropped by the project's next one, or
 * by the next nightly run.
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

/** How one check ended. */
export interface CheckResult {
  name: string;
  passed: boolean;
  /** `exit N`, `killed by SIG…`, `stopped after N minutes` or `could not start`. */
  how: string;
  /** The end of what it wrote. */
  tail: string;
}

/**
 * What a run of the checks does now, from how the checks run so far ended (`results[i]` is how
 * `checks[i]` ended). They run in the order written. A check that failed costs only itself: the
 * checks after it still run, and the run as a whole ends failed.
 */
export function checksDecision(checks: TestCommand[], results: CheckResult[]): { next: TestCommand } | { done: 'succeeded' | 'failed' } {
  if (results.length < checks.length) return { next: checks[results.length] };
  return { done: results.every((r) => r.passed) ? 'succeeded' : 'failed' };
}

// What the account may take of the end of a run's output that reaches the project's failure
// issue (outputTail), which also holds the line naming the type of error.
const ACCOUNT_LINES = 36;
const ACCOUNT_CHARS = 3400;

/**
 * The last thing a run of the checks writes: each check that failed, how, and the end of what it
 * wrote, then the count. The failed checks share the room, so a failing check's output reaches
 * the issue however much the checks after it wrote.
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

/** How long one check may run before it is stopped and counted as failed. */
export function checkTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env.REVIEWER_CHECK_TIMEOUT_MS);
  return Number.isInteger(set) && set > 0 ? set : CHECK_TIMEOUT_MS;
}

function checkResult(name: string, ended: StreamedCommand): CheckResult {
  const how =
    ended.timedOutAfterMs !== null
      ? `stopped after ${Math.round(ended.timedOutAfterMs / 60_000)} minutes`
      : ended.signal !== null
        ? `killed by ${ended.signal}`
        : ended.exitCode !== null
          ? `exit ${ended.exitCode}`
          : 'could not start';
  return { name, passed: ended.exitCode === 0 && ended.timedOutAfterMs === null, how, tail: ended.tail };
}

/**
 * Run a project's nightly checks in its checkout, which has been set up. Each is one of the
 * project's own commands: it gets `project.env` and none of the code reviewer's credentials (see
 * repoCommandEnv). Everything a check writes goes to `write` as it comes.
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
 * One run of a project's nightly checks, as the command a recorded run starts.
 *
 * The checks get a checkout of their own (see checksWorkspacePath) at the default branch's head
 * as it is now, read after the project's sweep has finished: the head the sweep audited or a
 * newer one, never an older. It is made and set up the way the sweep's is: the same reset, the
 * project's setup command, `reviewer.env`, and fresh databases for `reviewer.databases`, since the
 * sweep's were dropped when it ended. Throws {@link NightlyCheckError} when a check failed.
 *
 * One run per project at a time, by the project's checks lock: a second would reset the first's
 * checkout and drop its databases. It throws {@link ChecksRunningError} before touching either.
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

/**
 * Run one project's nightly checks by hand: recorded as a run of its own and reported like the
 * step of a nightly run. A project that names none gets no run and no checkout, and nor does one
 * whose checks are already running. The caller has stop signals stop the run
 * (stopCommandsOnSignal), so one stopped by hand ends `interrupted`.
 */
export async function runChecksOnDemand(slug: string): Promise<'no checks' | 'already running' | Run['state']> {
  if (checksNamed(await getDefaultBranchFile(slug, CONFIG_FILE)).length === 0) {
    console.log(`${slug} names no nightly checks: nothing to run`);
    return 'no checks';
  }
  // Looked at before a run is recorded, so a second run by hand leaves no run and no report.
  // The run itself takes the lock, and is the one refused if another got in between.
  if ((await locksHeld(CHECKS_LOCK_CLASS)).has(checksLockKey(slug))) {
    console.log(new ChecksRunningError(slug).message);
    return 'already running';
  }
  const name = `${slug} checks`;
  const finished = await takeRecordedStep({
    kind: 'checks',
    project: slug,
    args: ['checks', slug],
    name,
    started: (run) => `${name} started as ${run.id}`,
    // The checks need no row of the project's (runProjectChecks).
    needsProjectRow: false,
  });
  return finished.state;
}
