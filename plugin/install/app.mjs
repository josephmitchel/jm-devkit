#!/usr/bin/env node
// What install asks the code reviewer's GitHub App, authenticating as the App with the client id
// and private key from the secrets file. Read-only: nothing here changes anything on GitHub.
//
//   node app.mjs installed <owner/repo>
//     Prints `installed` (exit 0) or `not installed` (exit 1).
//
// Exit 2 on bad arguments or when GitHub refuses the App. Exit 3 when the App's credentials cannot
// be read here: the question could not be asked, which is not an answer either way. On the
// development machine they are in a file no agent can read, so a caller must not treat 3 as
// "not installed".
//
// The code reviewer finds its projects with `installedRepos` and `defaultBranchFile` from here
// (reviewer/src/projects.ts), so there is one way to list what the App is installed on.

import crypto from 'node:crypto';

import { isMain, repoSlug } from './gh.mjs';
import { APP_SECRET_NAMES, SecretsFileError, configDir, readSecrets } from './secrets-file.mjs';

const API = 'https://api.github.com';

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

function appCredentials(env) {
  const values = readSecrets(APP_SECRET_NAMES, configDir(env));
  return { clientId: values.REVIEWER_APP_CLIENT_ID, privateKey: values.REVIEWER_APP_PRIVATE_KEY };
}

const USAGE = 'usage: node app.mjs installed <owner/repo>\n';

/** The CLI. Resolves to the exit code. */
export async function main(argv, { fetch: fetchFn = globalThis.fetch, env = process.env, out = process.stdout, err = process.stderr, now } = {}) {
  const [command, slug, ...rest] = argv;
  const repo = repoSlug(slug);
  if (!repo || command !== 'installed' || rest.length > 0) {
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
    const installed = await isInstalled({ fetch: fetchFn, credentials, repo, now });
    out.write(installed ? 'installed\n' : 'not installed\n');
    return installed ? 0 : 1;
  } catch (e) {
    err.write(`${e instanceof GitHubError ? e.message : `could not reach GitHub: ${e.message}`}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
