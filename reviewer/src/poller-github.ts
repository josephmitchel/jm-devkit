import { CONFIG_FILE } from '../../plugin/devkit-config.mjs';
import { SWEEP_WORKFLOW } from '../../plugin/generator/generate.mjs';
import { GitHubError, appJwt, defaultBranchFile } from '../../plugin/install/app.mjs';
import type { PullRequestSeen } from './poller.js';
import type { Observed } from './projects.js';

/**
 * What a pass of the poller asks GitHub. A pass runs every few minutes and nearly always finds
 * nothing, so every question it repeats is asked conditionally: the ETag of the last answer is
 * sent back, and an answer of "unchanged" (304) costs none of the App's rate limit. The last
 * answers and their ETags are kept between passes, in the database. No credential is: a pass
 * mints its installation tokens and holds them in memory until it ends.
 *
 * GitHub ties an ETag to who asked. If that is the installation, a pass is told "unchanged" with
 * its new token. If it is the token, the lists are answered in full every pass, and that is
 * accepted: an answer in full is read like any other, and the cost is a request per list.
 */

const API = 'https://api.github.com';

/** The last answer to a question a pass repeats, and the ETag GitHub gave with it. */
export interface Remembered {
  etag: string | null;
  answer: unknown;
}

/** Where answers are kept between passes. */
export interface Memory {
  recall(question: string): Promise<Remembered | null>;
  keep(question: string, remembered: Remembered): Promise<void>;
}

/** How a pass reaches GitHub, and what it has to do it with. */
export interface Asking {
  fetch: typeof fetch;
  credentials: { clientId: string; privateKey: string };
  memory: Memory;
  now(): Date;
  /** Counted as it goes: every request, and those answered "unchanged". */
  tally: { asked: number; unchanged: number };
}

type Answer =
  | { status: 'unchanged'; at: Date }
  | { status: 'changed'; body: string; etag: string | null; at: Date }
  | { status: 'missing'; at: Date };

interface Request {
  path: string;
  /** A token or the App's JWT. */
  auth: string;
  accept?: string;
  method?: 'GET' | 'POST';
  /** The ETag of the answer already held, when there is one. */
  etag?: string | null;
}

async function ask(asking: Asking, request: Request): Promise<Answer> {
  const method = request.method ?? 'GET';
  const res = await asking.fetch(`${API}${request.path}`, {
    method,
    headers: {
      authorization: `Bearer ${request.auth}`,
      accept: request.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'code-reviewer',
      ...(request.etag ? { 'if-none-match': request.etag } : {}),
    },
  });
  asking.tally.asked++;
  // GitHub's clock, so a time compared with one of GitHub's is not thrown by the machine's.
  const stamped = Date.parse(res.headers.get('date') ?? '');
  const at = Number.isNaN(stamped) ? asking.now() : new Date(stamped);
  if (res.status === 304) {
    asking.tally.unchanged++;
    return { status: 'unchanged', at };
  }
  if (res.status === 404) return { status: 'missing', at };
  if (!res.ok) throw new GitHubError(`GitHub ${method} ${request.path}: ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
  return { status: 'changed', body: await res.text(), etag: res.headers.get('etag'), at };
}

/**
 * Ask a question whose last answer is kept. Told "unchanged", the kept answer stands. Otherwise
 * `read` makes the answer from what GitHub sent, and it is kept with its ETag for the next pass.
 */
async function remembered<T>(
  asking: Asking,
  question: string,
  request: Request,
  read: (body: string) => T | Promise<T>,
): Promise<{ answer: T; fresh: boolean } | null> {
  const kept = await asking.memory.recall(question);
  const answer = await ask(asking, { ...request, etag: kept?.etag });
  if (answer.status === 'missing') return null;
  if (answer.status === 'unchanged' && kept) return { answer: kept.answer as T, fresh: false };
  if (answer.status === 'unchanged') throw new GitHubError(`GitHub GET ${request.path}: 304 to a question asked without an ETag`, 304);
  const fresh = await read(answer.body);
  await asking.memory.keep(question, { etag: answer.etag, answer: fresh });
  return { answer: fresh, fresh: true };
}

/** A list GitHub serves a hundred at a time, each page a question of its own. */
async function rememberedPages<T>(
  asking: Asking,
  question: string,
  request: Request,
  items: (body: string) => T[],
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const path = `${request.path}${request.path.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
    const got = await remembered(asking, `${question}?page=${page}`, { ...request, path }, (body) => {
      const list = items(body);
      return { list, full: list.length === 100 };
    });
    if (!got) throw new GitHubError(`GitHub GET ${path}: 404`, 404);
    all.push(...got.answer.list);
    if (!got.answer.full) return all;
  }
}

/** A project the App is installed on, as this pass saw its default branch. */
export interface ProjectRead {
  slug: string;
  /** A token for the project's installation, minted by this pass and held in memory only. */
  token: string;
  observed: Observed;
  /** Whether the default branch was read this pass, and not told "unchanged". */
  fresh: boolean;
}

/**
 * Every project the App is installed on and what its default branch holds, asked so that a pass
 * over an unchanged GitHub is told "unchanged" throughout. A project's two files are read again
 * only when its default branch has moved. A project whose default branch could not be read is
 * returned apart: it is neither handled nor skipped on an answer that did not come.
 */
export async function projectsSeen(asking: Asking): Promise<{ projects: ProjectRead[]; unread: Array<{ slug: string; why: string }> }> {
  const jwt = appJwt(asking.credentials, asking.now().getTime());
  const installations = await rememberedPages(asking, 'app/installations', { path: '/app/installations', auth: jwt }, (body) =>
    (JSON.parse(body) as Array<{ id: number }>).map((i) => i.id),
  );
  const projects: ProjectRead[] = [];
  const unread: Array<{ slug: string; why: string }> = [];
  for (const id of installations) {
    const token = await mintToken(asking, id, jwt);
    const slugs = await rememberedPages(
      asking,
      `installation/${id}/repositories`,
      { path: '/installation/repositories', auth: token },
      (body) => (JSON.parse(body) as { repositories: Array<{ full_name: string }> }).repositories.map((r) => r.full_name),
    );
    for (const slug of slugs) {
      try {
        projects.push({ slug, token, ...(await defaultBranch(asking, slug, token)) });
      } catch (err) {
        if (!(err instanceof GitHubError)) throw err;
        unread.push({ slug, why: err.message });
      }
    }
  }
  return { projects, unread };
}

const NO_FILES: Observed = { config: null, sweepWorkflow: false };

/**
 * What a project's default branch holds. The question repeated each pass is only "which commit is
 * its head", whose ETag is the commit itself, whatever credential asks. The two files are read
 * again only when that commit is not the one they were last read at, however GitHub answered.
 */
async function defaultBranch(asking: Asking, slug: string, token: string): Promise<{ observed: Observed; fresh: boolean }> {
  const question = `repos/${slug}/default-branch`;
  const kept = (await asking.memory.recall(question)) as { etag: string | null; answer: { head: string; observed: Observed } } | null;
  let head;
  try {
    head = await ask(asking, { path: `/repos/${slug}/commits/HEAD`, auth: token, accept: 'application/vnd.github.sha', etag: kept?.etag });
  } catch (err) {
    // A repository with no commits yet.
    if (!(err instanceof GitHubError && err.status === 409)) throw err;
    return { observed: NO_FILES, fresh: true };
  }
  if (head.status === 'missing') return { observed: NO_FILES, fresh: true };
  if (kept && (head.status === 'unchanged' || head.body.trim() === kept.answer.head)) return { observed: kept.answer.observed, fresh: false };
  if (head.status === 'unchanged') throw new GitHubError(`GitHub GET /repos/${slug}/commits/HEAD: 304 to a question asked without an ETag`, 304);
  const read = (path: string) => {
    asking.tally.asked++;
    return defaultBranchFile({ fetch: asking.fetch, slug, token, path });
  };
  const config = await read(CONFIG_FILE);
  const observed: Observed = { config, sweepWorkflow: (await read(SWEEP_WORKFLOW)) !== null };
  await asking.memory.keep(question, { etag: head.etag, answer: { head: head.body.trim(), observed } });
  return { observed, fresh: true };
}

/** A new token for an installation. It is this pass's alone and is never written anywhere. */
async function mintToken(asking: Asking, installation: number, jwt: string): Promise<string> {
  const path = `/app/installations/${installation}/access_tokens`;
  const answer = await ask(asking, { path, auth: jwt, method: 'POST' });
  if (answer.status !== 'changed') throw new GitHubError(`GitHub POST ${path}: no token`, 404);
  return (JSON.parse(answer.body) as { token: string }).token;
}

/** Where a pass's reading of a project's pull requests starts from. */
export interface ListingPosition {
  /** The ETag of the listing the last pass read, or null before any. */
  etag: string | null;
  /** The newest change the last pass saw, or null on a first pass. */
  seenTo: Date | null;
}

/**
 * A project's pull requests, most recently changed first: null when nothing about any of them
 * has changed since the listing `position.etag` came with. One listing covers every state, so a
 * merge, a label, a new head and a comment all change it.
 */
export async function pullRequestsSeen(
  asking: Asking,
  slug: string,
  token: string,
  position: ListingPosition,
): Promise<{ at: Date; etag: string | null; pullRequests: PullRequestSeen[] | null }> {
  const page = (n: number) => `/repos/${slug}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${n}`;
  const first = await ask(asking, { path: page(1), auth: token, etag: position.etag });
  if (first.status === 'unchanged') return { at: first.at, etag: position.etag, pullRequests: null };
  if (first.status === 'missing') throw new GitHubError(`GitHub GET ${page(1)}: 404`, 404);
  const pullRequests = listed(first.body);
  // Further back only while a whole page is newer than where the last pass got to.
  for (let n = 2; pullRequests.length === (n - 1) * 100 && position.seenTo !== null && pullRequests.at(-1)!.updatedAt > position.seenTo; n++) {
    const next = await ask(asking, { path: page(n), auth: token });
    if (next.status !== 'changed') break;
    pullRequests.push(...listed(next.body));
  }
  return { at: first.at, etag: first.etag, pullRequests };
}

function listed(body: string): PullRequestSeen[] {
  type Listed = { number: number; updated_at: string; merged_at: string | null; state: string; head: { sha: string } };
  return (JSON.parse(body) as Listed[]).map((pr) => ({
    number: pr.number,
    updatedAt: new Date(pr.updated_at),
    mergedAt: pr.merged_at === null ? null : new Date(pr.merged_at),
    open: pr.state === 'open',
    headSha: pr.head.sha,
  }));
}
