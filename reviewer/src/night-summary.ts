import type { SweepSummary } from './db/schema.js';

/**
 * A night's summary: whether a project's latest sweep is posted as a discussion in the project,
 * and what the discussion says. All of it is decided from what the sweep left in the database.
 */

/** A project's latest sweep, as its row and its round's hold it. */
export interface Night {
  /** `owner/name`, for the link to what landed. */
  project: string;
  /** The sweep's state; only a `done` one is posted. */
  state: string;
  summary: SweepSummary | null;
  /** The synthesis's account of the night. Null when nothing landed, so nothing was audited. */
  account: string | null;
  baseSha: string;
  headSha: string | null;
  finishedAt: Date | null;
  /** The discussion this sweep was already posted as. */
  discussionUrl: string | null;
}

/** The calendar date of a moment where the machine is; `timeZone` is the machine's own when left out. */
function localDate(at: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function summaryTitle(finishedAt: Date, timeZone?: string): string {
  return `Nightly summary, ${localDate(finishedAt, timeZone)}`;
}

export type SummaryPlan = { action: 'skip'; why: string } | { action: 'post'; title: string; body: string };

const VERDICT_WORDS: Record<string, string> = { needs_work: 'needs work', nothing_to_judge: 'nothing to judge', closed: 'closed by hand' };
const verdict = (v: string) => VERDICT_WORDS[v] ?? v;

/**
 * What the sweep did, one line per kind of thing. The discussion is in the project's own
 * repository, so an issue is given by its number, which GitHub links.
 */
function factLines(night: Night, landed: boolean): string[] {
  const summary: SweepSummary = { judged: [], answered: 0, opened: [], closedByAudit: [], commits: 0, ...night.summary };
  const tickets = summary.tickets ?? [];
  const list = (items: string[]) => items.join(', ');
  const lines: string[] = [];
  if (landed) {
    const count = summary.commits > 0 ? `${summary.commits} commit${summary.commits === 1 ? '' : 's'}, ` : '';
    const range = `${night.baseSha.slice(0, 10)}...${night.headSha!.slice(0, 10)}`;
    lines.push(`- **Landed:** ${count}[\`${range}\`](https://github.com/${night.project}/compare/${night.baseSha}...${night.headSha})`);
  }
  if (summary.opened.length > 0) lines.push(`- **Filed:** ${list(summary.opened.map((o) => `#${o.issueNumber} (${o.level})`))}`);
  if (summary.closedByAudit.length > 0) {
    lines.push(`- **Closed, fixed by what landed:** ${list(summary.closedByAudit.map((c) => `#${c.issueNumber}`))}`);
  }
  const judged = tickets.filter((t) => t.verdict !== 'dismissed');
  if (judged.length > 0) {
    const prs = (numbers: number[]) => (numbers.length > 0 ? ` (${list(numbers.map((n) => `#${n}`))})` : '');
    lines.push(`- **Judged:** ${list(judged.map((t) => `#${t.issueNumber} ${verdict(t.verdict)}${prs(t.prNumbers)}`))}`);
  }
  const settled = [...tickets.filter((t) => t.verdict === 'dismissed'), ...summary.judged];
  if (settled.length > 0) {
    lines.push(`- **Settled on the owner's decision:** ${list(settled.map((d) => `#${d.issueNumber} ${verdict(d.verdict)}`))}`);
  }
  if (summary.answered > 0) lines.push(`- **Answers recorded:** ${summary.answered}`);
  return lines;
}

/**
 * Whether a project's latest sweep is posted, and as what. One discussion per sweep, titled with
 * the date it finished; a night on which nothing happened posts nothing.
 */
export function summaryPlan(night: Night | null, timeZone?: string): SummaryPlan {
  const skip = (why: string): SummaryPlan => ({ action: 'skip', why });
  if (night === null) return skip('the project has no sweep yet');
  if (night.state !== 'done' || night.finishedAt === null) return skip(`the latest sweep did not finish (it is ${night.state})`);
  if (night.discussionUrl !== null) return skip(`already posted: ${night.discussionUrl}`);
  const landed = night.headSha !== null && night.headSha !== night.baseSha;
  // Every entry in either list is a ticket judged or one of the owner's decisions settled.
  const decided = (night.summary?.judged.length ?? 0) + (night.summary?.tickets?.length ?? 0);
  if (!landed && decided === 0) return skip('nothing landed, nothing was judged and no decision was settled');
  const account = night.account?.trim() || (landed ? '' : 'Nothing landed since the last sweep, so nothing was audited.');
  const body = [...(account ? [account, ''] : []), '## What the sweep did', '', ...factLines(night, landed), ''].join('\n');
  return { action: 'post', title: summaryTitle(night.finishedAt, timeZone), body };
}

const CATEGORY_VAR = 'REVIEWER_DISCUSSION_CATEGORY';
const CATEGORY = 'Code reviewer';

/** The name of the discussion category a night's summary is posted in. */
export function discussionCategory(env: NodeJS.ProcessEnv = process.env): string {
  return env[CATEGORY_VAR]?.trim() || CATEGORY;
}

/** What GitHub says about a project's discussions. */
export interface DiscussionSetup {
  repositoryId: string;
  enabled: boolean;
  categories: Array<{ id: string; name: string }>;
}

/**
 * The project has discussions off, or no category of the configured name. Its message is what
 * the owner reads in the project's failure issue, so it says what to create and where.
 */
export class MissingDiscussionCategoryError extends Error {
  constructor(project: string, category: string, enabled: boolean) {
    const create =
      `a discussion category named "${category}" (the project's Discussions tab, the pencil beside ` +
      'Categories, New category; format: Open-ended discussion)';
    super(
      (enabled
        ? `${project} has no discussion category named "${category}". Create ${create}.`
        : `${project} has discussions turned off. In the project's settings on GitHub, turn on Discussions ` +
          `(Settings, General, Features), then create ${create}.`) +
        " The code reviewer posts each night's summary there. It cannot create the category: GitHub's API has no call for it.",
    );
    this.name = 'MissingDiscussionCategoryError';
  }
}

/** The ids GitHub needs to create a discussion in the project's category of that name. */
export function discussionTarget(project: string, setup: DiscussionSetup, category: string): { repositoryId: string; categoryId: string } {
  const wanted = category.trim().toLowerCase();
  const found = setup.enabled ? setup.categories.find((c) => c.name.trim().toLowerCase() === wanted) : undefined;
  if (!found) throw new MissingDiscussionCategoryError(project, category.trim(), setup.enabled);
  return { repositoryId: setup.repositoryId, categoryId: found.id };
}
