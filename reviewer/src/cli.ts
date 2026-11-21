import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { db, pool, schema } from './db/client.js';
import { fileReport, parseReport } from './failure-report.js';
import { configureAppAuth } from './gh-auth.js';
import { gitCredential } from './git-credential.js';
import { startHeartbeat } from './heartbeat.js';
import { printRaw, timestampConsole } from './log.js';
import { dispatchWorkflow, getDefaultBranch, getPr, listOpenPrNumbers } from './github.js';
import { carryGate } from './stages/carry-gate.js';
import { ACTIVE_WORK_STATES, resolveSlot } from './stages/intake.js';
import { markGate, progressStep } from './stages/progress.js';
import { postSummary } from './post-summary.js';
import { postFailureNotice } from './stages/report.js';
import { runMigrations } from './migrate.js';
import { recordNightlyNotStarted, runNightly } from './nightly.js';
import { runChecksOnDemand, runProjectChecks } from './nightly-checks.js';
import { EVENT_RUN_KINDS, pollerStatus } from './poller.js';
import { forgetReviewEvents, pollerStatusRows, runPass } from './poller-pass.js';
import { queueStatus } from './queue.js';
import { queueStatusFacts, runQueueTurn } from './queue-run.js';
import { listProjects, projectLine } from './projects.js';
import { runReview } from './review-loop.js';
import { cloneUrl } from './project-row.js';
import { errorTypeLine, nightlyStatus, otherRunsStatus, recentNightlyRuns, recentRunsOnTheirOwn, stopCommandsOnSignal } from './runs.js';
import { runSweep } from './sweep/loop.js';
import { runLanded } from './landed.js';
import { dropTestDatabases } from './test-databases.js';
import { syncLabels } from './sweep/labels.js';

const USAGE = `code-reviewer — standalone multi-agent PR review service

Usage:
  code-reviewer run <owner/repo> <pr#> [--once] run (or resume) the review loop for a PR
      --once                                    return instead of waiting for answers or the
                                                review slot (for CI; prints the outcome)
  code-reviewer sweep <owner/repo>              run (or resume) tonight's sweep: judge closed
                                                issues, audit what landed on the default branch,
                                                file concerns as issues (never fixes, never gates)
  code-reviewer summary <owner/repo>            post the project's latest sweep as a dated
                                                discussion in the project, once, and any from the
                                                last seven days that could not be posted; a night
                                                on which nothing happened posts nothing
  code-reviewer checks <owner/repo>             run the project's nightly checks (nightly.checks in
                                                its devkit.json) now, in a fresh checkout of its
                                                default branch; recorded and reported as the
                                                nightly run's step is, and exits 1 when one fails
                                                or when the project's checks are already running
  code-reviewer nightly                         the whole nightly run: for every project the
                                                machine handles, in name order, one at a time, its
                                                sweep, its summary and then its nightly checks if
                                                it names any; a step that fails does not stop the
                                                next, and a sweep that runs past five and a half
                                                hours is stopped and resumed the next night; it
                                                waits for a review that is running, and no review
                                                starts until it is over
  code-reviewer nightly-not-started <stage> <error type>
                                                record a nightly run that could not start; the
                                                machine's update step (bin/update.mjs) calls it
  code-reviewer poll                            one pass of the poller: for every project the
                                                machine handles, run landed for each pull request
                                                merged since the last pass and carry-gate for each
                                                new head of one whose review passed, and queue
                                                the review of each one labelled review-now or
                                                answered by the owner (a timer runs this every
                                                few minutes)
  code-reviewer queue                           one turn of the queue: start the next queued
                                                review if no agent job is running on the machine
                                                and see it through (the machine runs this after
                                                every pass of the poller)
  code-reviewer failure-issue <owner/repo>      open, comment on or close that repository's failure
                                                issue, from the report of a finished run on its
                                                input (the nightly run starts this; not for hand use)
  code-reviewer landed <owner/repo> <pr#>       a PR merged: label the tickets it addresses
                                                needs-judging and lift their blocking edges
  code-reviewer labels <owner/repo>             bring the repo's labels in line with the ticket
                                                label scheme: rename retired names, set colours
  code-reviewer projects                        list every project the App is installed on and
                                                whether the machine handles it
  code-reviewer migrate                        apply pending migrations (advisory-locked)
  code-reviewer next <owner/repo>               print the PR number of the next queued review
  code-reviewer abandon <owner/repo> <pr#> [why]  record that a run ended mid-stage (CI cleanup)
  code-reviewer carry-gate <owner/repo> <pr#>   gate a passed PR's new head if it holds reviewed code
  code-reviewer git-credential get              git credential helper (minted App token)
  code-reviewer repo add <owner/repo> [opts]    register a repo
      --setup <cmd>                             setup command (e.g. "npm ci")
      --tests <name=cmd>                        test suite (repeatable)
      --harness-notes-file <path>               per-repo notes for the testing auditor
      --redundancy <n>                          auditors per characteristic (default 1)
  code-reviewer repo set <owner/repo> [opts]    update repo config (same options)
  code-reviewer status [owner/repo]             show reviews and their states, the recent
                                                nightly runs with each project's result, the
                                                recent runs started by hand, what
                                                the poller's last passes found, and the queue:
                                                the agent job running and the reviews waiting
  code-reviewer reset <owner/repo> <pr#>        delete a review's state (concerns/policies kept)
`;

// The commands CI runs unattended. The admin ones print tables and confirmations for a person at
// a terminal, where a timestamp on every line is only noise.
const STAMPED = new Set(['run', 'sweep', 'summary', 'checks', 'nightly', 'nightly-not-started', 'poll', 'queue', 'landed', 'migrate', 'next', 'abandon', 'carry-gate']);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd && STAMPED.has(cmd)) timestampConsole();
  switch (cmd) {
    case 'run': {
      const flags = rest.filter((a) => a.startsWith('--'));
      const [slug, pr] = rest.filter((a) => !a.startsWith('--'));
      if (!slug || !/^\d+$/.test(pr ?? '') || flags.some((f) => f !== '--once')) return usageExit();
      configureAppAuth(slug);
      const stopHeartbeat = startHeartbeat();
      let outcome;
      try {
        outcome = await runReview(slug, Number(pr), { oneShot: flags.includes('--once') });
      } finally {
        stopHeartbeat();
      }
      // Anything that re-enters a passed review (a comment on its PR, say) is also a chance to carry
      // its gate onto a head that has since moved to already-reviewed code. Never fatal: it passed.
      if (outcome === 'passed') {
        await carryGate(slug, Number(pr)).catch((err) => {
          console.warn(`could not check for a gate to carry (${String(err).split('\n')[0]})`);
        });
      }
      printRaw(`outcome: ${outcome}`);
      // The slot just freed, so wake whatever was queued behind this review rather than making
      // it wait for the scheduled sweep. A review that threw is covered by the sweep instead.
      const dispatch = process.env.REVIEWER_DISPATCH_WORKFLOW;
      if (outcome === 'passed' && dispatch) await handOffToQueue(slug, dispatch);
      break;
    }
    case 'sweep': {
      const [slug, ...extra] = rest;
      if (!slug || extra.length > 0) return usageExit();
      configureAppAuth(slug);
      const stopHeartbeat = startHeartbeat();
      try {
        printRaw(`outcome: ${await runSweep(slug)}`);
      } finally {
        stopHeartbeat();
      }
      break;
    }
    case 'summary': {
      const [slug, ...extra] = rest;
      if (!slug || extra.length > 0) return usageExit();
      configureAppAuth(slug);
      printRaw(`outcome: ${await postSummary(slug)}`);
      break;
    }
    case 'nightly': {
      if (rest.length > 0) return usageExit();
      stopCommandsOnSignal();
      const outcome = await runNightly();
      printRaw(`outcome: ${outcome}`);
      if (outcome !== 'succeeded' && outcome !== 'not started') process.exitCode = 1;
      break;
    }
    case 'nightly-not-started': {
      const [stage, type, ...extra] = rest;
      if (!stage || !type || extra.length > 0 || !(await recordNightlyNotStarted(stage, type))) return usageExit();
      break;
    }
    case 'checks': {
      const [slug, ...extra] = rest;
      if (!slug || extra.length > 0) return usageExit();
      configureAppAuth(slug);
      // Under a run id this is the work of a run already recorded: the nightly run's step, or the
      // one this command records for itself when a person runs it.
      if (process.env.REVIEWER_RUN_ID) {
        const stopHeartbeat = startHeartbeat();
        try {
          await runProjectChecks(slug);
        } finally {
          stopHeartbeat();
        }
        break;
      }
      stopCommandsOnSignal();
      const outcome = await runChecksOnDemand(slug);
      printRaw(`outcome: ${outcome}`);
      if (outcome !== 'succeeded' && outcome !== 'no checks') process.exitCode = 1;
      break;
    }
    case 'poll': {
      if (rest.length > 0) return usageExit();
      // A pass told to stop stops the command it is on and records it, as the nightly run does.
      stopCommandsOnSignal();
      if ((await runPass()) === 'failed') process.exitCode = 1;
      break;
    }
    case 'queue': {
      if (rest.length > 0) return usageExit();
      // A turn told to stop stops the review it is on, which is then recorded as stopped.
      stopCommandsOnSignal();
      const outcome = await runQueueTurn();
      if (outcome === 'failed' || outcome === 'interrupted') process.exitCode = 1;
      break;
    }
    case 'failure-issue': {
      const [slug, ...extra] = rest;
      if (!slug || extra.length > 0) return usageExit();
      const report = parseReport(fs.readFileSync(0, 'utf8'));
      configureAppAuth(slug);
      for (const line of await fileReport(slug, report)) console.log(line);
      break;
    }
    case 'landed': {
      const [slug, pr] = rest;
      if (!slug || !/^\d+$/.test(pr ?? '')) return usageExit();
      configureAppAuth(slug);
      await runLanded(slug, Number(pr));
      break;
    }
    case 'labels': {
      const [slug, ...extra] = rest;
      if (!slug || extra.length > 0) return usageExit();
      configureAppAuth(slug);
      const { ops, leftBehind } = await syncLabels(slug);
      console.log(`${ops.length} label change(s)${leftBehind.length > 0 ? `, ${leftBehind.length} left to merge by hand` : ''}`);
      break;
    }
    case 'projects': {
      if (rest.length > 0) return usageExit();
      for (const project of await listProjects()) console.log(projectLine(project));
      break;
    }
    case 'migrate':
      await runMigrations();
      break;
    case 'next': {
      const [slug] = rest;
      if (!slug) return usageExit();
      configureAppAuth(slug);
      await showNextQueued(slug);
      break;
    }
    case 'abandon': {
      const [slug, pr, ...why] = rest;
      if (!slug || !/^\d+$/.test(pr ?? '')) return usageExit();
      configureAppAuth(slug);
      await abandonReview(slug, Number(pr), why.join(' ') || 'the run ended before the stage finished');
      break;
    }
    case 'carry-gate': {
      const [slug, pr] = rest;
      if (!slug || !/^\d+$/.test(pr ?? '')) return usageExit();
      configureAppAuth(slug);
      await carryGate(slug, Number(pr));
      break;
    }
    case 'git-credential': {
      const answer = await gitCredential(rest[0] ?? '', process.stdin);
      if (answer) process.stdout.write(answer);
      break;
    }
    case 'repo': {
      const [sub, slug] = rest;
      if ((sub !== 'add' && sub !== 'set') || !slug) return usageExit();
      await repoUpsert(sub, slug, rest.slice(2));
      break;
    }
    case 'status':
      await showStatus(rest[0]);
      break;
    case 'reset': {
      const [slug, pr] = rest;
      if (!slug || !/^\d+$/.test(pr ?? '')) return usageExit();
      await resetReview(slug, Number(pr));
      break;
    }
    default:
      return usageExit();
  }
}

function usageExit(): never {
  console.error(USAGE);
  process.exit(2);
}

async function repoUpsert(mode: 'add' | 'set', slug: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      setup: { type: 'string' },
      tests: { type: 'string', multiple: true },
      'harness-notes-file': { type: 'string' },
      redundancy: { type: 'string' },
      'extra-context': { type: 'string' },
    },
  });

  const testCommands = (values.tests ?? []).map((t) => {
    const idx = t.indexOf('=');
    if (idx === -1) throw new Error(`--tests expects name=command, got: ${t}`);
    return { name: t.slice(0, idx), command: t.slice(idx + 1) };
  });
  const harnessNotes = values['harness-notes-file']
    ? fs.readFileSync(values['harness-notes-file'], 'utf8').trim()
    : undefined;

  const patch: Record<string, unknown> = {};
  if (values.setup !== undefined) patch.setupCommand = values.setup;
  if (testCommands.length > 0) patch.testCommands = testCommands;
  if (harnessNotes !== undefined) patch.harnessNotes = harnessNotes;
  if (values.redundancy !== undefined) patch.redundancy = Number(values.redundancy);
  if (values['extra-context'] !== undefined) patch.extraContext = values['extra-context'];

  const [existing] = await db.select().from(schema.repos).where(eq(schema.repos.slug, slug));
  if (mode === 'add') {
    if (existing) throw new Error(`repo ${slug} already registered — use repo set`);
    await db.insert(schema.repos).values({
      slug,
      cloneUrl: cloneUrl(slug),
      ...patch,
    });
    console.log(`registered ${slug}`);
  } else {
    if (!existing) throw new Error(`repo ${slug} not registered`);
    await db.update(schema.repos).set(patch).where(eq(schema.repos.id, existing.id));
    console.log(`updated ${slug}`);
  }
}

/**
 * Record that a run ended without finishing its stage — a cancelled or timed-out CI job, which never
 * gets to record anything itself. Without this a killed run's review keeps whatever stage it was in
 * and holds the repo's only review slot until the staleness bound expires hours later.
 *
 * `failed` rather than `pending`, so the next run resumes the stage through inferRetryState instead
 * of restarting at intake and auditing an empty diff. A review in `awaiting_answers` is untouched:
 * it was not interrupted, it is waiting for its answers.
 */
async function abandonReview(slug: string, prNumber: number, reason: string): Promise<void> {
  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.slug, slug));
  if (!repo) throw new Error(`repo ${slug} not registered`);
  const [review] = await db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.repoId, repo.id), eq(schema.reviews.prNumber, prNumber)));
  if (!review) {
    console.log(`no review for ${slug}#${prNumber} — nothing to record`);
    return;
  }
  if (!ACTIVE_WORK_STATES.has(review.state)) {
    console.log(`review for #${prNumber} is in ${review.state} — not an interrupted stage, left alone`);
    return;
  }
  const error = `run ended in ${review.state}: ${reason}`;
  await db
    .update(schema.reviews)
    .set({ state: 'failed', error, updatedAt: new Date() })
    .where(eq(schema.reviews.id, review.id));
  console.log(`recorded #${prNumber} as failed (was ${review.state}) — the slot is free again`);
  const [round] = review.currentRoundId
    ? await db.select().from(schema.rounds).where(eq(schema.rounds.id, review.currentRoundId))
    : [];
  await markGate(slug, round ?? null, 'failed');
  await progressStep(slug, review, 'Stopped, see the comment below', { icon: '⛔' });
  await postFailureNotice(slug, review, {
    stage: review.state,
    roundNo: round?.roundNo ?? null,
    headSha: round?.headSha ?? null,
    error,
  });
}

/**
 * Prints the PR number of the review that should run next, and nothing else — the Actions
 * workflow dispatches whatever lands on stdout, so every diagnostic goes to stderr.
 *
 * A review turned away by `claimReviewSlot` is left in `pending`, so that is the queue. It is
 * drained oldest first, and a queued PR that has since been closed is retired here rather
 * than costing a whole workflow run to discover it in intake.
 */
async function showNextQueued(slug: string): Promise<void> {
  const pr = await nextQueuedPr(slug);
  if (pr !== null) printRaw(String(pr));
}

/** Dispatch the review workflow again so the queued PR starts now. */
async function handOffToQueue(slug: string, workflowFile: string): Promise<void> {
  const pr = await nextQueuedPr(slug);
  if (pr === null) return;
  // Every project this reviewer is pointed at may name its default branch differently, so ask
  // rather than assume: a dispatch to a ref that does not exist is rejected, and the queued PR
  // would then wait for the scheduled sweep with nothing saying why.
  const ref = process.env.REVIEWER_DISPATCH_REF?.trim() || (await getDefaultBranch(slug));
  await dispatchWorkflow(slug, workflowFile, ref);
  console.log(`dispatched ${workflowFile} on ${ref} for queued PR #${pr}`);
}

async function nextQueuedPr(slug: string): Promise<number | null> {
  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.slug, slug));
  if (!repo) throw new Error(`repo ${slug} not registered`);

  // Asking only whether a non-terminal review exists is not enough: a holder whose PR has since
  // been closed is dead (nothing re-enters it, since `closed` is not a trigger) and would block
  // the queue forever. resolveSlot retires those, exactly as claiming the slot does.
  const slot = await resolveSlot(repo.id, slug, null);
  if (!slot.ok) {
    // A review waiting for answers is the one holder worth re-entering. Its event can be lost — the
    // concurrency group keeps a single pending run, so a third event cancels the second, and the
    // comment carrying the answers is exactly the kind of event that gets dropped. Nothing else would
    // ever retry it, and the repo stayed frozen until the owner thought to comment again. Re-entering
    // costs one comment read now that this state needs no workspace.
    if (slot.conflict.state === 'awaiting_answers') {
      console.error(`PR #${slot.conflict.pr} is waiting for answers — re-entering it to check`);
      return slot.conflict.pr;
    }
    console.error(
      `PR #${slot.conflict.pr} still holds the slot (${slot.conflict.state}) — nothing to dispatch`,
    );
    return null;
  }

  const queued = await db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.repoId, repo.id), eq(schema.reviews.state, 'pending')))
    .orderBy(schema.reviews.createdAt);

  for (const review of queued) {
    let prState: string;
    try {
      prState = (await getPr(slug, review.prNumber)).state;
    } catch (err) {
      console.error(`could not check PR #${review.prNumber} (${String(err).split('\n')[0]}) — skipping`);
      continue;
    }
    if (prState === 'open') return review.prNumber;
    await db
      .update(schema.reviews)
      .set({ state: 'failed', error: `queued but PR is ${prState}`, updatedAt: new Date() })
      .where(eq(schema.reviews.id, review.id));
    console.error(`retired queued review for PR #${review.prNumber} (PR is ${prState})`);
  }
  // Nothing queued in the database is not the same as nothing to do. A run can be cancelled
  // before it ever executes — the concurrency group keeps exactly one pending run, so a third
  // event cancels the second — and that PR then has no review row at all, with no further event
  // coming. The sweep is the only thing that notices, so it reconciles against GitHub.
  const existingByPr = new Map(
    (
      await db
        .select({
          pr: schema.reviews.prNumber,
          state: schema.reviews.state,
          currentRoundId: schema.reviews.currentRoundId,
        })
        .from(schema.reviews)
        .where(eq(schema.reviews.repoId, repo.id))
    ).map((r) => [r.pr, r]),
  );
  try {
    for (const prNumber of await listOpenPrNumbers(slug)) {
      const existing = existingByPr.get(prNumber);
      // Only two kinds of PR are the sweep's business: one with no review at all, and one whose
      // review failed and whose code has since changed. Everything else is live, queued or finished.
      if (existing && existing.state !== 'failed') continue;

      let info;
      try {
        info = await getPr(slug, prNumber);
      } catch (err) {
        console.error(`could not check PR #${prNumber} (${String(err).split('\n')[0]}) — skipping`);
        continue;
      }
      // Both the workflow's trigger and intake refuse these, so enrolling one only buys a failed run.
      if (info.isDraft || info.isFork) continue;

      if (!existing) {
        console.error(`PR #${prNumber} is open with no review of its own — enrolling it`);
        return prNumber;
      }
      // A failed review is worth retrying only when there is something new to review; the same head
      // would reproduce the same failure every six hours, forever.
      const [round] = existing.currentRoundId
        ? await db
            .select({ headSha: schema.rounds.headSha })
            .from(schema.rounds)
            .where(eq(schema.rounds.id, existing.currentRoundId))
        : [];
      if (round && round.headSha !== info.headSha) {
        console.error(
          `PR #${prNumber}'s review failed at ${round.headSha.slice(0, 10)} and the head is now ` +
            `${info.headSha.slice(0, 10)} — retrying it`,
        );
        return prNumber;
      }
    }
  } catch (err) {
    console.error(`could not list open PRs (${String(err).split('\n')[0]})`);
  }
  console.error(`no queued review for ${slug}`);
  return null;
}

async function showStatus(slug?: string): Promise<void> {
  const repos = slug
    ? await db.select().from(schema.repos).where(eq(schema.repos.slug, slug))
    : await db.select().from(schema.repos);
  for (const repo of repos) {
    console.log(`\n${repo.slug} (tests: ${repo.testCommands.map((t) => t.name).join(', ') || 'none'})`);
    const reviews = await db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.repoId, repo.id))
      .orderBy(desc(schema.reviews.updatedAt));
    for (const r of reviews) {
      console.log(
        `  PR #${r.prNumber} [${r.state}] branch ${r.prBranch}${r.error ? ` — error: ${r.error.slice(0, 120)}` : ''}`,
      );
    }
    const sweeps = await db
      .select()
      .from(schema.sweeps)
      .where(eq(schema.sweeps.repoId, repo.id))
      .orderBy(desc(schema.sweeps.id))
      .limit(5);
    for (const s of sweeps) {
      const range = s.headSha ? `${s.baseSha.slice(0, 10)}...${s.headSha.slice(0, 10)}` : `from ${s.baseSha.slice(0, 10)}`;
      const opened = s.summary?.opened.length ?? 0;
      console.log(
        `  sweep ${s.id} [${s.state}] ${s.branch} ${range}, ${s.createdAt.toISOString().slice(0, 10)}` +
          `${s.state === 'done' ? `, opened ${opened}, judged ${s.summary?.judged.length ?? 0}` : ''}` +
          `${s.discussionUrl ? `, summary: ${s.discussionUrl}` : ''}` +
          `${s.error ? ` — error: ${s.error.slice(0, 120)}` : ''}`,
      );
    }
    if (repo.digestIssueNumber) console.log(`  digest: #${repo.digestIssueNumber}`);
    const open = await db.select().from(schema.concerns).where(eq(schema.concerns.repoId, repo.id));
    const openCount = open.filter((c) => c.status === 'open').length;
    const withIssue = open.filter((c) => c.status === 'open' && c.issueNumber !== null).length;
    console.log(`  concerns: ${openCount} open (${withIssue} as issues), ${open.length - openCount} resolved`);
  }
  const runs = await recentNightlyRuns(5);
  const shown = slug ? runs.filter((r) => r.project === null || r.project === slug) : runs;
  console.log(`\n${nightlyStatus(shown).join('\n')}`);
  const byHand = await recentRunsOnTheirOwn(['nightly', ...EVENT_RUN_KINDS], 5, slug);
  console.log(`\n${otherRunsStatus(byHand, EVENT_RUN_KINDS).join('\n')}`);
  const poller = await pollerStatusRows(slug);
  console.log(`\n${pollerStatus(poller.projects, poller.events).join('\n')}`);
  // The whole machine's, whichever project was asked for: one queue serves them all.
  const queue = await queueStatusFacts();
  console.log(`\n${queueStatus(queue.decision, queue.running, queue.machine).join('\n')}`);
}

async function resetReview(slug: string, prNumber: number): Promise<void> {
  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.slug, slug));
  if (!repo) throw new Error(`repo ${slug} not registered`);
  const [review] = await db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.repoId, repo.id), eq(schema.reviews.prNumber, prNumber)));
  if (!review) throw new Error(`no review for ${slug}#${prNumber}`);

  // A killed run's databases are recorded under this review's id, which is about to be forgotten.
  await dropTestDatabases(`review:${review.id}`);
  const rounds = await db.select().from(schema.rounds).where(eq(schema.rounds.reviewId, review.id));
  const roundIds = rounds.map((r) => r.id);
  await db.transaction(async (tx) => {
    for (const round of rounds) {
      await tx.delete(schema.findings).where(eq(schema.findings.roundId, round.id));
      await tx.delete(schema.agentSessions).where(eq(schema.agentSessions.roundId, round.id));
    }
    await tx.delete(schema.questions).where(eq(schema.questions.reviewId, review.id));
    await tx.delete(schema.githubArtifacts).where(eq(schema.githubArtifacts.reviewId, review.id));
    // Concerns and policies survive the reset; detach every reference they hold to the
    // review's rows (concerns from OTHER reviews can point at these rounds via lastSeenRoundId).
    if (roundIds.length > 0) {
      await tx
        .update(schema.concerns)
        .set({ lastSeenRoundId: null })
        .where(inArray(schema.concerns.lastSeenRoundId, roundIds));
    }
    await tx
      .update(schema.concerns)
      .set({ originReviewId: null })
      .where(eq(schema.concerns.originReviewId, review.id));
    await tx
      .update(schema.policies)
      .set({ sourceReviewId: null })
      .where(eq(schema.policies.sourceReviewId, review.id));
    await tx.delete(schema.rounds).where(eq(schema.rounds.reviewId, review.id));
    await tx.delete(schema.reviews).where(eq(schema.reviews.id, review.id));
  });
  // With the review gone, so is the record that it was asked for: the label starts a new one.
  await forgetReviewEvents(slug, prNumber);
  console.log(`review for ${slug}#${prNumber} deleted (concerns and policies preserved)`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    // A command started as a recorded run tells the run that started it what kind of error ended it.
    const runId = process.env.REVIEWER_RUN_ID;
    if (runId) process.stderr.write(`${errorTypeLine(runId, err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
