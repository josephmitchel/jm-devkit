import { discussionCategory, findDiscussionCategory, missingDiscussionCategory } from '../../plugin/discussion-category.mjs';
import type { SweepSummary } from './db/schema.js';

/** All of it is decided from what the sweep left in the database. */

export interface Night {
  /** `owner/name`, for the link to what landed. */
  project: string;
  /** Only a `done` one is posted. */
  state: string;
  summary: SweepSummary | null;
  /** The synthesis's account of the night. Null when nothing landed, so nothing was audited. */
  account: string | null;
  baseSha: string;
  headSha: string | null;
  finishedAt: Date | null;
  discussionUrl: string | null;
}

/** `timeZone` is the machine's own when left out. */
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

/** The discussion is in the project's own repository, so an issue is given by its number, which GitHub links. */
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

/** One discussion per sweep, titled with the date it finished; a night on which nothing happened posts nothing. */
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

// A night that could not be posted (no category yet) is still owed its discussion for this long.
const CAUGHT_UP_FOR_MS = 7 * 24 * 60 * 60 * 1000;

export type SummaryPlans<N extends Night> =
  | { action: 'skip'; why: string }
  | { action: 'post'; posts: Array<{ night: N; title: string; body: string }> };

/**
 * Every sweep that finished in the last seven days, has something to say and has no discussion yet,
 * oldest first. `nights` are the project's sweeps, the latest last; with nothing to post, the
 * reason given is the latest one's.
 */
export function summaryPlans<N extends Night>(nights: N[], now: Date, timeZone?: string): SummaryPlans<N> {
  const recent = (night: N) => night.finishedAt !== null && now.getTime() - night.finishedAt.getTime() <= CAUGHT_UP_FOR_MS;
  const posts = nights
    .filter(recent)
    .sort((a, b) => a.finishedAt!.getTime() - b.finishedAt!.getTime())
    .flatMap((night) => {
      const plan = summaryPlan(night, timeZone);
      return plan.action === 'post' ? [{ night, title: plan.title, body: plan.body }] : [];
    });
  if (posts.length > 0) return { action: 'post', posts };
  const latest = summaryPlan(nights.at(-1) ?? null, timeZone);
  return { action: 'skip', why: latest.action === 'skip' ? latest.why : 'the latest sweep finished more than seven days ago' };
}

// The category's name, the matching and the owner's instructions are in the plugin, where
// install's check reads them too.
export { discussionCategory };

export interface DiscussionSetup {
  repositoryId: string;
  enabled: boolean;
  categories: Array<{ id: string; name: string }>;
}

/** Its message is what the owner reads in the project's failure issue, so it says what to create and where. */
export class MissingDiscussionCategoryError extends Error {
  constructor(project: string, category: string, enabled: boolean) {
    super(missingDiscussionCategory(project, category, enabled));
    this.name = 'MissingDiscussionCategoryError';
  }
}

export function discussionTarget(project: string, setup: DiscussionSetup, category: string): { repositoryId: string; categoryId: string } {
  const found = findDiscussionCategory(setup, category);
  if (!found) throw new MissingDiscussionCategoryError(project, category.trim(), setup.enabled);
  return { repositoryId: setup.repositoryId, categoryId: found.id };
}
