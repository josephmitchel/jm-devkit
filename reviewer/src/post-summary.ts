import { desc, eq } from 'drizzle-orm';

import { db, schema } from './db/client.js';
import { createDiscussion, getDiscussionSetup } from './github.js';
import { discussionCategory, discussionTarget, summaryPlan, type Night } from './night-summary.js';

/** A project's latest sweep and the account its synthesis left, or null before its first sweep. */
async function latestNight(slug: string): Promise<(Night & { sweepId: number }) | null> {
  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.slug, slug));
  if (!repo) return null;
  const [sweep] = await db.select().from(schema.sweeps).where(eq(schema.sweeps.repoId, repo.id)).orderBy(desc(schema.sweeps.id)).limit(1);
  if (!sweep) return null;
  const [round] = sweep.currentRoundId
    ? await db.select({ account: schema.rounds.roundSummary }).from(schema.rounds).where(eq(schema.rounds.id, sweep.currentRoundId))
    : [];
  return {
    sweepId: sweep.id,
    project: slug,
    state: sweep.state,
    summary: sweep.summary,
    account: round?.account ?? null,
    baseSha: sweep.baseSha,
    headSha: sweep.headSha,
    finishedAt: sweep.finishedAt,
    discussionUrl: sweep.discussionUrl,
  };
}

/**
 * What the `summary` command does: post the project's latest sweep as a discussion in the
 * project, unless there is nothing to post or it is already posted. Nothing is run again: the
 * post is made from what the sweep recorded.
 */
export async function postSummary(slug: string): Promise<'posted' | 'nothing to post'> {
  // Asked on every night, a quiet one included: a category that is missing stays reported until
  // it exists, and a night with nothing to post cannot pass for the fault being mended.
  const target = discussionTarget(slug, await getDiscussionSetup(slug), discussionCategory());
  const night = await latestNight(slug);
  const plan = summaryPlan(night);
  if (plan.action === 'skip') {
    console.log(`no summary posted for ${slug}: ${plan.why}`);
    return 'nothing to post';
  }
  const url = await createDiscussion(target, plan.title, plan.body);
  // Said before it is recorded, so the log has the address even if the record cannot be made.
  console.log(`posted "${plan.title}" for sweep ${night!.sweepId} of ${slug}: ${url}`);
  await db.update(schema.sweeps).set({ discussionUrl: url }).where(eq(schema.sweeps.id, night!.sweepId));
  return 'posted';
}
