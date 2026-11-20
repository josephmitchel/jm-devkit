import type { RunKind } from './db/schema.js';
import { projectFault, type Side } from './failure-side.js';
import { RUN_STAGES } from './runs.js';
import { ANSWER_AUTHORITY } from './stages/answers.js';

/**
 * The failure issue: what it says and when it is opened, commented on and closed. There is one
 * open failure issue per place (a project, or the kit's repository) and kind of run. It is not a
 * ticket, so it carries no labels.
 */

/** What a report says about the run it is for. */
export interface RunFacts {
  kind: string;
  stage: string | null;
  errorType: string | null;
  kitCommit: string | null;
  /** When the run ended, as `Date.toISOString` writes it. */
  time: string;
  runId: string;
}

/** What one place is told about a finished run. Only a failure on the project's side carries output. */
export type Report =
  | { outcome: 'failed'; side: 'project'; facts: RunFacts; tail: string }
  | { outcome: 'failed'; side: 'kit'; facts: RunFacts }
  | { outcome: 'succeeded'; side: Side; facts: RunFacts };

/** An open issue in the place a report is for, as GitHub lists it. */
export interface OpenIssue {
  number: number;
  body: string;
  /** GitHub's type of the account that opened it: `Bot` for an App, `User` for a person. */
  authorType: string;
  authorAssociation: string;
}

export type IssueAction =
  | { action: 'open'; title: string; body: string }
  | { action: 'comment'; issue: number; body: string }
  /** Comment, then close. */
  | { action: 'close'; issue: number; body: string };

// Each kind of run in words that follow "A" and "The code reviewer's". A new kind adds its words here.
const KIND_WORDS: Record<RunKind, string> = {
  nightly: 'nightly run',
  sweep: 'sweep',
  summary: 'nightly summary',
  checks: 'run of the nightly checks',
  landed: 'landed run',
};

// A type of error is shown by name only when it is on this list, is a project's fault (see
// failure-side.ts) or is in one of the fixed forms a run's result is recorded in. A new error class of the code
// reviewer's is added here to be shown by name.
const KNOWN_ERROR_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'ZodError',
  'DrizzleError',
  'DrizzleQueryError',
  'GitHubError',
]);
const FIXED_ERROR_FORM = /^(?:exit \d{1,3}|killed by SIG[A-Z0-9]{2,8}|could not start|time limit)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const RUN_ID = /^run-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const NOT_RECOGNISED = 'not recognised';

/** The facts in the forms the code reviewer writes them. Each is one of a fixed set of words or matches a fixed pattern. */
interface CheckedFacts {
  kind: RunKind;
  stage: string;
  errorType: string;
  kitCommit: string;
  time: string;
  runId: string;
}

/**
 * The only way anything from a run reaches an issue in the kit's repository, which may be public
 * while the run's project is private. Nothing is filtered: a value that is not in its fixed form
 * is dropped whole, so no text a project, a path or an error message supplied can pass.
 */
function checkedFacts(facts: RunFacts): CheckedFacts {
  const text = (value: unknown, ok: (s: string) => boolean) => (typeof value === 'string' && ok(value) ? value : NOT_RECOGNISED);
  if (typeof facts.kind !== 'string' || !Object.hasOwn(KIND_WORDS, facts.kind)) {
    throw new Error('the report names a kind of run the code reviewer does not know');
  }
  return {
    kind: facts.kind as RunKind,
    stage: text(facts.stage, (s) => RUN_STAGES.has(s)),
    errorType: text(facts.errorType, (s) => KNOWN_ERROR_TYPES.has(s) || FIXED_ERROR_FORM.test(s) || projectFault(s) !== null),
    kitCommit: text(facts.kitCommit, (s) => COMMIT.test(s)),
    time: text(facts.time, (s) => TIME.test(s)),
    runId: text(facts.runId, (s) => RUN_ID.test(s)),
  };
}

/** The first line of a failure issue's body, which is how the issue is found again. */
function marker(side: Side, kind: RunKind): string {
  return `<!-- code-reviewer:failure side=${side} kind=${kind} -->`;
}

function factLines(facts: CheckedFacts): string {
  return [
    `- Kind of run: ${facts.kind}`,
    `- Stage: \`${facts.stage}\``,
    `- Type of error: \`${facts.errorType}\``,
    `- Kit commit: ${facts.kitCommit}`,
    `- Time: ${facts.time}`,
    `- Run id: \`${facts.runId}\``,
  ].join('\n');
}

function whereTheOutputIs(facts: CheckedFacts): string {
  return (
    `The run's full output is on the machine, in \`runs/${facts.runId}.log\` under the code reviewer's ` +
    'state directory. `code-reviewer status` shows the recent runs and where their output is.'
  );
}

function notATicket(words: string): string {
  return (
    `A further failed ${words} is a comment here, and the code reviewer closes this issue once a ${words} ` +
    'succeeds again. This is not a ticket: it carries no kind and no status, and no pull request addresses it.'
  );
}

function closing(facts: CheckedFacts): string {
  return `Closed by the code reviewer: a ${KIND_WORDS[facts.kind]} succeeded (run \`${facts.runId}\`, ${facts.time}).`;
}

interface IssueText {
  title: string;
  body: string;
  comment: string;
}

/** Built from the checked facts alone: this is all an issue in the kit's repository can say. */
function kitSideText(facts: CheckedFacts): IssueText {
  const words = KIND_WORDS[facts.kind];
  const told = `${factLines(facts)}\n\n${whereTheOutputIs(facts)}`;
  return {
    title: `A ${words} failed on the code reviewer's side`,
    body: [
      marker('kit', facts.kind),
      `A ${words} failed for a reason on the code reviewer's side. This issue names no project and quotes no output.`,
      told,
      `${notATicket(words)} If the fault turns out to be a real one, file or relabel it as a \`bug\`.`,
    ].join('\n\n'),
    comment: `A ${words} failed again.\n\n${told}`,
  };
}

/** A code block that the text inside cannot end early. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

function projectSideText(facts: CheckedFacts, tail: string): IssueText {
  const words = KIND_WORDS[facts.kind];
  const fault = projectFault(facts.errorType) ?? 'see the output below';
  const told = [factLines(facts), `The end of the run's output:\n\n${fenced(tail)}`, whereTheOutputIs(facts)].join('\n\n');
  return {
    title: `The code reviewer's ${words} failed`,
    body: [
      marker('project', facts.kind),
      `The code reviewer's ${words} of this project failed for a reason on the project's side: ${fault}.`,
      told,
      notATicket(words),
    ].join('\n\n'),
    comment: `The code reviewer's ${words} failed again: ${fault}.\n\n${told}`,
  };
}

/**
 * Anyone can open an issue in a public repository and copy the first line, so only an issue an
 * App opened, or someone GitHub vouches for, is the code reviewer's to comment on and close.
 */
function couldBeOurs(issue: OpenIssue): boolean {
  return issue.authorType === 'Bot' || ANSWER_AUTHORITY.has(issue.authorAssociation);
}

/**
 * What to do in one place about one finished run, given the issues open there. A failure opens the
 * place's failure issue for that kind of run, or comments on the one already open. A success
 * closes it. An issue for another kind of run, or for the other side, is not touched.
 */
export function failureIssuePlan(report: Report, open: OpenIssue[]): IssueAction[] {
  const facts = checkedFacts(report.facts);
  if (report.side !== 'kit' && report.side !== 'project') throw new Error('the report names neither side');
  const first = marker(report.side, facts.kind);
  const ours = open.filter((issue) => couldBeOurs(issue) && issue.body.startsWith(first)).sort((a, b) => a.number - b.number);
  if (report.outcome === 'succeeded') {
    return ours.map((issue) => ({ action: 'close', issue: issue.number, body: closing(facts) }));
  }
  const text = report.side === 'kit' ? kitSideText(facts) : projectSideText(facts, report.tail);
  if (ours.length === 0) return [{ action: 'open', title: text.title, body: text.body }];
  return [{ action: 'comment', issue: ours[0].number, body: text.comment }];
}
