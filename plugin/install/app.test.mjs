import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { FIRST_HOUR, WORKER_LIST_URL, appJwt, chooseHour, main, parseWorkerList } from './app.mjs';
import { PRIVATE_KEY, PUBLIC_KEY, VALUES, configDir, sink } from './test-helpers.mjs';

const credentials = { clientId: VALUES.REVIEWER_APP_CLIENT_ID, privateKey: PRIVATE_KEY };
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

const config = (hour) => JSON.stringify({ modules: ['process'], sweep: { hour }, reviewer: { tests: [{ name: 't', command: 'true' }] } });

const WORKER_LIST = `export const REPOS: SweptRepo[] = [
  { slug: 'owner/first', cron: '17 7 * * *' },
  { slug: 'owner/second', cron: '17 8 * * *' },
];
`;

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

const fleet = (extra = {}) =>
  github({
    'GET /app/installations': [200, [{ id: 11 }]],
    'POST /app/installations/11/access_tokens': [201, { token: 'ghs_install', expires_at: '2026-11-18T13:00:00Z' }],
    'GET /installation/repositories': [
      200,
      {
        repositories: [
          { full_name: 'owner/first' },
          { full_name: 'owner/kit' },
          { full_name: 'owner/broken' },
          { full_name: 'owner/bare' },
          { full_name: 'owner/project' },
        ],
      },
    ],
    'GET /repos/owner/kit/contents/devkit.json': [200, config(9)],
    'GET /repos/owner/broken/contents/devkit.json': [200, '{"modules":[]}'],
    'GET /repos/owner/project/contents/devkit.json': [200, config(10)],
    [`GET ${WORKER_LIST_URL}`]: [200, WORKER_LIST],
    ...extra,
  });

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

test('hour: every other installed repository and the Worker list are taken; the first free hour from 07 is chosen', async () => {
  const { fetch, requests } = fleet();
  const result = await run(['hour', 'owner/project'], fetch);
  assert.equal(result.code, 0);
  assert.equal(
    result.out,
    [
      'hour 10',
      'taken 7 owner/first (the Worker list)',
      'taken 8 owner/second (the Worker list)',
      'taken 9 owner/kit (devkit.json)',
      'skipped owner/first: no devkit.json',
      'skipped owner/broken: devkit.json is malformed: reviewer is required; modules must have at least 1 item; modules must include "process"',
      'skipped owner/bare: no devkit.json',
      '',
    ].join('\n'),
  );
  assert.ok(!requests.some((r) => r.where === '/repos/owner/project/contents/devkit.json'), 'read its own devkit.json');
  assert.ok(requests.filter((r) => r.where.includes('/contents/')).every((r) => r.auth === 'Bearer ghs_install'));
});

test('hour: the current hour is kept when it is free, and moved when another repository has it', async () => {
  assert.match((await run(['hour', 'owner/project', '--current', '3'], fleet().fetch)).out, /^hour 3\n/);
  assert.match((await run(['hour', 'owner/project', '--current', '9'], fleet().fetch)).out, /^hour 10\n/);
});

test('hour: a repository whose devkit.json has no sweep section takes no hour', async () => {
  const moved = JSON.stringify({ modules: ['process'], reviewer: { tests: [{ name: 't', command: 'true' }] } });
  const result = await run(['hour', 'owner/project'], fleet({ 'GET /repos/owner/kit/contents/devkit.json': [200, moved] }).fetch);
  assert.equal(result.code, 0);
  assert.match(result.out, /^hour 9\n/);
  assert.doesNotMatch(result.out, /owner\/kit/);
});

test("hour: a repository in the Worker list keeps that hour, and the list is not needed once it is gone", async () => {
  assert.match((await run(['hour', 'owner/first'], fleet().fetch)).out, /^hour 7\n/);
  const gone = fleet({ [`GET ${WORKER_LIST_URL}`]: [404, 'Not Found'] });
  const result = await run(['hour', 'owner/project'], gone.fetch);
  assert.match(result.out, /^hour 7\ntaken 9 owner\/kit \(devkit\.json\)\n/);
});

test('chooseHour wraps past midnight and gives up only when the day is full', () => {
  const taken = new Set(Array.from({ length: 17 }, (_, i) => FIRST_HOUR + i));
  assert.equal(chooseHour(taken), 0);
  assert.throws(() => chooseHour(new Set(Array.from({ length: 24 }, (_, i) => i))), /every hour/);
});

test('parseWorkerList reads each slug and cron hour', () => {
  assert.deepEqual(parseWorkerList(WORKER_LIST), [
    { slug: 'owner/first', hour: 7 },
    { slug: 'owner/second', hour: 8 },
  ]);
});

test('without the App credentials in the secrets file it exits 2 naming what is missing', async () => {
  const { fetch, requests } = fleet();
  const result = await run(['hour', 'owner/project'], fetch, configDir({ lines: ['DATABASE_URL=x'], key: null }));
  assert.equal(result.code, 2);
  assert.match(result.err, /cannot authenticate as the code reviewer's GitHub App/);
  assert.match(result.err, /no value for REVIEWER_APP_CLIENT_ID/);
  assert.match(result.err, /reviewer-app-private-key\.pem is missing/);
  assert.equal(requests.length, 0);
});

test('GitHub refusing the App exits 2 with its answer', async () => {
  const refused = github({ 'GET /app/installations': [401, 'A JSON web token could not be decoded'] });
  const result = await run(['hour', 'owner/project'], refused.fetch);
  assert.equal(result.code, 2);
  assert.match(result.err, /401 A JSON web token could not be decoded/);
});

test('bad arguments exit 2', async () => {
  for (const argv of [[], ['hour'], ['other', 'owner/project'], ['hour', 'owner/project', '--current', '24'], ['installed', 'owner/project', 'x']]) {
    assert.equal((await run(argv, github({}).fetch)).code, 2, argv.join(' '));
  }
});
