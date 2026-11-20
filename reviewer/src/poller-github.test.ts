import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { commentsSeen, projectsSeen, pullRequestsSeen, type Asking, type Remembered } from './poller-github.js';

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
  pulls: Record<
    string,
    Array<{ number: number; updated_at: string; merged_at: string | null; state: 'open' | 'closed'; head: { sha: string }; draft?: boolean; labels?: Array<{ name: string }> }>
  >;
  /** By `owner/name#number`: the comments on a pull request, and the reviews submitted on it. */
  comments?: Record<string, Array<{ id: number; created_at: string; author_association?: string }>>;
  reviews?: Record<string, Array<{ id: number; submitted_at?: string; state: string; body: string | null; author_association?: string }>>;
  /**
   * What GitHub ties an ETag to. `installation`: whoever asks for that installation is told
   * "unchanged". `token`: only the very credential that got the answer is, and a pass mints its
   * own, so no pass is. Which of the two GitHub does has not been seen with the real App.
   */
  etags: 'installation' | 'token';
}

/**
 * A stand-in for GitHub as the App sees it. It answers a repeated question with 304 only when the
 * ETag it gave is sent back, and it ties that ETag to who asked (see `World.etags`). Every request
 * is recorded.
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
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments\?since=([^&]+)&per_page=100&page=(\d+)$/))) {
      const since = decodeURIComponent(m[3]);
      const all = (world.comments?.[`${m[1]}#${m[2]}`] ?? []).filter((c) => c.created_at >= since);
      return [200, JSON.stringify(all.slice((Number(m[4]) - 1) * 100, Number(m[4]) * 100))];
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews\?per_page=100&page=(\d+)$/))) {
      const all = world.reviews?.[`${m[1]}#${m[2]}`] ?? [];
      return [200, JSON.stringify(all.slice((Number(m[3]) - 1) * 100, Number(m[3]) * 100))];
    }
    return [404, 'Not Found'];
  };
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = String(input).replace('https://api.github.com', '');
    const headers = new Headers(init.headers);
    const auth = (headers.get('authorization') ?? '').replace('Bearer ', '');
    const [found, body, fixedEtag] = route(method, path, auth);
    const asker = world.etags === 'token' ? auth : `installation ${tokens.get(auth)?.installation ?? 'none: the App itself'}`;
    const etag = fixedEtag ?? `W/"${hash(body + asker)}"`;
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

const world = (etags: World['etags'] = 'installation'): World => ({
  etags,
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

  it('is told "unchanged" throughout on the next pass, when GitHub ties an ETag to the installation', async () => {
    const w = world('installation');
    const { asking, made } = setUp(w);
    const first = await projectsSeen(asking);
    made();
    later(w, 3);
    const second = await projectsSeen(asking);
    expect(made()).toEqual([
      'GET /app/installations 304',
      'POST /app/installations/11/access_tokens 201',
      'GET /installation/repositories 304',
      'GET /repos/acme/widgets/commits/HEAD 304',
      'GET /repos/acme/gadgets/commits/HEAD 304',
      'POST /app/installations/12/access_tokens 201',
      'GET /installation/repositories 304',
      'GET /repos/Zenith/anvils/commits/HEAD 304',
    ]);
    expect(second.projects.map(({ slug, observed }) => ({ slug, observed }))).toEqual(first.projects.map(({ slug, observed }) => ({ slug, observed })));
    expect(second.projects.map((p) => p.fresh)).toEqual([false, false, false]);
  });

  it('finds the same projects when GitHub ties an ETag to the token, and the lists are answered in full', async () => {
    const w = world('token');
    const { asking, made } = setUp(w);
    const first = await projectsSeen(asking);
    made();
    later(w, 3);
    const second = await projectsSeen(asking);
    expect(made()).toEqual([
      'GET /app/installations 200',
      'POST /app/installations/11/access_tokens 201',
      'GET /installation/repositories 200',
      // A default branch's ETag is its commit, whoever asks, so its files are still not read again.
      'GET /repos/acme/widgets/commits/HEAD 304',
      'GET /repos/acme/gadgets/commits/HEAD 304',
      'POST /app/installations/12/access_tokens 201',
      'GET /installation/repositories 200',
      'GET /repos/Zenith/anvils/commits/HEAD 304',
    ]);
    expect(second.projects.map(({ slug, observed }) => ({ slug, observed }))).toEqual(first.projects.map(({ slug, observed }) => ({ slug, observed })));
  });

  it("does not read a project's files again when its head is answered in full and is the same commit", async () => {
    const w = world('token');
    const { asking, made } = setUp(w);
    await projectsSeen(asking);
    made();
    later(w, 3);
    // As if GitHub took no notice of the ETag sent with this question either.
    const github = asking.fetch;
    asking.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (String(input).includes('/commits/HEAD')) headers.delete('if-none-match');
      return github(input, { ...init, headers });
    }) as typeof fetch;
    const { projects } = await projectsSeen(asking);
    expect(made().filter((r) => r.includes('/repos/'))).toEqual([
      'GET /repos/acme/widgets/commits/HEAD 200',
      'GET /repos/acme/gadgets/commits/HEAD 200',
      'GET /repos/Zenith/anvils/commits/HEAD 200',
    ]);
    expect(projects.map((p) => p.fresh)).toEqual([false, false, false]);
    expect(projects[1].observed).toEqual({ config: CONFIG, sweepWorkflow: true });
  });

  it('asks for its tokens on every pass and keeps none of them', async () => {
    const w = world();
    const { asking, kept, tokens } = setUp(w);
    await projectsSeen(asking);
    later(w, 3);
    const { projects } = await projectsSeen(asking);
    expect([...tokens.keys()]).toEqual(['ghs_11_1', 'ghs_12_2', 'ghs_11_3', 'ghs_12_4']);
    expect(projects.map((p) => p.token)).toEqual(['ghs_11_3', 'ghs_11_3', 'ghs_12_4']);
    const everythingKept = JSON.stringify([...kept.entries()]);
    for (const token of tokens.keys()) expect(everythingKept).not.toContain(token);
    expect(everythingKept).not.toContain('ghs_');
    expect([...kept.keys()].sort()).toEqual([
      'app/installations?page=1',
      'installation/11/repositories?page=1',
      'installation/12/repositories?page=1',
      'repos/Zenith/anvils/default-branch',
      'repos/acme/gadgets/default-branch',
      'repos/acme/widgets/default-branch',
    ]);
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
    expect(made().filter((r) => r.startsWith('GET') && !r.endsWith(' 304'))).toEqual([
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
    expect(asking.tally).toEqual({ asked: 8, unchanged: 6 });
  });
});

describe("reading a project's pull requests", () => {
  const HEAD = 'c3'.repeat(20);
  const pr = (number: number, updated: string, merged: string | null = null, head = HEAD) => ({
    number,
    updated_at: `2026-11-20T${updated}Z`,
    merged_at: merged && `2026-11-20T${merged}Z`,
    // A pull request closed without merging reads the same to the poller as a merged one: not open.
    state: merged ? ('closed' as const) : ('open' as const),
    head: { sha: head },
  });
  const at = (time: string) => new Date(`2026-11-20T${time}Z`);
  const open = { open: true, headSha: HEAD, draft: false, labels: [], comments: [] };
  const closed = { ...open, open: false };

  async function reading(pulls: World['pulls'][string], etags: World['etags'] = 'installation') {
    const w = { ...world(etags), pulls: { 'acme/widgets': pulls } };
    const set = setUp(w);
    const token = (await projectsSeen(set.asking)).projects[0].token;
    set.made();
    return { ...set, w, token };
  }

  it('lists them, newest change first, with when each merged, whether it is open, its head and GitHub\'s time', async () => {
    const MOVED = 'b2'.repeat(20);
    const { asking, token } = await reading([pr(11, '08:00:00', '08:00:00'), pr(12, '11:59:00', '11:58:00'), pr(13, '11:30:00', null, MOVED)]);
    const seen = await pullRequestsSeen(asking, 'acme/widgets', token, { etag: null, seenTo: null });
    expect(seen.at).toEqual(at('12:00:00'));
    expect(seen.pullRequests).toEqual([
      { number: 12, updatedAt: at('11:59:00'), mergedAt: at('11:58:00'), ...closed },
      { number: 13, updatedAt: at('11:30:00'), mergedAt: null, ...open, headSha: MOVED },
      { number: 11, updatedAt: at('08:00:00'), mergedAt: at('08:00:00'), ...closed },
    ]);
  });

  it('says of each whether it is open, whether it is a draft, and which labels it has', async () => {
    const { asking, token } = await reading([
      { ...pr(14, '11:59:00'), draft: true, labels: [{ name: 'review-now' }] },
      { ...pr(15, '11:58:00'), labels: [{ name: 'bug' }, { name: 'review-now' }] },
      { ...pr(16, '11:57:00'), state: 'closed' },
    ]);
    const seen = await pullRequestsSeen(asking, 'acme/widgets', token, { etag: null, seenTo: null });
    expect(seen.pullRequests!.map(({ number, open, draft, labels, comments }) => ({ number, open, draft, labels, comments }))).toEqual([
      { number: 14, open: true, draft: true, labels: ['review-now'], comments: [] },
      { number: 15, open: true, draft: false, labels: ['bug', 'review-now'], comments: [] },
      { number: 16, open: false, draft: false, labels: [], comments: [] },
    ]);
  });

  it('is told "unchanged" when asked again with the ETag of the last listing, and reads it again once one has changed', async () => {
    const { asking, token, made, w } = await reading([pr(12, '11:59:00')]);
    const first = await pullRequestsSeen(asking, 'acme/widgets', token, { etag: null, seenTo: null });
    const again = await pullRequestsSeen(asking, 'acme/widgets', token, { etag: first.etag, seenTo: at('11:59:00') });
    expect(again).toEqual({ at: at('12:00:00'), etag: first.etag, pullRequests: null });
    w.pulls['acme/widgets'][0] = pr(12, '12:01:00', '12:01:00');
    const changed = await pullRequestsSeen(asking, 'acme/widgets', token, { etag: first.etag, seenTo: at('11:59:00') });
    expect(changed.pullRequests).toEqual([{ number: 12, updatedAt: at('12:01:00'), mergedAt: at('12:01:00'), ...closed }]);
    expect(changed.etag).not.toBe(first.etag);
    expect(made().map((r) => r.split(' ')[2])).toEqual(['200', '304', '200']);
  });

  it('is told "unchanged" by the next pass\'s new token, when GitHub ties an ETag to the installation', async () => {
    const { asking, token, made, w } = await reading([pr(12, '11:59:00', '11:58:00')]);
    const first = await pullRequestsSeen(asking, 'acme/widgets', token, { etag: null, seenTo: null });
    later(w, 3);
    const next = (await projectsSeen(asking)).projects[0].token;
    expect(next).not.toBe(token);
    made();
    expect((await pullRequestsSeen(asking, 'acme/widgets', next, { etag: first.etag, seenTo: at('11:59:00') })).pullRequests).toBeNull();
    expect(made()).toEqual(['GET /repos/acme/widgets/pulls?state=all&sort=updated&direction=desc 304']);
  });

  it('is given the listing in full when GitHub ties an ETag to the token, and reads it like any other', async () => {
    const { asking, token, made, w } = await reading([pr(12, '11:59:00', '11:58:00')], 'token');
    const first = await pullRequestsSeen(asking, 'acme/widgets', token, { etag: null, seenTo: null });
    later(w, 3);
    const next = (await projectsSeen(asking)).projects[0].token;
    made();
    const again = await pullRequestsSeen(asking, 'acme/widgets', next, { etag: first.etag, seenTo: at('11:59:00') });
    expect(made()).toEqual(['GET /repos/acme/widgets/pulls?state=all&sort=updated&direction=desc 200']);
    // The same pull requests as before: what was already handled is the decision's to leave alone.
    expect(again.pullRequests).toEqual(first.pullRequests);
    expect(again.etag).not.toBe(first.etag);
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

describe('reading what has been said on a pull request', () => {
  const at = (time: string) => new Date(`2026-11-20T${time}Z`);
  const stamp = (time: string) => `2026-11-20T${time}Z`;

  async function reading(said: Pick<World, 'comments' | 'reviews'>) {
    const w = { ...world(), ...said };
    const set = setUp(w);
    const token = (await projectsSeen(set.asking)).projects[0].token;
    set.made();
    return { ...set, token };
  }

  it('gives the comments and the submitted reviews written since a time, with what GitHub says each author is to the project', async () => {
    const { asking, token, made } = await reading({
      comments: {
        'acme/widgets#12': [
          { id: 900, created_at: stamp('10:00:00'), author_association: 'OWNER' },
          { id: 901, created_at: stamp('11:30:00'), author_association: 'OWNER' },
          { id: 902, created_at: stamp('11:31:00'), author_association: 'NONE' },
        ],
      },
      reviews: {
        'acme/widgets#12': [
          { id: 700, submitted_at: stamp('11:40:00'), state: 'COMMENTED', body: '1. yes', author_association: 'COLLABORATOR' },
          { id: 701, submitted_at: stamp('09:00:00'), state: 'COMMENTED', body: 'earlier', author_association: 'OWNER' },
        ],
      },
    });
    expect(await commentsSeen(asking, 'acme/widgets', token, 12, at('11:00:00'))).toEqual([
      { id: 901, at: at('11:30:00'), authorAssociation: 'OWNER' },
      { id: 902, at: at('11:31:00'), authorAssociation: 'NONE' },
      { id: 700, at: at('11:40:00'), authorAssociation: 'COLLABORATOR' },
    ]);
    expect(made()).toEqual([
      'GET /repos/acme/widgets/issues/12/comments?since=2026-11-20T11%3A00%3A00.000Z 200',
      'GET /repos/acme/widgets/pulls/12/reviews 200',
    ]);
  });

  it('leaves out a review that is not submitted or says nothing, as the review does when it reads answers', async () => {
    const { asking, token } = await reading({
      reviews: {
        'acme/widgets#12': [
          { id: 700, state: 'PENDING', body: 'a draft of a review', author_association: 'OWNER' },
          { id: 701, submitted_at: stamp('11:40:00'), state: 'APPROVED', body: '', author_association: 'OWNER' },
          { id: 702, submitted_at: stamp('11:41:00'), state: 'APPROVED', body: null, author_association: 'OWNER' },
        ],
      },
    });
    expect(await commentsSeen(asking, 'acme/widgets', token, 12, at('11:00:00'))).toEqual([]);
  });

  it('takes an author GitHub says nothing about to be nobody to the project', async () => {
    const { asking, token } = await reading({ comments: { 'acme/widgets#12': [{ id: 900, created_at: stamp('11:30:00') }] } });
    expect(await commentsSeen(asking, 'acme/widgets', token, 12, at('11:00:00'))).toEqual([{ id: 900, at: at('11:30:00'), authorAssociation: 'NONE' }]);
  });

  it('reads on while a page is full', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: 1000 + i, created_at: stamp('11:30:00'), author_association: 'NONE' }));
    const { asking, token, made } = await reading({ comments: { 'acme/widgets#12': many } });
    expect(await commentsSeen(asking, 'acme/widgets', token, 12, at('11:00:00'))).toHaveLength(150);
    expect(made().filter((r) => r.includes('/comments'))).toHaveLength(2);
  });
});
