/** The stages of bringing the code reviewer up to date, by the fixed names a run records. */
export const UPDATE_STAGES: readonly ['moving the checkout', 'installing dependencies', 'applying migrations'];
export type UpdateStage = (typeof UPDATE_STAGES)[number];

export interface UpdateOptions {
  /** The kit's checkout: the directory that holds `reviewer/`. */
  kitDir: string;
  env?: NodeJS.ProcessEnv;
  /** The commands for each step, run in `reviewer/`. Replaced only in tests. */
  install?: string[];
  migrate?: string[];
  /** Run with the stage and the type of error appended, when a step failed. */
  record?: string[];
  log?: (line: string) => void;
}

export function updateCheckout(options: UpdateOptions): { ok: true } | { ok: false; stage: UpdateStage; errorType: string };
