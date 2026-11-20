import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE, DevkitConfigError, parseDevkitConfig } from '../../plugin/devkit-config.mjs';
import type { TestCommand } from './db/schema.js';
import type { RepoRow } from './stages/context.js';

/**
 * How to set up and test a project, as one run of the code reviewer sees it. Read from the
 * project's `devkit.json` when its checkout has one, and from the project's database row when it
 * does not, so a project that has not been given a `devkit.json` yet runs exactly as before.
 */
export interface ProjectSetup {
  source: 'devkit.json' | 'database';
  setupCommand: string | null;
  testCommands: TestCommand[];
  /** Auditors per quality characteristic in a full round. */
  redundancy: number;
  /** The notes themselves, not a path: what the testing auditor is shown. */
  harnessNotes: string | null;
  extraContext: string | null;
  /**
   * Environment for the project's setup and test commands. Empty from the database row, whose
   * project gets its environment from the action's `repo-env` input alone.
   */
  env: Record<string, string>;
  /**
   * The variables that each need an empty database for the run. None from the database row. Their
   * addresses join `env` once the databases exist (see test-databases.ts).
   */
  databases: string[];
  /**
   * The project's nightly checks (`nightly.checks`), in the order written. None from the database
   * row. Only a run of the nightly checks runs them.
   */
  nightlyChecks: TestCommand[];
}

/** The part of a project's database row that `devkit.json` replaces. */
export type ProjectRow = Pick<RepoRow, 'setupCommand' | 'testCommands' | 'redundancy' | 'harnessNotes' | 'extraContext'>;

/**
 * The one place a run learns how to set up and test the project in `checkoutDir`.
 *
 * With a `devkit.json` at the root, its `reviewer` section is the whole answer: the row is not
 * consulted, so a field the file leaves out means none (or, for redundancy, 1), never the row's
 * value. A file the schema rejects, or harness notes it points at that are not there, throws a
 * {@link DevkitConfigError}, which fails the run, rather than falling back to the row: a project
 * that wrote the file meant it.
 */
export function readProjectSetup(checkoutDir: string, row: ProjectRow): ProjectSetup {
  const file = path.join(checkoutDir, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    return {
      source: 'database',
      setupCommand: row.setupCommand,
      testCommands: row.testCommands,
      redundancy: row.redundancy,
      harnessNotes: row.harnessNotes,
      extraContext: row.extraContext,
      env: {},
      databases: [],
      nightlyChecks: [],
    };
  }

  const config = parseDevkitConfig(fs.readFileSync(file, 'utf8'));
  const reviewer = config.reviewer;
  return {
    source: 'devkit.json',
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
