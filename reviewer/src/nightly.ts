import { projectLine, type Project } from './projects.js';

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
