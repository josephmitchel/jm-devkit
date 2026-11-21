import { CONFIG_FILE } from '../../plugin/devkit-config.mjs';
import { SWEEP_WORKFLOW } from '../../plugin/generator/generate.mjs';
import { GitHubError, appJwt, defaultBranchFile } from '../../plugin/install/app.mjs';
import type { CommentSeen, PullRequestSeen } from './poller.js';
import type { Observed } from './projects.js';

/**
 * A pass runs every few minutes and nearly always finds nothing, so every question it repeats is
 * asked conditionally: the ETag of the last answer is sent back, and "unchanged" (304) costs none
 * of the App's rate limit. The answers and ETags are kept between passes. No credential is: a pass
 * mints its tokens and holds them in memory.
 *
 * GitHub ties an ETag to who asked. If that is the token and not the installation, the lists are
 * answered in full every pass, which is accepted: the cost is a request per list.
 */

const API = 'https://api.github.com';

export interface Remembered {
  etag: string | null;
  answer: unknown;
}

export interface Memory {
  recall(question: string): Promise<Remembered | null>;
  keep(question: string, remembered: Remembered): Promise<void>;
}

export interface GitHubAccess {
  fetch: typeof fetch;
  credentials: { clientId: string; privateKey: string };
  memory: Memory;
  now(): Date;
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
  etag?: string | null;
}

async function ask(github: GitHubAccess, request: Request): Promise<Answer> {
  const method = request.method ?? 'GET';
  const res = await github.fetch(`${API}${request.path}`, {
    method,
    headers: {
      authorization: `Bearer ${request.auth}`,
      accept: request.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'code-reviewer',
      ...(request.etag ? { 'if-none-match': request.etag } : {}),
    },
  });
  github.tally.asked++;
  // GitHub's clock, so a time compared with one of GitHub's is not thrown by the machine's.
  const stamped = Date.parse(res.headers.get('date') ?? '');
  const at = Number.isNaN(stamped) ? github.now() : new Date(stamped);
  if (res.status === 304) {
    github.tally.unchanged++;
    return { status: 'unchanged', at };
  }
  if (res.status === 404) return { status: 'missing', at };
  if (!res.ok) throw new GitHubError(`GitHub ${method} ${request.path}: ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
  return { status: 'changed', body: await res.text(), etag: res.headers.get('etag'), at };
}

/**
 * Told "unchanged", the kept answer stands. Otherwise `read` makes the answer, which is kept with
 * its ETag for the next pass.
 */
async function remembered<T>(
  github: GitHubAccess,
  question: string,
  request: Request,
  read: (body: string) => T | Promise<T>,
): Promise<{ answer: T; fresh: boolean } | null> {
  const kept = await github.memory.recall(question);
  const answer = await ask(github, { ...request, etag: kept?.etag });
  if (answer.status === 'missing') return null;
  if (answer.status === 'unchanged' && kept) return { answer: kept.answer as T, fresh: false };
  if (answer.status === 'unchanged') throw new GitHubError(`GitHub GET ${request.path}: 304 to a question asked without an ETag`, 304);
  const fresh = await read(answer.body);
  await github.memory.keep(question, { etag: answer.etag, answer: fresh });
  return { answer: fresh, fresh: true };
}

// The questions whose answers are kept, by the names they are kept under.
const INSTALLATIONS = 'app/installations';
const repositoriesOf = (installation: number) => `installation/${installation}/repositories`;
const defaultBranchOf = (slug: string) => `repos/${slug}/default-branch`;
const pageOf = (question: string, page: number) => `${question}?page=${page}`;

const pagePath = (path: string, page: number) => `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`;

/** `page` gives one page, or null when there is none. */
async function allPages<T>(page: (n: number) => Promise<{ items: T[]; full: boolean } | null>): Promise<T[]> {
  const all: T[] = [];
  for (let n = 1; ; n++) {
    const got = await page(n);
    if (!got) return all;
    all.push(...got.items);
    if (!got.full) return all;
  }
}

/** Each page is a question of its own. */
function rememberedPages<T>(github: GitHubAccess, question: string, request: Request, items: (body: string) => T[]): Promise<T[]> {
  return allPages(async (n) => {
    const path = pagePath(request.path, n);
    const got = await remembered(github, pageOf(question, n), { ...request, path }, (body) => {
      const list = items(body);
      return { list, full: list.length === 100 };
    });
    if (!got) throw new GitHubError(`GitHub GET ${path}: 404`, 404);
    return { items: got.answer.list, full: got.answer.full };
  });
}

export interface ProjectRead {
  slug: string;
  /** Minted by this pass and held in memory only. */
  token: string;
  observed: Observed;
  /** Read this pass, not told "unchanged". */
  fresh: boolean;
}

/**
 * A project's two files are read again only when its default branch has moved. A project whose
 * default branch could not be read is returned apart: it is neither handled nor skipped on an
 * answer that did not come.
 */
export async function projectsSeen(github: GitHubAccess): Promise<{ projects: ProjectRead[]; unread: Array<{ slug: string; why: string }> }> {
  const jwt = appJwt(github.credentials, github.now().getTime());
  const installations = await rememberedPages(github, INSTALLATIONS, { path: '/app/installations', auth: jwt }, (body) =>
    (JSON.parse(body) as Array<{ id: number }>).map((i) => i.id),
  );
  const projects: ProjectRead[] = [];
  const unread: Array<{ slug: string; why: string }> = [];
  for (const id of installations) {
    const token = await mintToken(github, id, jwt);
    const slugs = await rememberedPages(
      github,
      repositoriesOf(id),
      { path: '/installation/repositories', auth: token },
      (body) => (JSON.parse(body) as { repositories: Array<{ full_name: string }> }).repositories.map((r) => r.full_name),
    );
    for (const slug of slugs) {
      try {
        projects.push({ slug, token, ...(await defaultBranch(github, slug, token)) });
      } catch (err) {
        if (!(err instanceof GitHubError)) throw err;
        unread.push({ slug, why: err.message });
      }
    }
  }
  return { projects, unread };
}

const NO_FILES: Observed = { config: null, sweepWorkflow: false };

/** From the answers the last pass kept: no request is made. */
export async function projectsLastSeen(memory: Memory): Promise<Array<{ slug: string } & Observed>> {
  const kept = <T>(question: string): Promise<T[]> =>
    allPages(async (n) => {
      const answer = (await memory.recall(pageOf(question, n)))?.answer as { list: T[]; full: boolean } | undefined;
      return answer ? { items: answer.list, full: answer.full } : null;
    });
  const projects: Array<{ slug: string } & Observed> = [];
  for (const installation of await kept<number>(INSTALLATIONS)) {
    for (const slug of await kept<string>(repositoriesOf(installation))) {
      const branch = (await memory.recall(defaultBranchOf(slug)))?.answer as { observed: Observed } | undefined;
      projects.push({ slug, ...(branch?.observed ?? NO_FILES) });
    }
  }
  return projects;
}

/**
 * The question repeated each pass is only which commit is the head, whose ETag is the commit
 * itself, whatever credential asks. The two files are read again only when that commit is not the
 * one they were last read at.
 */
async function defaultBranch(github: GitHubAccess, slug: string, token: string): Promise<{ observed: Observed; fresh: boolean }> {
  const question = defaultBranchOf(slug);
  const kept = (await github.memory.recall(question)) as { etag: string | null; answer: { head: string; observed: Observed } } | null;
  let head;
  try {
    head = await ask(github, { path: `/repos/${slug}/commits/HEAD`, auth: token, accept: 'application/vnd.github.sha', etag: kept?.etag });
  } catch (err) {
    // A repository with no commits yet.
    if (!(err instanceof GitHubError && err.status === 409)) throw err;
    return { observed: NO_FILES, fresh: true };
  }
  if (head.status === 'missing') return { observed: NO_FILES, fresh: true };
  if (kept && (head.status === 'unchanged' || head.body.trim() === kept.answer.head)) return { observed: kept.answer.observed, fresh: false };
  if (head.status === 'unchanged') throw new GitHubError(`GitHub GET /repos/${slug}/commits/HEAD: 304 to a question asked without an ETag`, 304);
  const read = (path: string) => {
    github.tally.asked++;
    return defaultBranchFile({ fetch: github.fetch, slug, token, path });
  };
  const config = await read(CONFIG_FILE);
  const observed: Observed = { config, sweepWorkflow: (await read(SWEEP_WORKFLOW)) !== null };
  await github.memory.keep(question, { etag: head.etag, answer: { head: head.body.trim(), observed } });
  return { observed, fresh: true };
}

/** This pass's alone, and never written anywhere. */
async function mintToken(github: GitHubAccess, installation: number, jwt: string): Promise<string> {
  const path = `/app/installations/${installation}/access_tokens`;
  const answer = await ask(github, { path, auth: jwt, method: 'POST' });
  if (answer.status !== 'changed') throw new GitHubError(`GitHub POST ${path}: no token`, 404);
  return (JSON.parse(answer.body) as { token: string }).token;
}

export interface ListingPosition {
  /** Null before any. */
  etag: string | null;
  /** Null on a first pass. */
  seenTo: Date | null;
}

/**
 * Null when nothing has changed since the listing `position.etag` came with. One listing covers
 * every state, so a merge, a label, a new head and a comment all change it.
 */
export async function pullRequestsSeen(
  github: GitHubAccess,
  slug: string,
  token: string,
  position: ListingPosition,
): Promise<{ at: Date; etag: string | null; pullRequests: PullRequestSeen[] | null }> {
  const page = (n: number) => `/repos/${slug}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${n}`;
  const first = await ask(github, { path: page(1), auth: token, etag: position.etag });
  if (first.status === 'unchanged') return { at: first.at, etag: position.etag, pullRequests: null };
  if (first.status === 'missing') throw new GitHubError(`GitHub GET ${page(1)}: 404`, 404);
  const pullRequests = listed(first.body);
  // Further back only while a whole page is newer than where the last pass got to.
  for (let n = 2; pullRequests.length === (n - 1) * 100 && position.seenTo !== null && pullRequests.at(-1)!.updatedAt > position.seenTo; n++) {
    const next = await ask(github, { path: page(n), auth: token });
    if (next.status !== 'changed') break;
    pullRequests.push(...listed(next.body));
  }
  return { at: first.at, etag: first.etag, pullRequests };
}

interface ListedPullRequest {
  number: number;
  updated_at: string;
  merged_at: string | null;
  state: string;
  head: { sha: string };
  draft?: boolean;
  labels?: Array<{ name: string }>;
}

function listed(body: string): PullRequestSeen[] {
  return (JSON.parse(body) as ListedPullRequest[]).map((pr) => ({
    number: pr.number,
    updatedAt: new Date(pr.updated_at),
    mergedAt: pr.merged_at === null ? null : new Date(pr.merged_at),
    open: pr.state === 'open',
    headSha: pr.head.sha,
    draft: pr.draft === true,
    labels: (pr.labels ?? []).map((label) => label.name),
    // Not in the listing: read apart, and only for a pull request whose review waits on the owner.
    comments: [],
  }));
}

/**
 * Comments, and submitted reviews with something written, the other way a reply arrives. Not asked
 * conditionally: a pass asks only when the pull request has changed and its review is waiting.
 */
export async function commentsSeen(github: GitHubAccess, slug: string, token: string, pr: number, since: Date): Promise<CommentSeen[]> {
  const pages = <T>(path: string): Promise<T[]> =>
    allPages(async (n) => {
      const paged = pagePath(path, n);
      const answer = await ask(github, { path: paged, auth: token });
      if (answer.status !== 'changed') throw new GitHubError(`GitHub GET ${paged}: no answer`, 404);
      const items = JSON.parse(answer.body) as T[];
      return { items, full: items.length === 100 };
    });
  const comments = await pages<{ id: number; created_at: string; author_association?: string }>(
    `/repos/${slug}/issues/${pr}/comments?since=${encodeURIComponent(since.toISOString())}`,
  );
  const reviews = await pages<{ id: number; submitted_at?: string; state: string; body: string | null; author_association?: string }>(
    `/repos/${slug}/pulls/${pr}/reviews`,
  );
  return [
    // Absent is NONE, never trusted.
    ...comments.map((c) => ({ id: c.id, at: new Date(c.created_at), authorAssociation: c.author_association ?? 'NONE' })),
    ...reviews
      .filter((r) => r.state !== 'PENDING' && r.body && r.submitted_at)
      .map((r) => ({ id: r.id, at: new Date(r.submitted_at as string), authorAssociation: r.author_association ?? 'NONE' })),
  ].filter((c) => c.at >= since);
}
