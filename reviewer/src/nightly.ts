import { listProjects, projectLine, type Project } from './projects.js';
import { ensureProjectRow } from './project-row.js';
import {
  errorType,
  finishRun,
  interruptRunsLeftRunning,
  runCommand,
  runLine,
  runLog,
  startRun,
  stopping,
  type Run,
  type RunResult,
} from './runs.js';

/** One piece of a nightly run's work: a run of `kind` for one project. */
export interface Step {
  project: string;
  kind: 'sweep';
}

/** What a nightly run does, from the projects it found: its steps in order, and a line for each project it leaves alone. */
export function nightlyWork(projects: Project[]): { steps: Step[]; skipped: string[] } {
  return {
    steps: projects.filter((p) => p.state === 'handled').map((p) => ({ project: p.slug, kind: 'sweep' })),
    skipped: projects.filter((p) => p.state !== 'handled').map(projectLine),
  };
}

export type Outcome = 'succeeded' | 'failed' | 'interrupted';

/**
 * What a nightly run does now, from how the steps taken so far ended (`outcomes[i]` is how
 * `steps[i]` ended). A step that failed, or that its time limit stopped, costs only itself: the
 * steps after it still run, and the run as a whole ends failed. Once the service is stopping no
 * further step is taken, and a run that leaves work undone that way ends interrupted.
 */
export function nightlyDecision(steps: Step[], outcomes: Outcome[], stopping = false): { next: Step } | { done: Outcome } {
  const undone = outcomes.length < steps.length || outcomes.includes('interrupted');
  if (stopping && undone) return { done: 'interrupted' };
  if (outcomes.length < steps.length) return { next: steps[outcomes.length] };
  return { done: outcomes.every((o) => o === 'succeeded') ? 'succeeded' : 'failed' };
}

/**
 * The whole nightly run: every handled project's sweep, one after another, each in a process of
 * its own. Every run is recorded, and the nightly run ends failed if any part of it did. Told to
 * stop, it stops the sweep it is on, takes no further step and ends interrupted.
 */
export async function runNightly(): Promise<Outcome> {
  // Before this run records itself, or it would be among them.
  const left = await interruptRunsLeftRunning();
  const nightly = await startRun({ kind: 'nightly' });
  const say = runLog(nightly);
  say(`nightly run ${nightly.id} started`);
  for (const run of left) say(`an earlier run never recorded how it ended: ${runLine(run)}`);

  let work: ReturnType<typeof nightlyWork>;
  try {
    work = nightlyWork(await listProjects());
  } catch (err) {
    say(`could not find the projects: ${err instanceof Error ? err.message : String(err)}`);
    await finishRun(nightly, { state: 'failed', stage: 'finding the projects', errorType: errorType(err) });
    return 'failed';
  }
  for (const line of work.skipped) say(line);

  const outcomes: Outcome[] = [];
  let decision = nightlyDecision(work.steps, outcomes, stopping());
  while ('next' in decision) {
    outcomes.push(await takeStep(nightly, decision.next, say));
    decision = nightlyDecision(work.steps, outcomes, stopping());
  }
  const stopped = decision.done === 'interrupted';
  await finishRun(nightly, { state: decision.done, stage: null, errorType: stopped ? 'service stopped' : null });
  const count = (outcome: Outcome) => outcomes.filter((o) => o === outcome).length;
  say(
    `nightly run ${nightly.id} ${decision.done}: of ${work.steps.length} project run(s), ` +
      `${count('failed')} failed, ${count('interrupted')} interrupted, ${work.steps.length - outcomes.length} not started`,
  );
  return decision.done;
}

async function takeStep(nightly: Run, step: Step, say: (line: string) => void): Promise<Outcome> {
  try {
    // A project registers itself (ADR 0004): the first night it is met, its row is made here.
    await ensureProjectRow(step.project);
    const run = await startRun({ kind: step.kind, project: step.project, parentId: nightly.id });
    say(`${step.project} ${step.kind} started as ${run.id}`);
    let result: RunResult;
    try {
      result = await runCommand(run, [step.kind, step.project]);
    } catch (err) {
      result = { state: 'failed', stage: 'starting', errorType: errorType(err) };
    }
    const finished = await finishRun(run, result);
    say(runLine(finished));
    return finished.state === 'running' ? 'failed' : finished.state;
  } catch (err) {
    // The run could not be recorded at all (the database, the state directory): still only this step's failure.
    say(`${step.project} ${step.kind} could not be run: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
}
