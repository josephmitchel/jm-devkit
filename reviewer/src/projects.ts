import { CONFIG_FILE, DevkitConfigError, parseDevkitConfig } from '../../plugin/devkit-config.mjs';
import { SWEEP_WORKFLOW } from '../../plugin/generator/generate.mjs';
import { GitHubError, defaultBranchFile, installedRepos } from '../../plugin/install/app.mjs';
import { appCredentials } from './gh-auth.js';

/** What was seen on a project's default branch. */
export interface Observed {
  /** The text of its devkit.json, or null when it has none. */
  config: string | null;
  /** Whether the kit's sweep workflow is still there. */
  sweepWorkflow: boolean;
}

export type ProjectState =
  /** `nightlyChecks`: how many nightly checks its project config names. */
  | { state: 'handled'; nightlyChecks: number }
  | { state: 'still on Actions' | 'skipped'; reason: string };

/** Whether the machine handles a project, from what was seen on its default branch. */
export function projectState(observed: Observed): ProjectState {
  // Checked first: a project is reviewed from one place, and the workflow means Actions still does it.
  if (observed.sweepWorkflow) {
    return { state: 'still on Actions', reason: `its default branch has ${SWEEP_WORKFLOW}` };
  }
  if (observed.config === null) return { state: 'skipped', reason: `its default branch has no ${CONFIG_FILE}` };
  try {
    const config = parseDevkitConfig(observed.config);
    return { state: 'handled', nightlyChecks: config.nightly?.checks?.length ?? 0 };
  } catch (err) {
    if (!(err instanceof DevkitConfigError)) throw err;
    return { state: 'skipped', reason: err.message };
  }
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

/**
 * Every project the code reviewer's App is installed on, in name order, each with whether the
 * machine handles it. Asked of GitHub on every call: the kit keeps no list (ADR 0004).
 */
export async function listProjects(): Promise<Project[]> {
  const credentials = appCredentials();
  if (!credentials) {
    throw new Error("finding the projects needs the code reviewer's App: set REVIEWER_APP_CLIENT_ID and REVIEWER_APP_PRIVATE_KEY");
  }
  try {
    const repos = await installedRepos({ fetch, credentials });
    const observed = await Promise.all(
      repos.map(async ({ slug, token }) => {
        const read = (path: string) => defaultBranchFile({ fetch, slug, token, path });
        const [config, workflow] = await Promise.all([read(CONFIG_FILE), read(SWEEP_WORKFLOW)]);
        return { slug, config, sweepWorkflow: workflow !== null };
      }),
    );
    return classifyProjects(observed);
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    throw new Error(`GitHub refused the code reviewer's App: ${err.message}`, { cause: err });
  }
}
