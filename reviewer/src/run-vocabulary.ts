import { HOW_ENDED, UPDATE_STAGES, howEnded } from '../bin/run-words.mjs';
import { reviewState, sweepState } from './db/schema.js';
import { projectFault } from './failure-side.js';

/**
 * Each word is written beside what recognises it. A word from a run reaches an issue in the kit's
 * repository only if it is recognised here, so nothing a project wrote can pass for one.
 */

export { HOW_ENDED, UPDATE_STAGES, howEnded };

export const CHECKS_STAGES = ['setup', 'checking'] as const;
export const NIGHTLY_STAGES = ['finding the projects', 'working through the projects'] as const;
// Only these count, so a line in a project's output cannot name a stage of its choosing.
const PRINTED_STAGES = new Set<string>([...sweepState.enumValues, ...reviewState.enumValues, ...CHECKS_STAGES]);
/**
 * The printed ones, `starting` before any of them, the nightly run's own, and the steps of bringing
 * the code reviewer up to date.
 */
export const RUN_STAGES: ReadonlySet<string> = new Set([...PRINTED_STAGES, 'starting', ...NIGHTLY_STAGES, ...UPDATE_STAGES]);

// The lines the sweep's, the review's and the nightly checks' drivers print as they enter or resume a stage.
const STAGE_LINE = /=== (?:sweep |checks )?state: (\w+) ===|resuming (?:sweep|review) \d+ for \S+ in state (\w+)/g;

/** `starting` before it reached one of its own. */
export function stageReached(output: string): string {
  const stages = [...output.matchAll(STAGE_LINE)].map((m) => m[1] ?? m[2]).filter((s) => PRINTED_STAGES.has(s) && s !== 'failed');
  return stages.at(-1) ?? 'starting';
}

/** `found running`: a run whose process died unrecorded. */
export type StopReason = 'time limit' | 'service stopped' | 'found running';

/** An error's class name, and nothing a message or a project could put there. */
export function errorType(err: unknown): string {
  return err instanceof Error && /^[A-Za-z]\w*$/.test(err.name) ? err.name : 'Error';
}

const errorTypeLineStart = (runId: string) => `${runId} error type: `;

/**
 * It carries the run id because a project's own commands are never given it, so a line in their
 * output cannot pass for this one.
 */
export function errorTypeLine(runId: string, err: unknown): string {
  return `${errorTypeLineStart(runId)}${errorType(err)}`;
}

export function reportedErrorType(runId: string, output: string): string | null {
  const start = errorTypeLineStart(runId);
  return output.split('\n').findLast((line) => line.startsWith(start))?.slice(start.length) ?? null;
}

// The error classes shown by name. A new class of the code reviewer's own is added here; a
// project's fault is listed in failure-side.ts.
const KNOWN_ERROR_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'ZodError',
  'DrizzleError',
  'DrizzleQueryError',
  'GitHubError',
  'MachineLockError',
  'ChecksRunningError',
]);
// The one way of being stopped that is reported as a failure.
const REPORTED_STOP: StopReason = 'time limit';

export function isErrorType(text: string): boolean {
  return KNOWN_ERROR_TYPES.has(text) || HOW_ENDED.test(text) || text === REPORTED_STOP || projectFault(text) !== null;
}
