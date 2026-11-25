import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE, DevkitConfigError, parseDevkitConfig } from '../../plugin/devkit-config.mjs';
import type { TestCommand } from './db/schema.js';

/** How to set up and test a project, as one run of the code reviewer sees it: its `devkit.json`. */
export interface ProjectSetup {
  setupCommand: string | null;
  testCommands: TestCommand[];
  /** Auditors per quality characteristic in a full round. */
  redundancy: number;
  /** The notes themselves, not a path: what the testing auditor is shown. */
  harnessNotes: string | null;
  extraContext: string | null;
  /** Environment for the project's setup, test and nightly check commands. */
  env: Record<string, string>;
  /**
   * The variables that each need an empty database for the run. Their addresses join `env` once
   * the databases exist (see test-databases.ts).
   */
  databases: string[];
  /** The project's nightly checks (`nightly.checks`), in the order written. Only a run of the nightly checks runs them. */
  nightlyChecks: TestCommand[];
}

const INSTALL = 'run /devkit:install in the project to bring it under the kit';

/**
 * The one place a run learns how to set up and test the project in `checkoutDir`, from the
 * `reviewer` section of its `devkit.json`: a field the file leaves out means none (or, for
 * redundancy, 1). A project with no `devkit.json`, one that does not use the process module, a
 * file the schema rejects, or harness notes it points at that are not there throws a
 * {@link DevkitConfigError}, which fails the run as the project's fault.
 */
export function readProjectSetup(checkoutDir: string): ProjectSetup {
  const file = path.join(checkoutDir, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    throw new DevkitConfigError(`the project has no ${CONFIG_FILE}: ${INSTALL}`);
  }
  const config = parseForReviewer(fs.readFileSync(file, 'utf8'));
  const reviewer = config.reviewer;
  return {
    setupCommand: reviewer.setup ?? null,
    testCommands: reviewer.tests.map(({ name, command }) => ({ name, command })),
    redundancy: reviewer.redundancy ?? 1,
    harnessNotes: reviewer.harnessNotes === undefined ? null : readHarnessNotes(checkoutDir, reviewer.harnessNotes),
    extraContext: reviewer.extraContext ?? null,
    env: { ...reviewer.env },
    databases: [...(reviewer.databases ?? [])],
    nightlyChecks: (config.nightly?.checks ?? []).map(({ name, command }) => ({ name, command })),
  };
}

/** A `modules` the schema rejects means the project is not under the process module, which install puts it under. */
function parseForReviewer(text: string): ReturnType<typeof parseDevkitConfig> {
  try {
    return parseDevkitConfig(text);
  } catch (err) {
    if (!(err instanceof DevkitConfigError && err.errors.some((e: string) => e.startsWith('modules')))) throw err;
    throw new DevkitConfigError(`${err.message}. The code reviewer serves projects under the "process" module: ${INSTALL}`, err.errors);
  }
}

function readHarnessNotes(checkoutDir: string, relative: string): string {
  const field = 'reviewer.harnessNotes';
  const root = fs.realpathSync(checkoutDir);
  const target = path.resolve(root, relative);
  if (path.isAbsolute(relative) || !isInside(root, target)) {
    throw new DevkitConfigError(`${CONFIG_FILE}: ${field} must be a path inside the project, not ${relative}`);
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new DevkitConfigError(`${CONFIG_FILE}: ${field} points at ${relative}, which is not a file in the project`);
  }
  // Checked again once resolved: a symlink in the checkout must not lead the notes, and so the
  // auditors' prompts, to a file on the runner outside it.
  if (!isInside(root, fs.realpathSync(target))) {
    throw new DevkitConfigError(`${CONFIG_FILE}: ${field} must be a path inside the project, not ${relative}`);
  }
  return fs.readFileSync(target, 'utf8');
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
