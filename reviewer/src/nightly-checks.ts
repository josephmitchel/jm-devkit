import type { TestCommand } from './db/schema.js';
import type { ProjectSetup } from './project-config.js';
import { streamRepoCommand, type StreamedCommand } from './workspace.js';

/**
 * A project's nightly checks (`nightly.checks` in its project config): commands too slow for
 * every pull request, run once a night after the project's sweep, or by hand. No agent runs.
 */

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
  timeoutMs?: number,
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
