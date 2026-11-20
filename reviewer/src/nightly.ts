import { reportRun } from './failure-report.js';
import { listProjects, projectLine, type Project } from './projects.js';
import { errorType, finishRun, runCommand, runLine, runLog, startRun, type Run, type RunResult } from './runs.js';

/** One piece of a nightly run's work: a run of `kind` for one project. */
export interface Step {
  project: string;
  kind: 'sweep' | 'summary';
}

// A project's steps, in order. The summary step posts what the sweep before it left, and posts
// nothing when that sweep did not finish.
const PROJECT_STEPS: Step['kind'][] = ['sweep', 'summary'];

/** What a nightly run does, from the projects it found: its steps in order, and a line for each project it leaves alone. */
export function nightlyWork(projects: Project[]): { steps: Step[]; skipped: string[] } {
  return {
    steps: projects.filter((p) => p.state === 'handled').flatMap((p) => PROJECT_STEPS.map((kind) => ({ project: p.slug, kind }))),
    skipped: projects.filter((p) => p.state !== 'handled').map(projectLine),
  };
}

export type Outcome = 'succeeded' | 'failed';

/**
 * What a nightly run does now, from how the steps taken so far ended (`outcomes[i]` is how
 * `steps[i]` ended). A step that failed costs only itself: the steps after it still run, and the
 * run as a whole ends failed.
 */
export function nightlyDecision(steps: Step[], outcomes: Outcome[]): { next: Step } | { done: Outcome } {
  if (outcomes.length < steps.length) return { next: steps[outcomes.length] };
  return { done: outcomes.includes('failed') ? 'failed' : 'succeeded' };
}

/**
 * The whole nightly run: every handled project's sweep, one after another, each in a process of
 * its own. Every run is recorded and reported, and the nightly run ends failed if any part of it did.
 */
export async function runNightly(): Promise<Outcome> {
  const nightly = await startRun({ kind: 'nightly' });
  const say = runLog(nightly);
  say(`nightly run ${nightly.id} started`);

  let work: ReturnType<typeof nightlyWork>;
  try {
    work = nightlyWork(await listProjects());
  } catch (err) {
    say(`could not find the projects: ${err instanceof Error ? err.message : String(err)}`);
    await reportRun(await finishRun(nightly, { state: 'failed', stage: 'finding the projects', errorType: errorType(err) }), say);
    return 'failed';
  }
  for (const line of work.skipped) say(line);

  const outcomes: Outcome[] = [];
  let decision = nightlyDecision(work.steps, outcomes);
  while ('next' in decision) {
    outcomes.push(await takeStep(nightly, decision.next, say));
    decision = nightlyDecision(work.steps, outcomes);
  }
  const finished = await finishRun(nightly, { state: decision.done, stage: null, errorType: null });
  const failed = outcomes.filter((o) => o === 'failed').length;
  say(`nightly run ${nightly.id} ${decision.done}: ${failed} of ${outcomes.length} project run(s) failed`);
  // After every project, so the kit's repository hears of a kind of run once for the whole night.
  await reportRun(finished, say);
  return decision.done;
}

async function takeStep(nightly: Run, step: Step, say: (line: string) => void): Promise<Outcome> {
  try {
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
    await reportRun(finished, say);
    return finished.state === 'succeeded' ? 'succeeded' : 'failed';
  } catch (err) {
    // The run could not be recorded at all (the database, the state directory): still only this step's failure.
    say(`${step.project} ${step.kind} could not be run: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
}
