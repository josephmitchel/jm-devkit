import { CONFIG_FILE, DevkitConfigError, parseDevkitConfig } from '../../plugin/devkit-config.mjs';
import { SWEEP_WORKFLOW } from '../../plugin/generator/generate.mjs';
import { GitHubError, defaultBranchFile, installedRepos } from '../../plugin/install/app.mjs';
import { appCredentials } from './gh-auth.js';

export interface Observed {
  /** The text of its devkit.json, or null when it has none. */
  config: string | null;
  sweepWorkflow: boolean;
}

export type ProjectState =
  /** `nightlyChecks`: how many nightly checks its project config names. */
  | { state: 'handled'; nightlyChecks: number }
  /** `invalidConfig`: skipped for having a project config the schema rejects, not for having none. */
  | { state: 'still on Actions' | 'skipped'; reason: string; invalidConfig?: true };

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
    return { state: 'skipped', reason: err.message, invalidConfig: true };
  }
}

export type Project = { slug: string } & ProjectState;

/** In name order. */
export function classifyProjects(observed: Array<{ slug: string } & Observed>): Project[] {
  return observed
    .map(({ slug, ...seen }) => ({ slug, ...projectState(seen) }))
    .sort((a, b) => compare(a.slug.toLowerCase(), b.slug.toLowerCase()));
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function projectLine(project: Project): string {
  if (project.state === 'handled') return `${project.slug} handled`;
  return `${project.slug} ${project.state}: ${project.reason.replace(/\s+/g, ' ')}`;
}

/** Asked of GitHub on every call: the kit keeps no list (ADR 0004). */
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
