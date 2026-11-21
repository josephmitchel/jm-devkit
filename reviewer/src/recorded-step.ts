import { reportRun } from './failure-report.js';
import { why } from './log.js';
import { ensureProjectRow } from './project-row.js';
import { errorType } from './run-vocabulary.js';
import { commandKind, finishRun, runCommand, runLine, runLog, startRun, type ProjectCommand, type Run, type RunResult } from './runs.js';

export interface RecordedStep {
  command: ProjectCommand;
  /** The nightly run it is a step of. */
  parentId?: string;
  /** What the log calls it: `acme/widgets sweep`, `acme/widgets merged:12`. */
  name: string;
  started(run: Run): string;
  /** ADR 0004: the first run that needs the project's row makes it. */
  needsProjectRow: boolean;
  /** Recorded with this result and `why`; no command is run. */
  refused?: { why: string; result: RunResult } | null;
  /** Once the run is on record, before its command starts. */
  onStart?(run: Run): Promise<void>;
  /**
   * With how the command ended, before the run is recorded as over. `note` is added to the run's
   * line in the log; `report: false` keeps the run from being reported.
   */
  beforeFinish?(result: RunResult): Promise<{ note?: string; report?: boolean } | void>;
}

/**
 * The one way a command becomes a recorded run. A command that could not be started ends the run
 * failed in `starting`. Lines go to `say`, or to the run's own log. Throws only when the run could
 * not be recorded (the database, the state directory).
 */
export async function takeRecordedStep(step: RecordedStep, say?: (line: string) => void): Promise<Run> {
  const { command, project } = step.command;
  if (step.needsProjectRow) await ensureProjectRow(project);
  const run = await startRun({ kind: commandKind(command), project, parentId: step.parentId });
  const log = say ?? runLog(run);
  await step.onStart?.(run);
  log(step.started(run));
  let result: RunResult;
  if (step.refused) {
    // The run's output is what a report of it quotes.
    runLog(run)(step.refused.why);
    result = step.refused.result;
  } else {
    try {
      result = await runCommand(run, step.command);
    } catch (err) {
      result = { state: 'failed', stage: 'starting', errorType: errorType(err) };
    }
  }
  const { note = '', report = true } = (await step.beforeFinish?.(result)) ?? {};
  const finished = await finishRun(run, result);
  log(`${runLine(finished)}${note}`);
  if (report) await reportRun(finished, log);
  return finished;
}

/** For a caller with more steps to take: a step whose run could not be recorded is a line in the log and null. */
export async function takeRecordedStepOrSayWhy(step: RecordedStep, say: (line: string) => void): Promise<Run | null> {
  try {
    return await takeRecordedStep(step, say);
  } catch (err) {
    say(`${step.name} could not be run: ${why(err)}`);
    return null;
  }
}
