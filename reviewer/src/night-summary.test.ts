import { describe, expect, it } from 'vitest';

import type { SweepSummary } from './db/schema.js';
import { failureSide } from './failure-side.js';
import {
  discussionCategory,
  discussionTarget,
  MissingDiscussionCategoryError,
  summaryPlan,
  summaryTitle,
  type DiscussionSetup,
  type Night,
} from './night-summary.js';
import { errorType } from './runs.js';

const nothing: SweepSummary = { judged: [], tickets: [], answered: 0, opened: [], closedByAudit: [], commits: 0 };
const night = (over: Partial<Night> = {}): Night => ({
  project: 'acme/widgets',
  summary: nothing,
  account: null,
  state: 'done',
  baseSha: 'a'.repeat(40),
  headSha: 'a'.repeat(40),
  finishedAt: new Date('2026-11-20T09:15:02Z'),
  discussionUrl: null,
  ...over,
});

describe("the title of a night's discussion", () => {
  it("is the date the sweep finished, on the machine's own calendar", () => {
    const finished = new Date('2026-11-20T03:15:02Z');
    expect(summaryTitle(finished, 'UTC')).toBe('Nightly summary, 2026-11-20');
    expect(summaryTitle(finished, 'America/Chicago')).toBe('Nightly summary, 2026-11-19');
    expect(summaryTitle(finished, 'Pacific/Auckland')).toBe('Nightly summary, 2026-11-20');
  });
});

describe('whether a night is posted', () => {
  it('posts nothing when nothing landed, nothing was judged and no decision was settled', () => {
    const quiet = { action: 'skip', why: 'nothing landed, nothing was judged and no decision was settled' };
    expect(summaryPlan(night())).toEqual(quiet);
    expect(summaryPlan(night({ summary: null }))).toEqual(quiet);
  });

  const landed = { headSha: 'b'.repeat(40), summary: { ...nothing, commits: 3 } };
  const ACCOUNT = 'Three commits landed. The transfer form could save a payment twice if double-clicked.';

  it('posts a night on which something landed, titled with its date and opening with the account of the night', () => {
    const plan = summaryPlan(night({ ...landed, account: `${ACCOUNT}\n` }), 'UTC');
    expect(plan).toMatchObject({ action: 'post', title: 'Nightly summary, 2026-11-20' });
    expect(plan.action === 'post' && plan.body.startsWith(`${ACCOUNT}\n`)).toBe(true);
  });

  it('posts a night on which nothing landed but a ticket was judged', () => {
    const judged = { ...nothing, tickets: [{ issueNumber: 21, title: 'Export fails on empty lists', verdict: 'solved' as const, prNumbers: [30] }] };
    expect(summaryPlan(night({ summary: judged }))).toMatchObject({ action: 'post' });
  });

  it("posts a night on which nothing landed but one of the owner's decisions was settled", () => {
    const dismissedConcern = { ...nothing, judged: [{ slug: 'double-save', issueNumber: 14, verdict: 'dismissed' as const, note: 'by design' }] };
    const dismissedTicket = { ...nothing, tickets: [{ issueNumber: 15, title: 'Dark mode', verdict: 'dismissed' as const, prNumbers: [] }] };
    expect(summaryPlan(night({ summary: dismissedConcern }))).toMatchObject({ action: 'post' });
    expect(summaryPlan(night({ summary: dismissedTicket }))).toMatchObject({ action: 'post' });
  });

  it('posts nothing for a night whose only event was an answer being recorded', () => {
    expect(summaryPlan(night({ summary: { ...nothing, answered: 2 } }))).toMatchObject({ action: 'skip' });
  });

  it('posts nothing for a sweep that did not finish, whatever it had done by then', () => {
    const failed = night({ ...landed, account: ACCOUNT, state: 'failed', finishedAt: null });
    expect(summaryPlan(failed)).toEqual({ action: 'skip', why: 'the latest sweep did not finish (it is failed)' });
    expect(summaryPlan(null)).toEqual({ action: 'skip', why: 'the project has no sweep yet' });
  });

  it('posts nothing for a sweep whose summary is already posted', () => {
    const url = 'https://github.com/acme/widgets/discussions/7';
    expect(summaryPlan(night({ ...landed, account: ACCOUNT, discussionUrl: url }))).toEqual({ action: 'skip', why: `already posted: ${url}` });
  });
});

describe("what a night's discussion says", () => {
  const BASE = 'a'.repeat(40);
  const HEAD = 'b'.repeat(40);
  const full: SweepSummary = {
    commits: 3,
    opened: [
      { slug: 'double-save', issueNumber: 12, level: 'major' },
      { slug: 'slow-export', issueNumber: 13, level: 'moderate' },
    ],
    closedByAudit: [{ slug: 'stale-cache', issueNumber: 9 }],
    tickets: [
      { issueNumber: 21, title: 'Export fails on empty lists', verdict: 'solved', prNumbers: [30, 31] },
      { issueNumber: 22, title: 'Retry failed uploads', verdict: 'needs_work', prNumbers: [32] },
      { issueNumber: 23, title: 'Tidy the settings page', verdict: 'nothing_to_judge', prNumbers: [] },
      { issueNumber: 15, title: 'Dark mode', verdict: 'dismissed', prNumbers: [] },
    ],
    judged: [
      { slug: 'unbounded-list', issueNumber: 14, verdict: 'dismissed', note: 'by design' },
      { slug: 'old-logger', issueNumber: 16, verdict: 'closed', note: 'closed by hand' },
    ],
    answered: 2,
  };

  it('gives the account, then what landed, was filed, closed, judged and settled, each issue by its number', () => {
    const plan = summaryPlan(night({ summary: full, account: 'The transfer form could save a payment twice.', baseSha: BASE, headSha: HEAD }));
    expect(plan.action === 'post' && plan.body).toBe(
      [
        'The transfer form could save a payment twice.',
        '',
        '## What the sweep did',
        '',
        '- **Landed:** 3 commits, [`aaaaaaaaaa...bbbbbbbbbb`](https://github.com/acme/widgets/compare/' + BASE + '...' + HEAD + ')',
        '- **Filed:** #12 (major), #13 (moderate)',
        '- **Closed, fixed by what landed:** #9',
        '- **Judged:** #21 solved (#30, #31), #22 needs work (#32), #23 nothing to judge',
        "- **Settled on the owner's decision:** #15 dismissed, #14 dismissed, #16 closed by hand",
        '- **Answers recorded:** 2',
        '',
      ].join('\n'),
    );
  });

  it('says nothing landed, and still what was judged, on a night with no diff', () => {
    const judged = { ...nothing, tickets: [{ issueNumber: 21, title: 'Export fails on empty lists', verdict: 'solved' as const, prNumbers: [30] }] };
    const plan = summaryPlan(night({ summary: judged }));
    expect(plan.action === 'post' && plan.body).toBe(
      ['Nothing landed since the last sweep, so nothing was audited.', '', '## What the sweep did', '', '- **Judged:** #21 solved (#30)', ''].join('\n'),
    );
  });
});

describe("where a night's discussion goes", () => {
  const setup: DiscussionSetup = {
    repositoryId: 'R_1',
    enabled: true,
    categories: [
      { id: 'DIC_1', name: 'General' },
      { id: 'DIC_2', name: 'Code reviewer' },
    ],
  };
  const refusal = (given: DiscussionSetup, category = 'Code reviewer'): Error => {
    try {
      discussionTarget('acme/widgets', given, category);
    } catch (err) {
      return err as Error;
    }
    throw new Error('a place to post was found');
  };

  it("is the project's category of the configured name, however it is capitalised", () => {
    expect(discussionTarget('acme/widgets', setup, 'Code reviewer')).toEqual({ repositoryId: 'R_1', categoryId: 'DIC_2' });
    expect(discussionTarget('acme/widgets', setup, 'code Reviewer ')).toEqual({ repositoryId: 'R_1', categoryId: 'DIC_2' });
  });

  it('tells the owner to create the category when the project has none of that name', () => {
    const err = refusal({ ...setup, categories: [{ id: 'DIC_1', name: 'General' }] });
    expect(err).toBeInstanceOf(MissingDiscussionCategoryError);
    expect(err.message).toContain('acme/widgets has no discussion category named "Code reviewer"');
    expect(err.message).toContain('New category');
    expect(err.message).not.toContain('turn on Discussions');
  });

  it('tells the owner to turn discussions on and create the category when the project has discussions off', () => {
    const err = refusal({ repositoryId: 'R_1', enabled: false, categories: [] }, 'Nightly');
    expect(err).toBeInstanceOf(MissingDiscussionCategoryError);
    expect(err.message).toContain('acme/widgets has discussions turned off');
    expect(err.message).toContain('turn on Discussions');
    expect(err.message).toContain('a discussion category named "Nightly"');
  });

  it("is a failure on the project's side when there is nowhere to post", () => {
    expect(failureSide(errorType(refusal({ ...setup, categories: [] })))).toBe('project');
  });

  it('takes the name of the category from a setting, and is named for the code reviewer without one', () => {
    expect(discussionCategory({})).toBe('Code reviewer');
    expect(discussionCategory({ REVIEWER_DISCUSSION_CATEGORY: '  ' })).toBe('Code reviewer');
    expect(discussionCategory({ REVIEWER_DISCUSSION_CATEGORY: 'Nightly' })).toBe('Nightly');
  });
});
