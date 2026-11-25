import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { GitHubError, appJwt, defaultBranchFile, main } from './app.mjs';
import { PRIVATE_KEY, PUBLIC_KEY, VALUES, configDir, sink } from './test-helpers.mjs';

const credentials = { clientId: VALUES.REVIEWER_APP_CLIENT_ID, privateKey: PRIVATE_KEY };
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

const CONFIG = JSON.stringify({ modules: ['process'], reviewer: { tests: [{ name: 't', command: 'true' }] } });

/**
 * A fake GitHub: `routes` maps "METHOD path" to `[status, body]`. Every request is recorded with
 * the token it carried. Paginated lists are served whole on page 1.
 */
function github(routes) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const where = url.replace('https://api.github.com', '').replace(/[?&]per_page=100&page=1$/, '');
    requests.push({ method, where, auth: init.headers?.authorization });
    const [status, body] = routes[`${method} ${where}`] ?? (/[?&]page=\d+$/.test(where) ? [200, []] : [404, 'Not Found']);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
  };
  return { fetch, requests };
}

async function run(argv, fetch, dir = configDir()) {
  const out = sink();
  const err = sink();
  const code = await main(argv, { fetch, env: { DEVKIT_CONFIG_DIR: dir }, out, err, now: NOW });
  return { code, out: out.text, err: err.text };
}

test('the App JWT is RS256, signed by the private key, issued by the client id, under ten minutes', () => {
  const [header, payload, signature] = appJwt(credentials, NOW).split('.');
  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  const claims = decode(payload);
  assert.equal(claims.iss, VALUES.REVIEWER_APP_CLIENT_ID);
  assert.ok(claims.iat < NOW / 1000 && claims.exp - claims.iat <= 600);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), PUBLIC_KEY, Buffer.from(signature, 'base64url')));
});

test('installed: asks GitHub as the App whether it is installed on the repository', async () => {
  const yes = github({ 'GET /repos/owner/project/installation': [200, { id: 11 }] });
  assert.deepEqual(await run(['installed', 'owner/project'], yes.fetch), { code: 0, out: 'installed\n', err: '' });
  assert.match(yes.requests[0].auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);

  const no = github({});
  assert.deepEqual(await run(['installed', 'owner/project'], no.fetch), { code: 1, out: 'not installed\n', err: '' });
});

test("defaultBranchFile gives a file's text, null when it is not there, and GitHub's refusal otherwise", async () => {
  const { fetch, requests } = github({
    'GET /repos/owner/project/contents/devkit.json': [200, CONFIG],
    'GET /repos/owner/project/contents/docs/private.md': [403, 'Resource not accessible by integration'],
  });
  const read = (path) => defaultBranchFile({ fetch, slug: 'owner/project', token: 'ghs_install', path });
  assert.equal(await read('devkit.json'), CONFIG);
  assert.equal(await read('.github/workflows/nightly-sweep.yml'), null);
  await assert.rejects(read('docs/private.md'), (e) => e instanceof GitHubError && e.status === 403);
  assert.ok(requests.every((r) => r.auth === 'Bearer ghs_install'));
});

test('without the App credentials on this machine it exits 3, a check that could not be made, naming what is missing', async () => {
  const { fetch, requests } = github({});
  const result = await run(['installed', 'owner/project'], fetch, configDir({ lines: ['OTHER=x'], key: null }));
  assert.equal(result.code, 3);
  assert.equal(result.out, '');
  assert.match(result.err, /cannot authenticate as the code reviewer's GitHub App/);
  assert.match(result.err, /no value for REVIEWER_APP_CLIENT_ID/);
  assert.match(result.err, /reviewer-app-private-key\.pem is missing/);
  assert.equal(requests.length, 0);
});

test('GitHub refusing the App exits 2 with its answer', async () => {
  const refused = github({ 'GET /repos/owner/project/installation': [401, 'A JSON web token could not be decoded'] });
  const result = await run(['installed', 'owner/project'], refused.fetch);
  assert.equal(result.code, 2);
  assert.match(result.err, /401 A JSON web token could not be decoded/);
});

test('bad arguments exit 2', async () => {
  for (const argv of [[], ['installed'], ['other', 'owner/project'], ['hour', 'owner/project'], ['installed', 'owner/project', 'x']]) {
    assert.equal((await run(argv, github({}).fetch)).code, 2, argv.join(' '));
  }
});
