import type { UpdateStage } from './run-words.mjs';

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
