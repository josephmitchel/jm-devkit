/**
 * A failure is filed where the fault is: in the project when the project broke the run, in the
 * kit's repository for everything else.
 */

export type Side = 'project' | 'kit';

export class SetupCommandError extends Error {
  constructor(output: string | null) {
    super(`setup command failed:\n${output ?? ''}`);
    this.name = 'SetupCommandError';
  }
}

/** `account` is the message, so it is the last thing the run writes. */
export class NightlyCheckError extends Error {
  constructor(account: string) {
    super(account);
    this.name = 'NightlyCheckError';
  }
}

/**
 * Each with what went wrong, in words that finish "… failed for a reason on the project's side:".
 * To put another failure on the project's side, throw an error class of its own where it happens
 * and add its name here. A type not listed is the code reviewer's side.
 */
const PROJECT_FAULTS = new Map<string, string>([
  ['NotUnderKitError', 'it has no project config (`devkit.json`), so it is not under the kit: run `/devkit:install` in it'],
  ['DevkitConfigError', 'its project config (`devkit.json`) is invalid'],
  ['SetupCommandError', 'its setup command failed'],
  ['MissingDiscussionCategoryError', "it has discussions turned off, or no discussion category for the code reviewer's summaries"],
  ['NightlyCheckError', 'one of its nightly checks failed'],
]);

/** Null when the type of error is not a project's fault. */
export function projectFault(errorType: string | null): string | null {
  return errorType === null ? null : (PROJECT_FAULTS.get(errorType) ?? null);
}

export function failureSide(errorType: string | null): Side {
  return projectFault(errorType) === null ? 'kit' : 'project';
}
