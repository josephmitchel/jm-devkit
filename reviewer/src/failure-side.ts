/**
 * Which side a failed run is on. A failure is filed where the fault is: in the project when the
 * project broke the run, in the kit's repository for everything else.
 */

export type Side = 'project' | 'kit';

/** The project's own setup command exited non-zero or was killed. */
export class SetupCommandError extends Error {
  constructor(output: string | null) {
    super(`setup command failed:\n${output ?? ''}`);
    this.name = 'SetupCommandError';
  }
}

/**
 * One or more of a project's nightly checks failed. `account` says which, with the end of what
 * each wrote; it is the message, so it is the last thing the run writes.
 */
export class NightlyCheckError extends Error {
  constructor(account: string) {
    super(account);
    this.name = 'NightlyCheckError';
  }
}

/**
 * The types of error that are a project's own fault, each with what went wrong in words that
 * finish "… failed for a reason on the project's side:". To put another failure on the project's
 * side, throw an error class of its own where it happens and add the class's name here. A type
 * not listed is the code reviewer's side.
 */
const PROJECT_FAULTS = new Map<string, string>([
  ['DevkitConfigError', 'its project config (`devkit.json`) is invalid'],
  ['SetupCommandError', 'its setup command failed'],
  ['MissingDiscussionCategoryError', "it has discussions turned off, or no discussion category for the code reviewer's summaries"],
  ['NightlyCheckError', 'one of its nightly checks failed'],
]);

/** What went wrong on the project's side, or null when the type of error is not a project's fault. */
export function projectFault(errorType: string | null): string | null {
  return errorType === null ? null : (PROJECT_FAULTS.get(errorType) ?? null);
}

export function failureSide(errorType: string | null): Side {
  return projectFault(errorType) === null ? 'kit' : 'project';
}
