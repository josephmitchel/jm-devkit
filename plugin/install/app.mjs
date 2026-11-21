#!/usr/bin/env node
// What install asks the code reviewer's GitHub App, authenticating as the App with the client id
// and private key from the secrets file. Read-only: nothing here changes anything on GitHub.
//
//   node app.mjs installed <owner/repo>
//     Prints `installed` (exit 0) or `not installed` (exit 1).
//   node app.mjs hour <owner/repo> [--current <hour>]
//     Prints `hour <h>`: the sweep hour for the repository, one no other repository with the App
//     uses. Its current hour (--current, from its devkit.json) is kept when it is free. Then one
//     line per hour taken, `taken <h> <owner/repo> (<where it came from>)`, and one per repository
//     whose devkit.json could not be read, `skipped <owner/repo>: <why>`.
//
// Exit 2 on bad arguments or when GitHub refuses the App. Exit 3 when the App's credentials are not
// on this machine: the question could not be asked, which is not an answer either way. They are kept
// off a machine on purpose where agents work, so a caller must not treat 3 as "not installed".
//
// Install no longer runs `hour`: the owner's machine sweeps every project in one nightly run, so
// there are no slots. It stays for a project still on GitHub Actions until the last one has moved.
//
// The code reviewer finds its projects with `installedRepos` and `defaultBranchFile` from here
// (reviewer/src/projects.ts), so there is one way to list what the App is installed on.

import crypto from 'node:crypto';

import { CONFIG_FILE, DevkitConfigError, parseDevkitConfig } from '../devkit-config.mjs';
import { isMain, repoSlug } from './gh.mjs';
import { SecretsFileError, configDir, readSecrets } from './secrets-file.mjs';

const API = 'https://api.github.com';

/**
 * The Worker's list of projects, from before the Worker found projects through the App. While it
 * exists its hours are taken too; once it is gone (a 404) it is simply not consulted.
 */
export const WORKER_LIST_URL = 'https://raw.githubusercontent.com/josephmitchel/jm-devkit/main/reviewer/worker/src/repos.ts';

/** Where the search for a free hour starts: the slot the first projects were given. */
export const FIRST_HOUR = 7;

/** A JWT that authenticates as the App itself, signed RS256 with its private key. */
export function appJwt({ clientId, privateKey }, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: clientId })}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

async function call(fetchFn, path, token, { method = 'GET', raw = false } = {}) {
  const res = await fetchFn(path.startsWith('https://') ? path : `${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'devkit-install',
    },
  });
  if (!res.ok) throw new GitHubError(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
  return raw ? res.text() : res.json();
}

async function pages(fetchFn, path, token, key) {
  const all = [];
  for (let page = 1; ; page++) {
    const body = await call(fetchFn, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token);
    const items = key ? body[key] : body;
    all.push(...items);
    if (items.length < 100) return all;
  }
}

/** Whether the App is installed on `repo`. */
export async function isInstalled({ fetch: fetchFn, credentials, repo, now }) {
  try {
    await call(fetchFn, `/repos/${repo}/installation`, appJwt(credentials, now));
    return true;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return false;
    throw e;
  }
}

/** Every repository the App is installed on, as owner/name, with a token that can read it. */
export async function installedRepos({ fetch: fetchFn, credentials, now }) {
  const jwt = appJwt(credentials, now);
  const repos = [];
  for (const installation of await pages(fetchFn, '/app/installations', jwt)) {
    const { token } = await call(fetchFn, `/app/installations/${installation.id}/access_tokens`, jwt, { method: 'POST' });
    for (const repo of await pages(fetchFn, '/installation/repositories', token, 'repositories')) {
      repos.push({ slug: repo.full_name, token });
    }
  }
  return repos;
}

/** The text of the file at `path` on `slug`'s default branch, or null when it has none. */
export async function defaultBranchFile({ fetch: fetchFn, slug, token, path }) {
  try {
    return await call(fetchFn, `/repos/${slug}/contents/${path}`, token, { raw: true });
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

/** `{ slug, hour }` for each cron in the Worker's list (`slug: 'a/b', cron: 'M H * * *'`). */
export function parseWorkerList(source) {
  const entries = [];
  for (const [, slug, hour] of source.matchAll(/slug:\s*'([^']+)',\s*cron:\s*'\d+\s+(\d+)\s/g)) {
    entries.push({ slug, hour: Number(hour) });
  }
  return entries;
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * The hours other repositories sweep at: each one's devkit.json on its default branch, and the
 * Worker's list while it exists. `repo` itself is left out, its Worker hour returned as `ownHour`.
 */
export async function takenHours({ fetch: fetchFn, credentials, repo, now }) {
  const taken = [];
  const skipped = [];
  for (const { slug, token } of await installedRepos({ fetch: fetchFn, credentials, now })) {
    if (same(slug, repo)) continue;
    const text = await defaultBranchFile({ fetch: fetchFn, slug, token, path: CONFIG_FILE });
    if (text === null) {
      skipped.push({ slug, why: `no ${CONFIG_FILE}` });
      continue;
    }
    try {
      const config = parseDevkitConfig(text);
      // A project swept by the owner's machine has no sweep section, and so no hour.
      if (config.sweep) taken.push({ hour: config.sweep.hour, slug, from: CONFIG_FILE });
    } catch (e) {
      if (!(e instanceof DevkitConfigError)) throw e;
      skipped.push({ slug, why: e.message });
    }
  }

  let ownHour = null;
  const res = await fetchFn(WORKER_LIST_URL, { headers: { 'user-agent': 'devkit-install' } });
  if (res.ok) {
    for (const entry of parseWorkerList(await res.text())) {
      if (same(entry.slug, repo)) ownHour = entry.hour;
      else taken.push({ hour: entry.hour, slug: entry.slug, from: 'the Worker list' });
    }
  } else if (res.status !== 404) {
    throw new GitHubError(`GET ${WORKER_LIST_URL}: ${res.status}`, res.status);
  }
  taken.sort((a, b) => a.hour - b.hour || a.slug.localeCompare(b.slug));
  return { taken, skipped, ownHour };
}

/**
 * The sweep hour to use: the current one if no one else has it, else the repository's own Worker
 * hour if free, else the first free hour from FIRST_HOUR on, wrapping past midnight.
 */
export function chooseHour(takenSet, { current = null, ownHour = null } = {}) {
  for (const preferred of [current, ownHour]) if (preferred !== null && !takenSet.has(preferred)) return preferred;
  for (let i = 0; i < 24; i++) {
    const hour = (FIRST_HOUR + i) % 24;
    if (!takenSet.has(hour)) return hour;
  }
  throw new Error('every hour of the day already has a sweep');
}

function appCredentials(env) {
  const values = readSecrets(['REVIEWER_APP_CLIENT_ID', 'REVIEWER_APP_PRIVATE_KEY'], configDir(env));
  return { clientId: values.REVIEWER_APP_CLIENT_ID, privateKey: values.REVIEWER_APP_PRIVATE_KEY };
}

const USAGE = 'usage: node app.mjs installed <owner/repo>\n       node app.mjs hour <owner/repo> [--current <hour>]\n';

/** The CLI. Resolves to the exit code. */
export async function main(argv, { fetch: fetchFn = globalThis.fetch, env = process.env, out = process.stdout, err = process.stderr, now } = {}) {
  const [command, slug, ...rest] = argv;
  const repo = repoSlug(slug);
  let current = null;
  if (command === 'hour' && rest[0] === '--current' && rest.length === 2) {
    current = /^\d+$/.test(rest[1]) && Number(rest[1]) <= 23 ? Number(rest[1]) : NaN;
  } else if (rest.length > 0) current = NaN;
  if (!repo || !['installed', 'hour'].includes(command) || Number.isNaN(current)) {
    err.write(USAGE);
    return 2;
  }

  let credentials;
  try {
    credentials = appCredentials(env);
  } catch (e) {
    if (!(e instanceof SecretsFileError)) throw e;
    err.write(`cannot authenticate as the code reviewer's GitHub App:\n${e.problems.map((p) => `  ${p}\n`).join('')}`);
    return 3;
  }

  try {
    if (command === 'installed') {
      const installed = await isInstalled({ fetch: fetchFn, credentials, repo, now });
      out.write(installed ? 'installed\n' : 'not installed\n');
      return installed ? 0 : 1;
    }
    const { taken, skipped, ownHour } = await takenHours({ fetch: fetchFn, credentials, repo, now });
    out.write(`hour ${chooseHour(new Set(taken.map((t) => t.hour)), { current, ownHour })}\n`);
    for (const t of taken) out.write(`taken ${t.hour} ${t.slug} (${t.from})\n`);
    for (const s of skipped) out.write(`skipped ${s.slug}: ${s.why}\n`);
    return 0;
  } catch (e) {
    err.write(`${e instanceof GitHubError ? e.message : `could not reach GitHub: ${e.message}`}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
