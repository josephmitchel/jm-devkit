import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';

import { db, schema } from './db/client.js';
import { failureIssuePlan, type Report, type RunFacts } from './failure-issue.js';
import { failureSide } from './failure-side.js';
import { createIssue, listOpenIssuesWithAuthors, postComment, updateIssue } from './github.js';
import { why } from './log.js';
import { howEnded } from './run-vocabulary.js';
import { runLog, runOutputPath, type Run } from './runs.js';
import { TEST_DATABASES_SETTING, withoutTestDatabaseAddresses } from './test-databases.js';
import { reviewerRoot } from './workspace.js';

/**
 * Call {@link reportRun} with every run once it has been recorded as finished; nothing else decides
 * where a failure goes.
 */

/** The place is a project or the kit's repository, as `owner/name`. */
export interface ReportForPlace {
  place: string;
  report: Report;
}

/** What the machine knows about a run that is being reported, beyond its row. */
export interface RunContext {
  /** Where failures on the code reviewer's side go. */
  kitRepository: string;
  kitCommit: string | null;
  /** Only a failure on the project's side sends it anywhere. */
  tail: string;
  /** The runs this one was made of: each project's run, for a nightly run. */
  parts: Run[];
}

// The setting for the kit's own repository. The kit may name itself; it never names a project.
const KIT_REPO_VAR = 'REVIEWER_KIT_REPO';
const KIT_REPO = 'josephmitchel/jm-devkit';

export function kitRepository(env: NodeJS.ProcessEnv = process.env): string {
  const slug = env[KIT_REPO_VAR]?.trim() || KIT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error(`${KIT_REPO_VAR} must be the kit's repository as owner/name`);
  return slug;
}

const TAIL_LINES = 40;
const TAIL_CHARS = 4000;

/**
 * The one place a run's output is made ready to leave the machine, so the addresses of its test
 * databases are taken out here, before the cut: a cut through an address would leave part of it.
 */
export function outputTail(output: string, testDatabaseServer: string | undefined = process.env[TEST_DATABASES_SETTING]): string {
  const safe = withoutTestDatabaseAddresses(output, testDatabaseServer);
  const tail = safe.trimEnd().split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS);
  return tail.trim() === '' ? '(the run wrote no output)' : tail;
}

/**
 * A run that failed with no error of its own failed only because a part of it did, and each part is
 * reported on its own. A run its time limit stopped is a failure on the code reviewer's side. A run
 * interrupted any other way, or still running, is neither: it opens nothing and closes nothing.
 */
function ownOutcome(run: Run): 'succeeded' | 'failed' | null {
  if (run.state === 'succeeded') return 'succeeded';
  if (run.state === 'failed') return run.errorType === null ? 'succeeded' : 'failed';
  if (run.state === 'interrupted' && run.errorType === 'time limit') return 'failed';
  return null;
}

/**
 * A failure goes to one place: the project when the fault is the project's, the kit's repository
 * otherwise, and only the first carries output. A success goes to both, so either's failure issue
 * for that kind of run is closed.
 *
 * A run that is part of another leaves the kit's repository to that run, which says a kind of run
 * succeeded only when one did and none failed on the code reviewer's side. Otherwise one project's
 * success would close the issue another project's failure had just commented on.
 */
export function reportsFor(run: Run, context: RunContext): ReportForPlace[] {
  const outcome = ownOutcome(run);
  if (outcome === null) return [];
  const facts = (kind: string): RunFacts => ({
    kind,
    stage: run.stage,
    errorType: run.errorType,
    kitCommit: context.kitCommit,
    time: (run.finishedAt ?? run.startedAt).toISOString(),
    runId: run.id,
  });
  if (outcome === 'failed') {
    return run.project !== null && failureSide(run.errorType) === 'project'
      ? [{ place: run.project, report: { outcome, side: 'project', facts: facts(run.kind), tail: context.tail } }]
      : [{ place: context.kitRepository, report: { outcome, side: 'kit', facts: facts(run.kind) } }];
  }
  const succeededOnKitSide = (kind: string): ReportForPlace => ({ place: context.kitRepository, report: { outcome, side: 'kit', facts: facts(kind) } });
  const settled = [...new Set(context.parts.map((p) => p.kind))].filter((kind) => {
    const ofKind = context.parts.filter((p) => p.kind === kind);
    const failedOnKitSide = ofKind.some((p) => ownOutcome(p) === 'failed' && failureSide(p.errorType) === 'kit');
    return !failedOnKitSide && ofKind.some((p) => p.state === 'succeeded');
  });
  return [
    ...(run.project === null ? [] : [{ place: run.project, report: { outcome, side: 'project' as const, facts: facts(run.kind) } }]),
    ...(run.parentId === null ? [succeededOnKitSide(run.kind)] : []),
    ...settled.map(succeededOnKitSide),
  ];
}

export function parseReport(text: string): Report {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const report = value as Partial<Report & { tail: unknown }> | null;
  const ok =
    typeof report === 'object' &&
    report !== null &&
    (report.outcome === 'failed' || report.outcome === 'succeeded') &&
    (report.side === 'project' || report.side === 'kit') &&
    typeof report.facts === 'object' &&
    report.facts !== null &&
    typeof report.facts.kind === 'string' &&
    (!(report.outcome === 'failed' && report.side === 'project') || typeof report.tail === 'string');
  if (!ok) throw new Error('the input is not a report of a finished run');
  return report as Report;
}

/** Returns a line for each thing done. */
export async function fileReport(place: string, report: Report): Promise<string[]> {
  const done: string[] = [];
  for (const step of failureIssuePlan(report, await listOpenIssuesWithAuthors(place))) {
    if (step.action === 'open') {
      const issue = await createIssue(place, { title: step.title, body: step.body, labels: [] });
      done.push(`opened failure issue #${issue.number} in ${place}`);
      continue;
    }
    await postComment(place, step.issue, step.body);
    if (step.action === 'close') await updateIssue(place, step.issue, { state: 'closed', stateReason: 'completed' });
    done.push(`${step.action === 'close' ? 'closed' : 'commented on'} failure issue #${step.issue} in ${place}`);
  }
  return done;
}

const SEND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * A process of its own: App auth is one repository per process, and the kit's repository is not the
 * project's. It is given the report and nothing else about the run.
 */
function sendReport(place: string, report: Report): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const { REVIEWER_RUN_ID: _run, ...env } = process.env;
    const child = spawn(process.execPath, ['--import', 'tsx/esm', path.join(reviewerRoot, 'src/cli.ts'), 'failure-issue', place], {
      cwd: reviewerRoot,
      env: { ...env, REVIEWER_APP_INSTALL_REPO: place },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SEND_TIMEOUT_MS,
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      if (exitCode === 0) return resolve(out.split('\n').filter((line) => line.trim() !== ''));
      const said = err.trim().split('\n').slice(-3).join(' | ');
      reject(new Error(`${howEnded(exitCode, signal)}${said ? `: ${said}` : ''}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(report));
  });
}

/** Replaced in tests. */
export interface Reporter {
  kitRepository(): string;
  kitCommit(): string | null;
  tail(run: Run): string;
  parts(run: Run): Promise<Run[]>;
  send(place: string, report: Report): Promise<string[]>;
}

const onTheMachine: Reporter = {
  kitRepository,
  kitCommit() {
    try {
      return execFileSync('git', ['-C', reviewerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  },
  tail(run) {
    try {
      return outputTail(fs.readFileSync(runOutputPath(run.id), 'utf8'));
    } catch {
      return outputTail('');
    }
  },
  parts: (run) => db.select().from(schema.runs).where(eq(schema.runs.parentId, run.id)).orderBy(schema.runs.startedAt),
  send: sendReport,
};

/**
 * The one function to call with a finished run, whatever started it. It never throws and never
 * changes the run: a report that cannot be made is a line in the log. `say` is that log; left out,
 * the lines go to the run's own output file.
 */
export async function reportRun(run: Run, say?: (line: string) => void, reporter: Reporter = onTheMachine): Promise<void> {
  const note = (line: string) => {
    try {
      (say ??= runLog(run))(`${run.id}: ${line}`);
    } catch {
      // Nothing left to tell it to.
    }
  };
  const outcome = ownOutcome(run);
  if (outcome === null) return;
  let reports: ReportForPlace[];
  try {
    reports = reportsFor(run, {
      kitRepository: reporter.kitRepository(),
      kitCommit: reporter.kitCommit(),
      tail: outcome === 'failed' ? reporter.tail(run) : '',
      parts: await reporter.parts(run),
    });
  } catch (err) {
    note(`could not report that it ${outcome}: ${why(err)}`);
    return;
  }
  for (const { place, report } of reports) {
    try {
      for (const line of await reporter.send(place, report)) note(line);
    } catch (err) {
      note(`could not report that it ${report.outcome} to ${place}: ${why(err)}`);
    }
  }
}
