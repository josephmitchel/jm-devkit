// The words a run is recorded with that bin/update.mjs writes too. Plain Node with no dependency:
// update.mjs runs before the code reviewer's dependencies are installed. The rest of the
// vocabulary is in src/run-vocabulary.ts, which takes these from here.

/** The stages of bringing the code reviewer up to date, by the fixed names a run records. */
export const UPDATE_STAGES = ['moving the checkout', 'installing dependencies', 'applying migrations'];

/** How a process ended, as a type of error: `exit N`, `killed by SIG…`, or `could not start`. */
export function howEnded(exitCode, signal) {
  if (signal) return `killed by ${signal}`;
  return exitCode === null || exitCode === undefined ? 'could not start' : `exit ${exitCode}`;
}

/** What howEnded gives, and nothing else. */
export const HOW_ENDED = /^(?:exit \d{1,3}|killed by SIG[A-Z0-9]{2,8}|could not start)$/;
