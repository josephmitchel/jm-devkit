import { DevkitConfigError } from '../../plugin/devkit-config.mjs';
import { UPDATE_STAGES } from '../bin/update.mjs';
import { reportRun } from './failure-report.js';
import { lockFault, MACHINE_LOCK, MachineLockError, NIGHTLY_LOCK, tryLock, type Held } from './machine.js';
import { listProjects, projectLine, type Project } from './projects.js';
import { machineFor } from './queue.js';
import { takeRecordedStepOrSayWhy } from './recorded-step.js';
import {
  errorType,
  finishRun,
  interruptRunsLeftRunning,
  NIGHTLY_STAGES,
  runLine,
  runLog,
  startRun,
  stopping,
  type Run,
  type RunResult,
} from './runs.js';
import { dropDatabasesLeftBehind } from './test-databases.js';

/** One piece of a nightly run's work: a run of `kind` for one project. */
export interface Step {
  project: string;
  kind: 'sweep' | 'summary' | 'checks';
  /** On a sweep that cannot start: what is wrong with the project's config. */
  invalidConfig?: string;
}

// A project's steps, in order. The summary step posts what the sweep before it left, and posts
// nothing when that sweep did not finish. The checks step is only for a project that names checks.
const PROJECT_STEPS: Step['kind'][] = ['sweep', 'summary', 'checks'];

/**
 * What a nightly run does, from the projects it found: its steps in order, and a line for each
 * project it leaves alone. A project that names no nightly checks has no checks step. A project
 * the machine would handle but for an invalid project config has one step, a sweep that cannot
 * start, so the project is told; one with no project config is not under the kit and is left alone.
 */
export function nightlyWork(projects: Project[]): { steps: Step[]; skipped: string[] } {
  const invalid = (p: Project) => p.state === 'skipped' && p.invalidConfig === true;
  return {
    steps: projects.flatMap((p): Step[] => {
      if (p.state === 'handled') {
        return PROJECT_STEPS.filter((kind) => kind !== 'checks' || p.nightlyChecks > 0).map((kind) => ({ project: p.slug, kind }));
      }
      return invalid(p) ? [{ project: p.slug, kind: 'sweep', invalidConfig: p.reason }] : [];
    }),
    skipped: projects.filter((p) => p.state !== 'handled' && !invalid(p)).map(projectLine),
  };
}

/** How a step that cannot start is recorded: failed before it began, on the project's side. Null for one that can. */
export function refusedResult(step: Step): RunResult | null {
  return step.invalidConfig === undefined ? null : { state: 'failed', stage: 'starting', errorType: DevkitConfigError.name };
}

export type Outcome = 'succeeded' | 'failed' | 'interrupted';

/**
 * What a nightly run does now, from how the steps taken so far ended (`outcomes[i]` is how
 * `steps[i]` ended). A step that failed, or that its time limit stopped, costs only itself: the
 * steps after it still run, and the run as a whole ends failed. Once the service is stopping no
 * further step is taken, and a run that leaves work undone that way ends interrupted. Nor is one
 * taken once the connection holding the machine's lock is lost: the run can no longer say that no
 * other agent job is running, and ends failed with its steps undone.
 */
export function nightlyDecision(
  steps: Step[],
  outcomes: Outcome[],
  stopping = false,
  lockLost = false,
): { next: Step } | { done: Outcome; lockLost?: true } {
  const undone = outcomes.length < steps.length || outcomes.includes('interrupted');
  if (stopping && undone) return { done: 'interrupted' };
  if (lockLost && outcomes.length < steps.length) return { done: 'failed', lockLost: true };
  if (outcomes.length < steps.length) return { next: steps[outcomes.length] };
  return { done: outcomes.every((o) => o === 'succeeded') ? 'succeeded' : 'failed' };
}

const LOCK_LOST = "the connection holding the machine's lock was lost";

// How often a nightly run that is waiting for the machine looks again.
const LOOKS_AGAIN_EVERY_MS = 15_000;

/**
 * Take the machine for the night, waiting for a review that is running to finish first. The wait
 * is at most a review's time limit. Returns null when this process was told to stop meanwhile.
 */
async function takeMachine(say: (line: string) => void): Promise<Held | null> {
  let said = false;
  for (;;) {
    const machine = await tryLock(MACHINE_LOCK);
    const turn = machineFor('nightly run', { agentJobRunning: machine === null, nightlyGoing: true });
    if (machine && turn.take) return machine;
    await machine?.release();
    if (!turn.take && !said) say(turn.why);
    said = true;
    for (let waited = 0; waited < LOOKS_AGAIN_EVERY_MS; waited += 1000) {
      if (stopping()) return null;
      await new Promise((again) => setTimeout(again, 1000));
    }
  }
}

/**
 * The whole nightly run: every handled project's steps (its sweep, its summary, its nightly
 * checks), one after another, each in a process of its own. Every run is recorded and reported,
 * and the nightly run ends failed if any part of it did. Told to stop, it stops the step it is
 * on, takes no further step and ends interrupted.
 *
 * It has the machine from its first step to its last. While it is going no review starts (the
 * queue sees its lock), and a review already running is waited for, so the night is put back and
 * never skipped. A second nightly run beside one that is going does not start.
 */
export async function runNightly(): Promise<Outcome | 'not started'> {
  const night = await tryLock(NIGHTLY_LOCK);
  if (!night) {
    console.log('another nightly run is going: this one does not start');
    return 'not started';
  }
  try {
    return await theNight(night);
  } finally {
    await night.release();
  }
}

async function theNight(night: Held): Promise<Outcome> {
  // Before anything trusts the lock: what follows calls other runs dead on its word.
  const fault = await lockFault(night);
  if (fault) return notStarted(fault);
  // Before this run records itself, or it would be among them. No other nightly run is going, so
  // what an earlier one left `running` is dead.
  const left = await interruptRunsLeftRunning();
  const nightly = await startRun({ kind: 'nightly' });
  const say = runLog(nightly);
  say(`nightly run ${nightly.id} started`);
  for (const run of left) say(`an earlier run never recorded how it ended: ${runLine(run)}`);

  const machine = await takeMachine(say);
  if (!machine) {
    const finished = await finishRun(nightly, { state: 'interrupted', stage: null, errorType: 'service stopped' });
    say(`nightly run ${nightly.id} interrupted while it waited for the machine: nothing was started`);
    await reportRun(finished, say);
    return 'interrupted';
  }
  try {
    // With the machine in hand no review or sweep is running, so what one left is nobody's.
    for (const line of await dropDatabasesLeftBehind().catch((err) => [`could not look for test databases left behind (${String(err).split('\n')[0]})`])) say(line);
    return await takeSteps(nightly, say, () => machine.lost() || night.lost());
  } finally {
    await machine.release();
  }
}

/** A nightly run that starts no agent job because its lock does not hold: recorded failed, and reported. */
async function notStarted(fault: Error): Promise<Outcome> {
  const nightly = await startRun({ kind: 'nightly' });
  const say = runLog(nightly);
  say(`nightly run ${nightly.id} not started: ${fault.message}`);
  await reportRun(await finishRun(nightly, { state: 'failed', stage: 'starting', errorType: errorType(fault) }), say);
  return 'failed';
}

async function takeSteps(nightly: Run, say: (line: string) => void, lockLost: () => boolean): Promise<Outcome> {
  let work: ReturnType<typeof nightlyWork>;
  try {
    work = nightlyWork(await listProjects());
  } catch (err) {
    say(`could not find the projects: ${err instanceof Error ? err.message : String(err)}`);
    await reportRun(await finishRun(nightly, { state: 'failed', stage: NIGHTLY_STAGES[0], errorType: errorType(err) }), say);
    return 'failed';
  }
  for (const line of work.skipped) say(line);

  const outcomes: Outcome[] = [];
  let decision = nightlyDecision(work.steps, outcomes, stopping(), lockLost());
  while ('next' in decision) {
    outcomes.push(await takeStep(nightly, decision.next, say));
    decision = nightlyDecision(work.steps, outcomes, stopping(), lockLost());
  }
  // An error of the run's own, which is what tells it from a night on which only a project's run failed.
  const own = decision.lockLost
    ? { stage: NIGHTLY_STAGES[1], errorType: MachineLockError.name }
    : { stage: null, errorType: decision.done === 'interrupted' ? 'service stopped' : null };
  const finished = await finishRun(nightly, { state: decision.done, ...own });
  const count = (outcome: Outcome) => outcomes.filter((o) => o === outcome).length;
  say(
    `nightly run ${nightly.id} ${decision.done}: of ${work.steps.length} project run(s), ` +
      `${count('failed')} failed, ${count('interrupted')} interrupted, ${work.steps.length - outcomes.length} not started` +
      (decision.lockLost ? ` (${LOCK_LOST})` : ''),
  );
  // After every project, so the kit's repository hears of a kind of run once for the whole night.
  await reportRun(finished, say);
  return decision.done;
}

/**
 * How a nightly run that never started is recorded: failed, in the step of bringing the code
 * reviewer up to date that failed. Null when either word is not one of the fixed ones, so the
 * record cannot be made to hold text of a caller's choosing.
 */
export function notStartedResult(stage: string, errorType: string): RunResult | null {
  const known = (UPDATE_STAGES as readonly string[]).includes(stage);
  if (!known || !/^(exit \d+|killed by SIG[A-Z0-9]+|could not start)$/.test(errorType)) return null;
  return { state: 'failed', stage, errorType };
}

/** Record and report a nightly run that could not start. Returns false when given nothing it can record. */
export async function recordNightlyNotStarted(stage: string, errorType: string): Promise<boolean> {
  const result = notStartedResult(stage, errorType);
  if (!result) return false;
  const nightly = await startRun({ kind: 'nightly' });
  const say = runLog(nightly);
  say(`nightly run ${nightly.id} not started: ${stage} failed (${errorType}). The system journal has the output.`);
  await reportRun(await finishRun(nightly, result), say);
  return true;
}

async function takeStep(nightly: Run, step: Step, say: (line: string) => void): Promise<Outcome> {
  const name = `${step.project} ${step.kind}`;
  const refused = refusedResult(step);
  const finished = await takeRecordedStepOrSayWhy(
    {
      kind: step.kind,
      project: step.project,
      parentId: nightly.id,
      args: [step.kind, step.project],
      name,
      started: (run) => `${name} started as ${run.id}`,
      needsProjectRow: !refused,
      refused: refused && { why: `${step.project} has a project config that is not valid: ${step.invalidConfig}`, result: refused },
    },
    say,
  );
  return finished === null || finished.state === 'running' ? 'failed' : finished.state;
}
