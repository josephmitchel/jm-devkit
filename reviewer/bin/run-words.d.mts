/** The stages of bringing the code reviewer up to date, by the fixed names a run records. */
export const UPDATE_STAGES: readonly ['moving the checkout', 'installing dependencies', 'applying migrations'];
export type UpdateStage = (typeof UPDATE_STAGES)[number];

/** How a process ended, as a type of error: `exit N`, `killed by SIG…`, or `could not start`. */
export function howEnded(exitCode: number | null | undefined, signal: string | null | undefined): string;

/** What howEnded gives, and nothing else. */
export const HOW_ENDED: RegExp;
