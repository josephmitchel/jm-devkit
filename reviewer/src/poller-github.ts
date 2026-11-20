import crypto from 'node:crypto';

import { CONFIG_FILE } from '../../plugin/devkit-config.mjs';
import { SWEEP_WORKFLOW } from '../../plugin/generator/generate.mjs';
import { GitHubError, appJwt, defaultBranchFile } from '../../plugin/install/app.mjs';
import type { PullRequestSeen } from './poller.js';
import type { Observed } from './projects.js';

/**
 * What a pass of the poller asks GitHub. A pass runs every few minutes and nearly always finds
 * nothing, so every question it repeats is asked conditionally: the ETag of the last answer is
 * sent back, and an answer of "unchanged" (304) costs none of the App's rate limit. The last
 * answers and their ETags are kept between passes, in the database.
 *
 * GitHub ties an ETag to the credential the question was asked with, so an installation's token
 * is kept for the hour it lasts as well. A pass that minted its own would never be told
 * "unchanged".
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
  /** A token for the project's installation, good for the rest of this pass. */
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
    const repositories = (auth: string) =>
      rememberedPages(asking, `installation/${id}/repositories`, { path: '/installation/repositories', auth }, (body) =>
        (JSON.parse(body) as { repositories: Array<{ full_name: string }> }).repositories.map((r) => r.full_name),
      );
    let token = await tokenFor(asking, id, jwt);
    let slugs: string[];
    try {
      slugs = await repositories(token);
    } catch (err) {
      // GitHub can end a token before its hour is up. This is the first question asked with it.
      if (!(err instanceof GitHubError && err.status === 401)) throw err;
      token = await tokenFor(asking, id, jwt, { anew: true });
      slugs = await repositories(token);
    }
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
 * its head", whose ETag is the commit itself, whatever credential asks.
 */
async function defaultBranch(asking: Asking, slug: string, token: string): Promise<{ observed: Observed; fresh: boolean }> {
  const head: Request = { path: `/repos/${slug}/commits/HEAD`, auth: token, accept: 'application/vnd.github.sha' };
  let got;
  try {
    got = await remembered(asking, `repos/${slug}/default-branch`, head, async (): Promise<Observed> => {
      const read = (path: string) => {
        asking.tally.asked++;
        return defaultBranchFile({ fetch: asking.fetch, slug, token, path });
      };
      const config = await read(CONFIG_FILE);
      return { config, sweepWorkflow: (await read(SWEEP_WORKFLOW)) !== null };
    });
  } catch (err) {
    // A repository with no commits yet.
    if (!(err instanceof GitHubError && err.status === 409)) throw err;
    got = null;
  }
  return got ? { observed: got.answer, fresh: got.fresh } : { observed: NO_FILES, fresh: true };
}

// A kept token is used only while it has this long left: a pass takes seconds.
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** A token for an installation: the kept one while it lasts, or a new one, which is then kept. */
async function tokenFor(asking: Asking, installation: number, jwt: string, { anew = false } = {}): Promise<string> {
  const question = `installation/${installation}/token`;
  const kept = anew ? null : openToken((await asking.memory.recall(question))?.answer, asking.credentials.privateKey);
  if (kept && kept.expiresAt - asking.now().getTime() > TOKEN_MARGIN_MS) return kept.token;
  const path = `/app/installations/${installation}/access_tokens`;
  const answer = await ask(asking, { path, auth: jwt, method: 'POST' });
  if (answer.status !== 'changed') throw new GitHubError(`GitHub POST ${path}: no token`, 404);
  const minted = JSON.parse(answer.body) as { token: string; expires_at: string };
  const token = { token: minted.token, expiresAt: Date.parse(minted.expires_at) };
  await asking.memory.keep(question, { etag: null, answer: sealToken(token, asking.credentials.privateKey) });
  return token.token;
}

interface KeptToken {
  token: string;
  expiresAt: number;
}

// The key a kept token is sealed with comes from the App's private key, which only the service's
// environment holds. So the database never holds a credential that can be used on its own: whoever
// can open a kept token could already mint one.
function sealingKey(privateKey: string): Buffer {
  return crypto.createHash('sha256').update(`code-reviewer kept installation token\n${privateKey}`).digest();
}

/** A token as it is kept: sealed (AES-256-GCM), so it cannot be read without the App's private key. */
export function sealToken(token: KeptToken, privateKey: string): { sealed: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealingKey(privateKey), iv);
  const text = Buffer.concat([cipher.update(JSON.stringify(token), 'utf8'), cipher.final()]);
  return { sealed: Buffer.concat([iv, cipher.getAuthTag(), text]).toString('base64') };
}

/** The token a kept answer holds, or null when it holds none this key opens. */
export function openToken(kept: unknown, privateKey: string): KeptToken | null {
  const sealed = (kept as { sealed?: unknown } | null | undefined)?.sealed;
  if (typeof sealed !== 'string') return null;
  try {
    const bytes = Buffer.from(sealed, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealingKey(privateKey), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const token = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as KeptToken;
    return typeof token.token === 'string' && typeof token.expiresAt === 'number' ? token : null;
  } catch {
    return null;
  }
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
  return (JSON.parse(body) as Array<{ number: number; updated_at: string; merged_at: string | null }>).map((pr) => ({
    number: pr.number,
    updatedAt: new Date(pr.updated_at),
    mergedAt: pr.merged_at === null ? null : new Date(pr.merged_at),
  }));
}
