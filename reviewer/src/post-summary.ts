import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import { db, schema } from './db/client.js';
import { createDiscussion, getDiscussionSetup } from './github.js';
import { discussionCategory, discussionTarget, summaryPlans, type Night } from './night-summary.js';

type Sweep = typeof schema.sweeps.$inferSelect;

/**
 * A project's sweeps that finished since `since`, and its latest whenever that was, in the order
 * they were made, each with the account its synthesis left.
 */
async function nightsSince(slug: string, since: Date): Promise<Array<Night & { sweepId: number }>> {
  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.slug, slug));
  if (!repo) return [];
  const ofProject = eq(schema.sweeps.repoId, repo.id);
  const latest = await db.select().from(schema.sweeps).where(ofProject).orderBy(desc(schema.sweeps.id)).limit(1);
  const finished = await db.select().from(schema.sweeps).where(and(ofProject, gte(schema.sweeps.finishedAt, since)));
  const sweeps = [...new Map<number, Sweep>([...finished, ...latest].map((s) => [s.id, s])).values()].sort((a, b) => a.id - b.id);
  const rounds = sweeps.flatMap((s) => (s.currentRoundId === null ? [] : [s.currentRoundId]));
  const accounts =
    rounds.length === 0
      ? []
      : await db.select({ id: schema.rounds.id, account: schema.rounds.roundSummary }).from(schema.rounds).where(inArray(schema.rounds.id, rounds));
  return sweeps.map((sweep) => ({
    sweepId: sweep.id,
    project: slug,
    state: sweep.state,
    summary: sweep.summary,
    account: accounts.find((r) => r.id === sweep.currentRoundId)?.account ?? null,
    baseSha: sweep.baseSha,
    headSha: sweep.headSha,
    finishedAt: sweep.finishedAt,
    discussionUrl: sweep.discussionUrl,
  }));
}

// A little more than the rule looks back, so the query never cuts a night the rule would post.
const LOOKS_BACK_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * What the `summary` command does: post each of the project's recent sweeps that is owed a
 * discussion (summaryPlans), oldest first. Nothing is run again: a post is made from what its
 * sweep recorded, and recorded on that sweep, so it is made once.
 */
export async function postSummary(slug: string): Promise<'posted' | 'nothing to post'> {
  // Asked on every night, a quiet one included: a category that is missing stays reported until
  // it exists, and a night with nothing to post cannot pass for the fault being mended.
  const target = discussionTarget(slug, await getDiscussionSetup(slug), discussionCategory());
  const now = new Date();
  const plan = summaryPlans(await nightsSince(slug, new Date(now.getTime() - LOOKS_BACK_MS)), now);
  if (plan.action === 'skip') {
    console.log(`no summary posted for ${slug}: ${plan.why}`);
    return 'nothing to post';
  }
  for (const { night, title, body } of plan.posts) {
    const url = await createDiscussion(target, title, body);
    // Said before it is recorded, so the log has the address even if the record cannot be made.
    console.log(`posted "${title}" for sweep ${night.sweepId} of ${slug}: ${url}`);
    await db.update(schema.sweeps).set({ discussionUrl: url }).where(eq(schema.sweeps.id, night.sweepId));
  }
  return 'posted';
}
