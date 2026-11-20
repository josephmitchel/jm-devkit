import { describe, expect, it } from 'vitest';

import { kitRepo, outputTail, parseReport, reportRun, reportsFor, type Reporter } from './failure-report.js';
import type { Run } from './runs.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const NIGHT = 'run-20261120T030000Z-000000';
const KIT = 'kit-owner/the-kit';

let n = 0;
const run = (over: Partial<Run>): Run => ({
  id: `run-20261120T03150${n++ % 10}Z-a1b2c3`,
  kind: 'sweep',
  project: 'acme/widgets',
  parentId: null,
  state: 'succeeded',
  stage: null,
  errorType: null,
  startedAt: new Date('2026-11-20T03:00:00Z'),
  finishedAt: new Date('2026-11-20T03:15:02Z'),
  ...over,
});
const failed = (errorType: string | null, over: Partial<Run> = {}) => run({ state: 'failed', stage: 'auditing', errorType, ...over });
const seen = { kitRepo: KIT, kitCommit: COMMIT, tail: 'the end of the output', parts: [] as Run[] };
/** Where each report goes and what it says, in short. */
const told = (r: Run, over: Partial<typeof seen> = {}) =>
  reportsFor(r, { ...seen, ...over }).map((t) => `${t.repo}: ${t.report.side}-side ${t.report.facts.kind} ${t.report.outcome}`);

describe('where a finished run is reported', () => {
  it("reports a failure on the project's side to the project, with the end of its output", () => {
    const r = failed('SetupCommandError');
    expect(reportsFor(r, seen)).toEqual([
      {
        repo: 'acme/widgets',
        report: {
          outcome: 'failed',
          side: 'project',
          facts: { kind: 'sweep', stage: 'auditing', errorType: 'SetupCommandError', kitCommit: COMMIT, time: '2026-11-20T03:15:02.000Z', runId: r.id },
          tail: 'the end of the output',
        },
      },
    ]);
  });

  it("reports any other failure to the kit's repository, without the project or any output", () => {
    const r = failed('TypeError');
    const reports = reportsFor(r, seen);
    expect(reports).toEqual([
      {
        repo: KIT,
        report: {
          outcome: 'failed',
          side: 'kit',
          facts: { kind: 'sweep', stage: 'auditing', errorType: 'TypeError', kitCommit: COMMIT, time: '2026-11-20T03:15:02.000Z', runId: r.id },
        },
      },
    ]);
    expect(JSON.stringify(reports)).not.toMatch(/acme|widgets|the end of the output/);
  });

  it("reports a failing nightly check to the project, as a run of the checks and not of the sweep", () => {
    const checks = failed('NightlyCheckError', { kind: 'checks', stage: 'checking', parentId: NIGHT });
    expect(told(checks)).toEqual(['acme/widgets: project-side checks failed']);
    expect(reportsFor(checks, seen)[0].report).toMatchObject({ tail: 'the end of the output' });
  });

  it("reports a failure that is no project's, such as the nightly run not finding the projects, to the kit's repository", () => {
    const nightly = failed('DevkitConfigError', { kind: 'nightly', project: null, stage: 'finding the projects' });
    expect(told(nightly)).toEqual([`${KIT}: kit-side nightly failed`]);
  });

  it("tells both places of a success, so either's failure issue for that kind of run is closed", () => {
    expect(told(run({}))).toEqual(['acme/widgets: project-side sweep succeeded', `${KIT}: kit-side sweep succeeded`]);
  });

  it("leaves the kit's repository to the nightly run when the success is one project's part of it", () => {
    expect(told(run({ parentId: NIGHT }))).toEqual(['acme/widgets: project-side sweep succeeded']);
  });

  it('reports nothing for a run the service stopping interrupted, or one still running: neither a failure nor a success', () => {
    expect(told(run({ state: 'interrupted' as never, stage: 'auditing', errorType: 'service stopped' }))).toEqual([]);
    expect(told(run({ state: 'interrupted' as never, stage: 'auditing', errorType: 'found running' }))).toEqual([]);
    expect(told(run({ state: 'running', finishedAt: null }))).toEqual([]);
  });

  it("reports a run its time limit stopped as a failure on the code reviewer's side", () => {
    const stopped = run({ state: 'interrupted' as never, stage: 'auditing', errorType: 'time limit' });
    expect(told(stopped)).toEqual([`${KIT}: kit-side sweep failed`]);
    expect(reportsFor(stopped, seen)[0].report.facts).toMatchObject({ stage: 'auditing', errorType: 'time limit' });
  });
});

describe("what a nightly run tells the kit's repository once its projects are done", () => {
  const nightly = (over: Partial<Run> = {}) => run({ id: NIGHT, kind: 'nightly', project: null, ...over });
  const part = (over: Partial<Run>) => run({ parentId: NIGHT, ...over });

  it('that it and its sweeps succeeded, when every one did', () => {
    const parts = [part({ project: 'acme/gadgets' }), part({})];
    expect(told(nightly(), { parts })).toEqual([`${KIT}: kit-side nightly succeeded`, `${KIT}: kit-side sweep succeeded`]);
    expect(reportsFor(nightly(), { ...seen, parts })[1].report.facts.runId).toBe(NIGHT);
  });

  it("nothing about its sweeps when one failed on the code reviewer's side, so a success beside it does not close the issue", () => {
    const parts = [part({ project: 'acme/gadgets', state: 'failed', stage: 'auditing', errorType: 'TypeError' }), part({})];
    expect(told(nightly({ state: 'failed' }), { parts })).toEqual([`${KIT}: kit-side nightly succeeded`]);
  });

  it("that its sweeps succeeded when the only failure was on a project's side", () => {
    const parts = [part({ project: 'acme/gadgets', state: 'failed', stage: 'judging', errorType: 'SetupCommandError' }), part({})];
    expect(told(nightly({ state: 'failed' }), { parts })).toEqual([`${KIT}: kit-side nightly succeeded`, `${KIT}: kit-side sweep succeeded`]);
  });

  it("what became of its sweeps and of its projects' checks, each kind by its own runs", () => {
    const failingCheck = part({ kind: 'checks', state: 'failed', stage: 'checking', errorType: 'NightlyCheckError' });
    const brokenChecks = part({ kind: 'checks', project: 'acme/gadgets', state: 'failed', stage: 'starting', errorType: 'TypeError' });
    const passingChecks = part({ kind: 'checks', project: 'acme/gadgets' });
    const sweeps = [part({ project: 'acme/gadgets' }), part({})];
    const nightSucceeded = `${KIT}: kit-side nightly succeeded`;
    expect(told(nightly({ state: 'failed' }), { parts: [...sweeps, failingCheck, passingChecks] })).toEqual([
      nightSucceeded,
      `${KIT}: kit-side sweep succeeded`,
      `${KIT}: kit-side checks succeeded`,
    ]);
    expect(told(nightly({ state: 'failed' }), { parts: [...sweeps, brokenChecks, failingCheck] })).toEqual([
      nightSucceeded,
      `${KIT}: kit-side sweep succeeded`,
    ]);
  });

  it("nothing about its sweeps when a time limit stopped one, which is a failure on the code reviewer's side", () => {
    const parts = [part({ project: 'acme/gadgets', state: 'interrupted' as never, stage: 'auditing', errorType: 'time limit' }), part({})];
    expect(told(nightly({ state: 'failed' }), { parts })).toEqual([`${KIT}: kit-side nightly succeeded`]);
  });

  it('nothing at all when the service stopping interrupted it', () => {
    const parts = [part({})];
    expect(told(nightly({ state: 'interrupted' as never, errorType: 'service stopped' }), { parts })).toEqual([]);
  });

  it('nothing about its sweeps when none succeeded', () => {
    const parts = [part({ state: 'interrupted' as never, errorType: 'service stopped' })];
    expect(told(nightly(), { parts })).toEqual([`${KIT}: kit-side nightly succeeded`]);
    expect(told(nightly(), { parts: [] })).toEqual([`${KIT}: kit-side nightly succeeded`]);
  });

  it('only its own failure when it failed of itself', () => {
    const broken = nightly({ state: 'failed', stage: 'finding the projects', errorType: 'GitHubError' });
    expect(told(broken, { parts: [] })).toEqual([`${KIT}: kit-side nightly failed`]);
  });

  it('names no project in anything it sends there', () => {
    const parts = [part({ project: 'acme/gadgets', state: 'failed', stage: 'auditing', errorType: 'TypeError' }), part({})];
    for (const r of [nightly(), nightly({ state: 'failed' })]) {
      expect(JSON.stringify(reportsFor(r, { ...seen, parts }))).not.toMatch(/acme|widgets|gadgets|the end of the output/);
    }
  });
});

describe("the end of a run's output", () => {
  it('is its last lines', () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const tail = outputTail(output);
    expect(tail.split('\n')).toHaveLength(40);
    expect(tail.startsWith('line 61\n')).toBe(true);
    expect(tail.endsWith('line 100')).toBe(true);
  });

  it('is cut to a length an issue can hold, keeping the very end', () => {
    const tail = outputTail(`${'x'.repeat(20_000)}\nthe last line\n`);
    expect(tail.length).toBeLessThanOrEqual(4000);
    expect(tail.endsWith('the last line')).toBe(true);
  });

  it('says so when the run wrote nothing', () => {
    expect(outputTail('')).toBe('(the run wrote no output)');
  });

  it("never holds a test database's address, which carries a password, even one the cut would have split", () => {
    const server = 'postgres://tests:s3cret-pw@db.example:5433/postgres';
    const address = 'postgres://tests:s3cret-pw@db.example:5433/reviewer_test_0123456789abcdef_0';
    expect(outputTail(`connecting to ${address}\nconnection refused\n`, server)).toBe(
      'connecting to [test database address]\nconnection refused',
    );
    // Cut to length first, this would start two characters into the password.
    const kept = address.length - 'postgres://tests:s3'.length;
    const tail = outputTail(`${address} ${'y'.repeat(4000 - kept - 1)}\n`, server);
    expect(tail).not.toMatch(/cret-pw|db\.example/);
    expect(tail.endsWith('yyy')).toBe(true);
  });

  it('takes the server for test databases from the machine\'s setting', () => {
    const saved = process.env.REVIEWER_TEST_DATABASES_URL;
    process.env.REVIEWER_TEST_DATABASES_URL = 'postgres://tests:s3cret-pw@db.example:5433/postgres';
    try {
      expect(outputTail('PGPASSWORD=s3cret-pw psql\n')).toBe('PGPASSWORD=[redacted] psql');
    } finally {
      if (saved === undefined) delete process.env.REVIEWER_TEST_DATABASES_URL;
      else process.env.REVIEWER_TEST_DATABASES_URL = saved;
    }
  });
});

describe("the kit's own repository", () => {
  it("is the kit's, unless the setting names another", () => {
    expect(kitRepo({})).toBe('josephmitchel/jm-devkit');
    expect(kitRepo({ REVIEWER_KIT_REPO: ' kit-owner/the-kit ' })).toBe(KIT);
  });

  it('is refused when the setting is not an owner and a name', () => {
    expect(() => kitRepo({ REVIEWER_KIT_REPO: 'the-kit' })).toThrow(/REVIEWER_KIT_REPO/);
  });
});

describe('a report as the command that files it reads it', () => {
  it('is what was sent', () => {
    for (const { report } of [...reportsFor(failed('SetupCommandError'), seen), ...reportsFor(failed('TypeError'), seen), ...reportsFor(run({}), seen)]) {
      expect(parseReport(JSON.stringify(report))).toEqual(report);
    }
  });

  it('is refused when it is not a report', () => {
    expect(() => parseReport('{"outcome":"failed"}')).toThrow(/not a report/);
    expect(() => parseReport('{"outcome":"failed","side":"project","facts":{}}')).toThrow(/not a report/);
    expect(() => parseReport('nonsense')).toThrow(/not a report/);
  });
});

describe('reporting a run', () => {
  const lines: string[] = [];
  const say = (line: string) => lines.push(line);
  const reporter = (over: Partial<Reporter>): Reporter => ({
    kitRepo: () => KIT,
    kitCommit: () => COMMIT,
    tail: () => 'the end of the output',
    parts: async () => [],
    send: async () => [],
    ...over,
  });

  it("sends each place its report and puts what was done in the run's log", async () => {
    lines.length = 0;
    const sent: string[] = [];
    const r = run({});
    await reportRun(r, say, reporter({ send: async (repo, report) => (sent.push(`${repo} ${report.side}`), [`closed failure issue #7 in ${repo}`]) }));
    expect(sent).toEqual(['acme/widgets project', `${KIT} kit`]);
    expect(lines).toEqual([`${r.id}: closed failure issue #7 in acme/widgets`, `${r.id}: closed failure issue #7 in ${KIT}`]);
  });

  it("puts a report that could not be sent in the run's log, sends the rest, and does not throw", async () => {
    lines.length = 0;
    const sent: string[] = [];
    const r = run({});
    const send: Reporter['send'] = async (repo) => {
      if (repo !== KIT) throw new Error('GitHub answered 502');
      sent.push(repo);
      return [];
    };
    await expect(reportRun(r, say, reporter({ send }))).resolves.toBeUndefined();
    expect(sent).toEqual([KIT]);
    expect(lines).toEqual([`${r.id}: could not report that it succeeded to acme/widgets: GitHub answered 502`]);
  });

  it("puts in the run's log that nothing could be reported when what to report could not be worked out", async () => {
    lines.length = 0;
    const r = failed('TypeError');
    const parts: Reporter['parts'] = async () => {
      throw new Error('the database is not answering');
    };
    await expect(reportRun(r, say, reporter({ parts }))).resolves.toBeUndefined();
    expect(lines).toEqual([`${r.id}: could not report that it failed: the database is not answering`]);
  });

  it('asks nothing of the machine or of GitHub for a run that is neither a failure nor a success', async () => {
    lines.length = 0;
    const never = () => {
      throw new Error('asked');
    };
    const r = run({ state: 'interrupted' as never, errorType: 'service stopped' });
    await reportRun(r, say, { kitRepo: never, kitCommit: never, tail: never, parts: never, send: never });
    expect(lines).toEqual([]);
  });

  it('does not throw when the log itself cannot be written', async () => {
    const r = failed('TypeError');
    const send: Reporter['send'] = async () => {
      throw new Error('GitHub answered 502');
    };
    const broken = () => {
      throw new Error('disk full');
    };
    await expect(reportRun(r, broken, reporter({ send }))).resolves.toBeUndefined();
  });
});
