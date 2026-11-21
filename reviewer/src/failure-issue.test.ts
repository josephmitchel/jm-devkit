import { describe, expect, it } from 'vitest';

import { failureIssuePlan, type IssueAction, type OpenIssue, type Report, type RunFacts } from './failure-issue.js';
import { MissingDiscussionCategoryError } from './night-summary.js';

const ID = 'run-20261120T031502Z-a1b2c3';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const facts: RunFacts = {
  kind: 'sweep',
  stage: 'auditing',
  errorType: 'TypeError',
  kitCommit: COMMIT,
  time: '2026-11-20T03:15:02.000Z',
  runId: ID,
};
const kitFailure: Report = { outcome: 'failed', side: 'kit', facts };

/** Everything a plan would write to GitHub, as one text. */
const written = (actions: IssueAction[]) => actions.map((a) => `${'title' in a ? a.title : ''}\n${a.body}`).join('\n');
/** An issue the code reviewer opened earlier, as GitHub lists it. */
const opened = (number: number, report: Report): OpenIssue => {
  const [open] = failureIssuePlan(report, []);
  return { number, body: open.body, authorType: 'Bot', authorAssociation: 'NONE' };
};

describe("what a failure issue in the kit's repository may contain", () => {
  it('gives the kind of run, the stage, the type of error, the kit commit, the time and the run id', () => {
    const [open] = failureIssuePlan(kitFailure, []);
    expect(open.action).toBe('open');
    for (const given of ['sweep', 'auditing', 'TypeError', COMMIT, '2026-11-20T03:15:02.000Z', ID]) {
      expect(open.body).toContain(given);
    }
  });

  it('gives the same six things, and no more, in the comment for a further failure', () => {
    const later: Report = { ...kitFailure, facts: { ...facts, stage: 'synthesizing', errorType: 'exit 137', runId: 'run-20261121T031502Z-ffffff' } };
    const [comment] = failureIssuePlan(later, [opened(7, kitFailure)]);
    expect(comment).toMatchObject({ action: 'comment', issue: 7 });
    for (const given of ['sweep', 'synthesizing', 'exit 137', COMMIT, 'run-20261121T031502Z-ffffff']) {
      expect(comment.body).toContain(given);
    }
  });

  // The run's project, a path in it and a line of its output, put everywhere a report has room for text.
  const HOSTILE = 'acme/widgets failed at /srv/checkouts/acme-widgets/src/billing.ts: const apiKey = "hunter2"';
  const leaks = (text: string) => ['acme', 'widgets', 'checkouts', 'billing', 'apikey', 'hunter2'].filter((s) => text.toLowerCase().includes(s));

  it("carries nothing from a run's error message, project or output, wherever in the report it sits", () => {
    const hostile = {
      outcome: 'failed',
      side: 'kit',
      facts: { kind: 'sweep', stage: HOSTILE, errorType: HOSTILE, kitCommit: HOSTILE, time: HOSTILE, runId: HOSTILE, project: HOSTILE, message: HOSTILE },
      tail: HOSTILE,
      project: 'acme/widgets',
      message: HOSTILE,
    } as unknown as Report;
    expect(leaks(written(failureIssuePlan(hostile, [])))).toEqual([]);
    expect(leaks(written(failureIssuePlan(hostile, [opened(7, kitFailure)])))).toEqual([]);
    expect(leaks(written(failureIssuePlan({ ...hostile, outcome: 'succeeded' } as Report, [opened(7, kitFailure)])))).toEqual([]);
  });

  it('does not take a type of error it does not know, however much it looks like one', () => {
    for (const errorType of ['AcmeWidgetsError', 'widgets', 'exit 1 acme/widgets', 'killed by SIGTERM in acme/widgets', 'TypeError\nacme/widgets']) {
      const text = written(failureIssuePlan({ ...kitFailure, facts: { ...facts, errorType } }, []));
      expect(leaks(text)).toEqual([]);
    }
  });

  it('does not take a stage, a commit, a time or a run id that is not in the form the code reviewer writes', () => {
    const odd: RunFacts = { ...facts, stage: 'widgets', kitCommit: 'widgets', time: 'widgets o’clock', runId: 'run-widgets' };
    expect(leaks(written(failureIssuePlan({ ...kitFailure, facts: odd }, [])))).toEqual([]);
  });

  it('refuses a report whose kind of run it does not know, without repeating it', () => {
    const report = { ...kitFailure, facts: { ...facts, kind: 'acme/widgets' } };
    expect(() => failureIssuePlan(report, [])).toThrow(/kind of run/);
    try {
      failureIssuePlan(report, []);
    } catch (err) {
      expect(leaks(String(err))).toEqual([]);
    }
  });

  it('names a time limit as the type of error of a run its time limit stopped', () => {
    const [open] = failureIssuePlan({ ...kitFailure, facts: { ...facts, errorType: 'time limit' } }, []);
    expect(open.body).toContain('Type of error: `time limit`');
  });

  it('names the step that failed when the code reviewer could not be brought up to date before a nightly run', () => {
    const notStarted = { ...facts, kind: 'nightly', stage: 'installing dependencies', errorType: 'exit 1' };
    const [open] = failureIssuePlan({ ...kitFailure, facts: notStarted }, []);
    expect(open.body).toContain('Stage: `installing dependencies`');
  });

  it('opens an issue of its own for a landed run the poller started', () => {
    const [open] = failureIssuePlan({ ...kitFailure, facts: { ...facts, kind: 'landed', stage: 'starting', errorType: 'exit 1' } }, []);
    expect(open).toMatchObject({ action: 'open', title: "A landed run failed on the code reviewer's side" });
    expect(open.body.split('\n')[0]).toBe('<!-- code-reviewer:failure side=kit kind=landed -->');
  });

  it('tells the owner where the full output is, by the run id alone', () => {
    const [open] = failureIssuePlan(kitFailure, []);
    expect(open.body).toContain(`runs/${ID}.log`);
  });
});

/** A stand-in for one place's issues, which takes a plan the way GitHub would. */
class Place {
  issues: Array<OpenIssue & { state: 'open' | 'closed'; title: string; comments: string[] }> = [];

  open(): OpenIssue[] {
    return this.issues.filter((i) => i.state === 'open');
  }

  /** What the code reviewer does here about a finished run. */
  told(report: Report): IssueAction[] {
    const actions = failureIssuePlan(report, this.open());
    for (const a of actions) {
      if (a.action === 'open') this.file(a.title, a.body, { authorType: 'Bot', authorAssociation: 'NONE' });
      else {
        const issue = this.issues.find((i) => i.number === a.issue)!;
        issue.comments.push(a.body);
        if (a.action === 'close') issue.state = 'closed';
      }
    }
    return actions;
  }

  file(title: string, body: string, author: Pick<OpenIssue, 'authorType' | 'authorAssociation'>): number {
    const number = this.issues.length + 1;
    this.issues.push({ number, title, body, state: 'open', comments: [], ...author });
    return number;
  }

  states(): string[] {
    return this.issues.map((i) => `#${i.number} ${i.state}, ${i.comments.length} comment(s)`);
  }
}

const run = (n: number, over: Partial<RunFacts> = {}): RunFacts => ({ ...facts, runId: `run-2026112${n}T031502Z-00000${n}`, ...over });
const kitFailed = (n: number, over: Partial<RunFacts> = {}): Report => ({ outcome: 'failed', side: 'kit', facts: run(n, over) });
const succeeded = (side: 'kit' | 'project', n: number, over: Partial<RunFacts> = {}): Report => ({
  outcome: 'succeeded',
  side,
  facts: run(n, { stage: null, errorType: null, ...over }),
});
const setupFailed = (n: number, tail = 'running setup: npm ci\nsetup command failed:\nnpm error code E404'): Report => ({
  outcome: 'failed',
  side: 'project',
  facts: run(n, { stage: 'judging', errorType: 'SetupCommandError' }),
  tail,
});

describe('the one open failure issue per place and kind of run', () => {
  it("opens an issue in the project for a failure on the project's side, with the end of the run's output", () => {
    const project = new Place();
    project.told(setupFailed(1));
    expect(project.states()).toEqual(['#1 open, 0 comment(s)']);
    expect(project.issues[0].title).toBe("The code reviewer's sweep failed");
    expect(project.issues[0].body).toContain('its setup command failed');
    expect(project.issues[0].body).toContain('npm error code E404');
    expect(project.issues[0].body).toContain(`runs/${run(1).runId}.log`);
  });

  it("opens an issue in the kit's repository for a failure on the code reviewer's side", () => {
    const kit = new Place();
    kit.told(kitFailed(1));
    expect(kit.states()).toEqual(['#1 open, 0 comment(s)']);
    expect(kit.issues[0].title).toBe("A sweep failed on the code reviewer's side");
  });

  it('comments on the open issue at a further failure', () => {
    const project = new Place();
    project.told(setupFailed(1));
    project.told(setupFailed(2, 'setup command failed:\nnpm error code ENOSPC'));
    expect(project.states()).toEqual(['#1 open, 1 comment(s)']);
    expect(project.issues[0].comments[0]).toContain('npm error code ENOSPC');
    expect(project.issues[0].comments[0]).toContain(run(2).runId);
  });

  it("makes one issue and one comment in the kit's repository when two projects fail the same way on one night", () => {
    const kit = new Place();
    kit.told(kitFailed(1, { runId: 'run-20261120T031502Z-aaaaaa' }));
    kit.told(kitFailed(1, { runId: 'run-20261120T032210Z-bbbbbb' }));
    expect(kit.states()).toEqual(['#1 open, 1 comment(s)']);
    expect(kit.issues[0].comments[0]).toContain('run-20261120T032210Z-bbbbbb');
  });

  it('closes the issue at the next success of the same kind, and opens a new one at the failure after that', () => {
    const kit = new Place();
    kit.told(kitFailed(1));
    expect(kit.told(succeeded('kit', 2))).toMatchObject([{ action: 'close', issue: 1 }]);
    expect(kit.states()).toEqual(['#1 closed, 1 comment(s)']);
    expect(kit.issues[0].comments[0]).toContain(run(2).runId);
    kit.told(kitFailed(3));
    expect(kit.states()).toEqual(['#1 closed, 1 comment(s)', '#2 open, 0 comment(s)']);
  });

  it('leaves the issue open at a success of a different kind', () => {
    const kit = new Place();
    kit.told(kitFailed(1));
    expect(kit.told(succeeded('kit', 2, { kind: 'nightly' }))).toEqual([]);
    expect(kit.states()).toEqual(['#1 open, 0 comment(s)']);
  });

  it('keeps an issue for each kind of run', () => {
    const kit = new Place();
    kit.told(kitFailed(1));
    kit.told(kitFailed(2, { kind: 'nightly', stage: 'finding the projects', errorType: 'GitHubError' }));
    kit.told(kitFailed(3));
    expect(kit.states()).toEqual(['#1 open, 1 comment(s)', '#2 open, 0 comment(s)']);
    expect(kit.issues[1].title).toBe("A nightly run failed on the code reviewer's side");
  });

  it("names a lock that does not hold as the type of error, in the kit's repository", () => {
    const kit = new Place();
    kit.told(kitFailed(1, { kind: 'nightly', stage: 'starting', errorType: 'MachineLockError' }));
    expect(kit.issues[0].body).toContain('Type of error: `MachineLockError`');
  });

  it("names a run of the checks that met another one going, in the kit's repository", () => {
    const kit = new Place();
    kit.told(kitFailed(1, { kind: 'checks', stage: 'starting', errorType: 'ChecksRunningError' }));
    expect(kit.issues[0].body).toContain('Type of error: `ChecksRunningError`');
  });

  it("keeps the two sides apart where the kit's repository is also the project", () => {
    const kitAsProject = new Place();
    kitAsProject.told(kitFailed(1));
    kitAsProject.told(setupFailed(2));
    expect(kitAsProject.states()).toEqual(['#1 open, 0 comment(s)', '#2 open, 0 comment(s)']);
    kitAsProject.told(succeeded('project', 3));
    expect(kitAsProject.states()).toEqual(['#1 open, 0 comment(s)', '#2 closed, 1 comment(s)']);
  });

  it('does nothing at a success when no failure issue is open', () => {
    expect(new Place().told(succeeded('project', 1))).toEqual([]);
  });

  it('comments on the oldest and closes them all when more than one is open for the same kind', () => {
    const kit = new Place();
    kit.told(kitFailed(1));
    kit.file('', kit.issues[0].body, { authorType: 'Bot', authorAssociation: 'NONE' });
    expect(kit.told(kitFailed(2))).toMatchObject([{ action: 'comment', issue: 1 }]);
    kit.told(succeeded('kit', 3));
    expect(kit.states()).toEqual(['#1 closed, 2 comment(s)', '#2 closed, 1 comment(s)']);
  });

  it('does not take for its own an issue a passer-by wrote with the same first line', () => {
    const kit = new Place();
    const body = failureIssuePlan(kitFailed(1), [])[0].body;
    kit.file('not ours', body, { authorType: 'User', authorAssociation: 'NONE' });
    expect(kit.told(kitFailed(1))).toMatchObject([{ action: 'open' }]);
    expect(kit.told(succeeded('kit', 2))).toMatchObject([{ action: 'close', issue: 2 }]);
    expect(kit.states()).toEqual(['#1 open, 0 comment(s)', '#2 closed, 1 comment(s)']);
  });

  it('takes for its own one the owner opened by hand from an earlier body, as a run under the owner’s login does', () => {
    const kit = new Place();
    kit.file('', failureIssuePlan(kitFailed(1), [])[0].body, { authorType: 'User', authorAssociation: 'OWNER' });
    expect(kit.told(kitFailed(2))).toMatchObject([{ action: 'comment', issue: 1 }]);
  });

  it('does not take for its own an issue that only quotes the first line further down', () => {
    const project = new Place();
    const body = failureIssuePlan(setupFailed(1), [])[0].body;
    project.file('a ticket about the failure issue', `Why did this appear?\n\n${body}`, { authorType: 'User', authorAssociation: 'OWNER' });
    expect(project.told(setupFailed(2))).toMatchObject([{ action: 'open' }]);
  });

  it('keeps output that holds a code fence inside the code block', () => {
    const [open] = failureIssuePlan(setupFailed(1, 'before\n```\n@acme please look\n````\nafter'), []);
    const fences = open.body.split('\n').filter((line) => /^`{5,}$/.test(line));
    expect(fences).toHaveLength(2);
    expect(open.body).toContain('`````\nbefore\n```\n@acme please look\n````\nafter\n`````');
  });

  it("opens an issue in the project when the night's summary has no category to go in, and closes it once one is posted", () => {
    const noCategory: Report = {
      outcome: 'failed',
      side: 'project',
      facts: run(1, { kind: 'summary', stage: 'starting', errorType: 'MissingDiscussionCategoryError' }),
      tail: new MissingDiscussionCategoryError('acme/widgets', 'Code reviewer', true).message,
    };
    const project = new Place();
    project.told(setupFailed(1));
    project.told(noCategory);
    expect(project.states()).toEqual(['#1 open, 0 comment(s)', '#2 open, 0 comment(s)']);
    expect(project.issues[1].title).toBe("The code reviewer's nightly summary failed");
    expect(project.issues[1].body).toContain('no discussion category for the code reviewer');
    expect(project.issues[1].body).toContain('Create a discussion category named "Code reviewer"');
    project.told(succeeded('project', 2, { kind: 'summary' }));
    expect(project.states()).toEqual(['#1 open, 0 comment(s)', '#2 closed, 1 comment(s)']);
  });
});

describe("a project's nightly checks, as a kind of run of their own", () => {
  const tail = '--- canvas: failed (exit 1); the end of what it wrote ---\n3 boards differ from the code\n1 of 2 nightly checks failed: canvas';
  const checkFailed = (n: number): Report => ({
    outcome: 'failed',
    side: 'project',
    facts: run(n, { kind: 'checks', stage: 'checking', errorType: 'NightlyCheckError' }),
    tail,
  });

  it('a failing check opens the failure issue in the project, with the end of its output', () => {
    const project = new Place();
    project.told(checkFailed(1));
    expect(project.states()).toEqual(['#1 open, 0 comment(s)']);
    expect(project.issues[0].title).toBe("The code reviewer's run of the nightly checks failed");
    expect(project.issues[0].body).toContain("for a reason on the project's side: one of its nightly checks failed.");
    expect(project.issues[0].body).toContain('3 boards differ from the code');
    expect(project.issues[0].body).toContain('- Stage: `checking`');
    expect(project.issues[0].body).toContain('- Type of error: `NightlyCheckError`');
  });

  it("is beside the sweep's issue, not in it, and neither kind's success closes the other's", () => {
    const project = new Place();
    project.told(setupFailed(1));
    project.told(checkFailed(2));
    expect(project.states()).toEqual(['#1 open, 0 comment(s)', '#2 open, 0 comment(s)']);
    project.told(succeeded('project', 3));
    expect(project.states()).toEqual(['#1 closed, 1 comment(s)', '#2 open, 0 comment(s)']);
    project.told(checkFailed(4));
    expect(project.states()).toEqual(['#1 closed, 1 comment(s)', '#2 open, 1 comment(s)']);
    project.told(succeeded('project', 5, { kind: 'checks' }));
    expect(project.states()).toEqual(['#1 closed, 1 comment(s)', '#2 closed, 2 comment(s)']);
    expect(project.issues[1].comments[1]).toContain('a run of the nightly checks succeeded');
  });

  it("opens an issue in the kit's repository when the checks could not be run for a reason on the code reviewer's side", () => {
    const kit = new Place();
    kit.told(kitFailed(1, { kind: 'checks', stage: 'setup', errorType: 'Error' }));
    expect(kit.issues[0].title).toBe("A run of the nightly checks failed on the code reviewer's side");
    expect(kit.issues[0].body).toContain('- Stage: `setup`');
  });
});
