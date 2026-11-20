import { CONFIG_FILE, DevkitConfigError, parseDevkitConfig } from '../../plugin/devkit-config.mjs';
import { SWEEP_WORKFLOW } from '../../plugin/generator/generate.mjs';

/** What was seen on a project's default branch. */
export interface Observed {
  /** The text of its devkit.json, or null when it has none. */
  config: string | null;
  /** Whether the kit's sweep workflow is still there. */
  sweepWorkflow: boolean;
}

export type ProjectState = { state: 'handled' } | { state: 'still on Actions' | 'skipped'; reason: string };

/** Whether the machine handles a project, from what was seen on its default branch. */
export function projectState(observed: Observed): ProjectState {
  // Checked first: a project is reviewed from one place, and the workflow means Actions still does it.
  if (observed.sweepWorkflow) {
    return { state: 'still on Actions', reason: `its default branch has ${SWEEP_WORKFLOW}` };
  }
  if (observed.config === null) return { state: 'skipped', reason: `its default branch has no ${CONFIG_FILE}` };
  try {
    parseDevkitConfig(observed.config);
  } catch (err) {
    if (!(err instanceof DevkitConfigError)) throw err;
    return { state: 'skipped', reason: err.message };
  }
  return { state: 'handled' };
}

/** A project the App is installed on, and whether the machine handles it. */
export type Project = { slug: string } & ProjectState;

/** Each observed project with its state, in name order. */
export function classifyProjects(observed: Array<{ slug: string } & Observed>): Project[] {
  return observed
    .map(({ slug, ...seen }) => ({ slug, ...projectState(seen) }))
    .sort((a, b) => compare(a.slug.toLowerCase(), b.slug.toLowerCase()));
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A project's line in the `projects` command's output. */
export function projectLine(project: Project): string {
  if (project.state === 'handled') return `${project.slug} handled`;
  return `${project.slug} ${project.state}: ${project.reason.replace(/\s+/g, ' ')}`;
}
