import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { openToken, projectsSeen, pullRequestsSeen, type Asking, type Remembered } from './poller-github.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CONFIG = JSON.stringify({ modules: ['process'], reviewer: { tests: [{ name: 'unit', command: 'npm test' }] } });
const WORKFLOW = '.github/workflows/nightly-sweep.yml';

interface World {
  /** GitHub's clock, and the machine's. */
  date: Date;
  installations: Record<number, string[]>;
  heads: Record<string, string>;
  files: Record<string, Record<string, string>>;
  pulls: Record<string, Array<{ number: number; updated_at: string; merged_at: string | null }>>;
}

/**
 * A stand-in for GitHub as the App sees it. It answers a repeated question with 304 only when the
 * ETag it gave is sent back, and it ties that ETag to the credential the question was asked with,
 * as GitHub does: the answer to a new token is never 304. Every request is recorded.
 */
function github(world: World) {
  const requests: Array<{ method: string; path: string; status: number }> = [];
  const tokens = new Map<string, { installation: number; expires: number }>();
  const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  const route = (method: string, path: string, auth: string): [number, string, string?] => {
    const installation = tokens.get(auth);
    if (installation && installation.expires <= world.date.getTime()) return [401, 'Bad credentials'];
    let m: RegExpMatchArray | null;
    if (method === 'GET' && path === '/app/installations?per_page=100&page=1') {
      return [200, JSON.stringify(Object.keys(world.installations).map((id) => ({ id: Number(id) })))];
    }
    if (method === 'POST' && (m = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      const token = `ghs_${m[1]}_${tokens.size + 1}`;
      const expires = world.date.getTime() + 60 * 60 * 1000;
      tokens.set(token, { installation: Number(m[1]), expires });
      return [201, JSON.stringify({ token, expires_at: new Date(expires).toISOString() })];
    }
    if (!installation) return [401, 'Bad credentials'];
    if (method === 'GET' && path === '/installation/repositories?per_page=100&page=1') {
      return [200, JSON.stringify({ repositories: world.installations[installation.installation].map((full_name) => ({ full_name })) })];
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/commits\/HEAD$/))) {
      const sha = world.heads[m[1]];
      // The one ETag that is the same for every credential: it is the commit.
      return sha ? [200, sha, `"${sha}"`] : [409, 'Git Repository is empty.'];
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/))) {
      const text = world.files[m[1]]?.[m[2]];
      return text === undefined ? [404, 'Not Found'] : [200, text];
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\?state=all&sort=updated&direction=desc&per_page=100&page=(\d+)$/))) {
      const newestFirst = [...(world.pulls[m[1]] ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return [200, JSON.stringify(newestFirst.slice((Number(m[2]) - 1) * 100, Number(m[2]) * 100))];
    }
    return [404, 'Not Found'];
  };
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = String(input).replace('https://api.github.com', '');
    const headers = new Headers(init.headers);
    const auth = (headers.get('authorization') ?? '').replace('Bearer ', '');
    const [found, body, fixedEtag] = route(method, path, auth);
    const etag = fixedEtag ?? `W/"${hash(body + auth)}"`;
    const status = found === 200 && headers.get('if-none-match') === etag ? 304 : found;
    requests.push({ method, path, status });
    const sent = { date: world.date.toUTCString(), ...(found === 200 ? { etag } : {}) };
    return new Response(status === 304 ? null : body, { status, headers: sent });
  }) as typeof globalThis.fetch;
  return { fetch, requests, tokens };
}

/** GitHub, the App's credentials and what the database would keep, for as many passes as a test takes. */
function setUp(world: World) {
  const { fetch, requests, tokens } = github(world);
  const kept = new Map<string, Remembered>();
  const asking: Asking = {
    fetch,
    credentials: { clientId: 'Iv1.standin', privateKey },
    memory: {
      recall: async (question) => kept.get(question) ?? null,
      keep: async (question, remembered) => void kept.set(question, structuredClone(remembered)),
    },
    now: () => world.date,
    tally: { asked: 0, unchanged: 0 },
  };
  /** The requests made since this was last called, as `METHOD path status`. */
  const made = () => requests.splice(0).map((r) => `${r.method} ${r.path.replace(/[?&]per_page=100&page=1$/, '')} ${r.status}`);
  return { asking, made, kept, tokens };
}

const world = (): World => ({
  date: new Date('2026-11-20T12:00:00Z'),
  installations: { 11: ['acme/widgets', 'acme/gadgets'], 12: ['Zenith/anvils'] },
  heads: { 'acme/widgets': 'a'.repeat(40), 'acme/gadgets': 'b'.repeat(40), 'Zenith/anvils': 'c'.repeat(40) },
  files: {
    'acme/widgets': { 'devkit.json': CONFIG },
    'acme/gadgets': { 'devkit.json': CONFIG, [WORKFLOW]: 'name: nightly sweep\n' },
    'Zenith/anvils': {},
  },
  pulls: {},
});

const later = (w: World, minutes: number) => (w.date = new Date(w.date.getTime() + minutes * 60_000));

describe('finding the projects on every pass', () => {
  it("reads what each project's default branch holds the first time", async () => {
    const { asking, made } = setUp(world());
    const { projects } = await projectsSeen(asking);
    expect(projects.map(({ slug, observed, fresh }) => ({ slug, observed, fresh }))).toEqual([
      { slug: 'acme/widgets', observed: { config: CONFIG, sweepWorkflow: false }, fresh: true },
      { slug: 'acme/gadgets', observed: { config: CONFIG, sweepWorkflow: true }, fresh: true },
      { slug: 'Zenith/anvils', observed: { config: null, sweepWorkflow: false }, fresh: true },
    ]);
    expect(made()).toEqual([
      'GET /app/installations 200',
      'POST /app/installations/11/access_tokens 201',
      'GET /installation/repositories 200',
      'GET /repos/acme/widgets/commits/HEAD 200',
      'GET /repos/acme/widgets/contents/devkit.json 200',
      `GET /repos/acme/widgets/contents/${WORKFLOW} 404`,
      'GET /repos/acme/gadgets/commits/HEAD 200',
      'GET /repos/acme/gadgets/contents/devkit.json 200',
      `GET /repos/acme/gadgets/contents/${WORKFLOW} 200`,
      'POST /app/installations/12/access_tokens 201',
      'GET /installation/repositories 200',
      'GET /repos/Zenith/anvils/commits/HEAD 200',
      'GET /repos/Zenith/anvils/contents/devkit.json 404',
      `GET /repos/Zenith/anvils/contents/${WORKFLOW} 404`,
    ]);
  });

  it('is told "unchanged" throughout on the next pass, and asks for no new token', async () => {
    const w = world();
    const { asking, made } = setUp(w);
    const first = await projectsSeen(asking);
    made();
    later(w, 3);
    const second = await projectsSeen(asking);
    expect(made()).toEqual([
      // The App's own credential is new every pass, so this one answer is given in full.
      'GET /app/installations 200',
      'GET /installation/repositories 304',
      'GET /repos/acme/widgets/commits/HEAD 304',
      'GET /repos/acme/gadgets/commits/HEAD 304',
      'GET /installation/repositories 304',
      'GET /repos/Zenith/anvils/commits/HEAD 304',
    ]);
    expect(second.projects.map((p) => ({ ...p, fresh: true }))).toEqual(first.projects);
    expect(second.projects.map((p) => p.fresh)).toEqual([false, false, false]);
  });

  it('reads a project again when its default branch has moved, and only that project', async () => {
    const w = world();
    const { asking, made } = setUp(w);
    await projectsSeen(asking);
    made();
    later(w, 3);
    // The pull request that deletes the sweep workflow has merged: the project has moved.
    w.heads['acme/gadgets'] = 'd'.repeat(40);
    delete w.files['acme/gadgets'][WORKFLOW];
    const { projects } = await projectsSeen(asking);
    expect(projects.find((p) => p.slug === 'acme/gadgets')).toMatchObject({ observed: { config: CONFIG, sweepWorkflow: false }, fresh: true });
    expect(made().filter((r) => !r.endsWith(' 304'))).toEqual([
      'GET /app/installations 200',
      'GET /repos/acme/gadgets/commits/HEAD 200',
      'GET /repos/acme/gadgets/contents/devkit.json 200',
      `GET /repos/acme/gadgets/contents/${WORKFLOW} 404`,
    ]);
  });

  it('sees a project added to an installation on the next pass', async () => {
    const w = world();
    const { asking } = setUp(w);
    await projectsSeen(asking);
    later(w, 3);
    w.installations[12].push('Zenith/hammers');
    w.heads['Zenith/hammers'] = 'e'.repeat(40);
    w.files['Zenith/hammers'] = { 'devkit.json': CONFIG };
    const { projects } = await projectsSeen(asking);
    expect(projects.map((p) => p.slug)).toEqual(['acme/widgets', 'acme/gadgets', 'Zenith/anvils', 'Zenith/hammers']);
  });

  it('asks for a new token once the kept one is near the end of its hour', async () => {
    const w = world();
    const { asking, made } = setUp(w);
    await projectsSeen(asking);
    made();
    later(w, 54);
    expect((await projectsSeen(asking)).projects).toHaveLength(3);
    expect(made().filter((r) => r.startsWith('POST'))).toEqual([]);
    later(w, 3);
    expect((await projectsSeen(asking)).projects).toHaveLength(3);
    expect(made().filter((r) => r.startsWith('POST'))).toEqual([
      'POST /app/installations/11/access_tokens 201',
      'POST /app/installations/12/access_tokens 201',
    ]);
  });

  it('keeps a token only sealed: what is kept cannot be read without the private key', async () => {
    const { asking, kept, tokens } = setUp(world());
    await projectsSeen(asking);
    const everythingKept = JSON.stringify([...kept.entries()]);
    expect(tokens.size).toBe(2);
    for (const token of tokens.keys()) expect(everythingKept).not.toContain(token);
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    expect(openToken(kept.get('installation/11/token')!.answer, other.privateKey)).toBeNull();
    expect(openToken(kept.get('installation/11/token')!.answer, privateKey)?.token).toBe('ghs_11_1');
  });

  it('asks for a new token when the kept one cannot be opened, as after the private key was replaced', async () => {
    const { asking, made, kept } = setUp(world());
    await projectsSeen(asking);
    made();
    kept.set('installation/11/token', { etag: null, answer: { sealed: 'bm90IGEgdG9rZW4=' } });
    await projectsSeen(asking);
    expect(made().filter((r) => r.startsWith('POST'))).toEqual(['POST /app/installations/11/access_tokens 201']);
  });

  it('returns apart a project whose default branch could not be read, and still reads the others', async () => {
    const w = world();
    const { asking } = setUp(w);
    const refuse = asking.fetch;
    asking.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('/repos/acme/widgets/commits/') ? new Response('Server Error', { status: 500 }) : refuse(input, init)) as typeof fetch;
    const { projects, unread } = await projectsSeen(asking);
    expect(projects.map((p) => p.slug)).toEqual(['acme/gadgets', 'Zenith/anvils']);
    expect(unread).toEqual([{ slug: 'acme/widgets', why: 'GitHub GET /repos/acme/widgets/commits/HEAD: 500 Server Error' }]);
  });

  it('counts what it asked and how much of it was unchanged', async () => {
    const w = world();
    const { asking } = setUp(w);
    await projectsSeen(asking);
    expect(asking.tally).toEqual({ asked: 14, unchanged: 0 });
    asking.tally = { asked: 0, unchanged: 0 };
    later(w, 3);
    await projectsSeen(asking);
    expect(asking.tally).toEqual({ asked: 6, unchanged: 5 });
  });
});

describe("reading a project's pull requests", () => {
  const pr = (number: number, updated: string, merged: string | null = null) => ({
    number,
    updated_at: `2026-11-20T${updated}Z`,
    merged_at: merged && `2026-11-20T${merged}Z`,
  });
  const at = (time: string) => new Date(`2026-11-20T${time}Z`);

  async function reading(pulls: World['pulls'][string]) {
    const w = { ...world(), pulls: { 'acme/widgets': pulls } };
    const set = setUp(w);
    const token = (await projectsSeen(set.asking)).projects[0].token;
    set.made();
    return { ...set, w, token };
  }

  it('lists them, newest change first, with when each merged and GitHub\'s time', async () => {
    const { asking, token } = await reading([pr(11, '08:00:00', '08:00:00'), pr(12, '11:59:00', '11:58:00'), pr(13, '11:30:00')]);
    const seen = await pullRequestsSeen(asking, 'acme/widgets', token, { etag: null, seenTo: null });
    expect(seen.at).toEqual(at('12:00:00'));
    expect(seen.pullRequests).toEqual([
      { number: 12, updatedAt: at('11:59:00'), mergedAt: at('11:58:00') },
      { number: 13, updatedAt: at('11:30:00'), mergedAt: null },
      { number: 11, updatedAt: at('08:00:00'), mergedAt: at('08:00:00') },
    ]);
  });

  it('is told "unchanged" when asked again with the ETag of the last listing, and reads it again once one has changed', async () => {
    const { asking, token, made, w } = await reading([pr(12, '11:59:00')]);
    const first = await pullRequestsSeen(asking, 'acme/widgets', token, { etag: null, seenTo: null });
    const again = await pullRequestsSeen(asking, 'acme/widgets', token, { etag: first.etag, seenTo: at('11:59:00') });
    expect(again).toEqual({ at: at('12:00:00'), etag: first.etag, pullRequests: null });
    w.pulls['acme/widgets'][0] = pr(12, '12:01:00', '12:01:00');
    const changed = await pullRequestsSeen(asking, 'acme/widgets', token, { etag: first.etag, seenTo: at('11:59:00') });
    expect(changed.pullRequests).toEqual([{ number: 12, updatedAt: at('12:01:00'), mergedAt: at('12:01:00') }]);
    expect(changed.etag).not.toBe(first.etag);
    expect(made().map((r) => r.split(' ')[2])).toEqual(['200', '304', '200']);
  });

  it('reads further back only as far as the last pass got', async () => {
    // 250 pull requests, one changed each second up to 11:04:10: the last pass got to 11:02:00.
    const many = Array.from({ length: 250 }, (_, i) => pr(i + 1, new Date(Date.UTC(2026, 10, 20, 11, 0, i + 1)).toISOString().slice(11, 19)));
    const { asking, token, made } = await reading(many);
    const seen = await pullRequestsSeen(asking, 'acme/widgets', token, { etag: null, seenTo: at('11:02:00') });
    expect(made()).toHaveLength(2);
    expect(seen.pullRequests).toHaveLength(200);
    expect(seen.pullRequests!.filter((p) => p.updatedAt > at('11:02:00'))).toHaveLength(130);
  });

  it('reads one page on a first pass, which acts on nothing', async () => {
    const many = Array.from({ length: 250 }, (_, i) => pr(i + 1, new Date(Date.UTC(2026, 10, 20, 11, 0, i + 1)).toISOString().slice(11, 19)));
    const { asking, token, made } = await reading(many);
    await pullRequestsSeen(asking, 'acme/widgets', token, { etag: null, seenTo: null });
    expect(made()).toHaveLength(1);
  });
});
