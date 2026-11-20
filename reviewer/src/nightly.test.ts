import { describe, expect, it } from 'vitest';

import { nightlyDecision, nightlyWork, notStartedResult, type Step } from './nightly.js';
import { classifyProjects } from './projects.js';

const config = JSON.stringify({
  modules: ['process'],
  sweep: { hour: 4 },
  reviewer: { tests: [{ name: 'unit', command: 'npm test' }] },
});

describe("the nightly run's order of work", () => {
  it("sweeps the handled projects in name order, posting each one's summary after its sweep, and says why it skips the others", () => {
    const projects = classifyProjects([
      { slug: 'acme/widgets', config, sweepWorkflow: false },
      { slug: 'acme/gadgets', config, sweepWorkflow: true },
      { slug: 'Acme/bare', config: null, sweepWorkflow: false },
      { slug: 'acme/anvils', config, sweepWorkflow: false },
    ]);
    expect(nightlyWork(projects)).toEqual({
      steps: [
        { project: 'acme/anvils', kind: 'sweep' },
        { project: 'acme/anvils', kind: 'summary' },
        { project: 'acme/widgets', kind: 'sweep' },
        { project: 'acme/widgets', kind: 'summary' },
      ],
      skipped: [
        'Acme/bare skipped: its default branch has no devkit.json',
        'acme/gadgets still on Actions: its default branch has .github/workflows/nightly-sweep.yml',
      ],
    });
  });
});

describe("a project's nightly checks in the order of work", () => {
  const naming = (checks: unknown) =>
    JSON.stringify({ modules: ['process'], reviewer: { tests: [{ name: 'unit', command: 'npm test' }] }, nightly: { checks } });
  const canvas = { name: 'canvas', command: 'npm run canvas:check' };
  const links = { name: 'links', command: 'npm run check:links' };

  it('come after that project\'s sweep and its summary, as one step, and only for a project that names some', () => {
    const projects = classifyProjects([
      { slug: 'acme/zippers', config: naming([]), sweepWorkflow: false },
      { slug: 'acme/widgets', config: naming([canvas, links]), sweepWorkflow: false },
      { slug: 'acme/anvils', config, sweepWorkflow: false },
      { slug: 'acme/gadgets', config: naming([canvas]), sweepWorkflow: true },
    ]);
    expect(nightlyWork(projects).steps).toEqual([
      { project: 'acme/anvils', kind: 'sweep' },
      { project: 'acme/anvils', kind: 'summary' },
      { project: 'acme/widgets', kind: 'sweep' },
      { project: 'acme/widgets', kind: 'summary' },
      { project: 'acme/widgets', kind: 'checks' },
      { project: 'acme/zippers', kind: 'sweep' },
      { project: 'acme/zippers', kind: 'summary' },
    ]);
  });

  const steps: Step[] = [
    { project: 'acme/widgets', kind: 'sweep' },
    { project: 'acme/widgets', kind: 'summary' },
    { project: 'acme/widgets', kind: 'checks' },
    { project: 'acme/zippers', kind: 'sweep' },
  ];
  const checks = { next: { project: 'acme/widgets', kind: 'checks' } };

  it('run after a sweep that succeeded', () => {
    expect(nightlyDecision(steps, ['succeeded', 'succeeded'])).toEqual(checks);
  });

  it('still run after a sweep that failed or was stopped by its time limit: they are the project\'s own, and the sweep says nothing about them', () => {
    expect(nightlyDecision(steps, ['failed', 'succeeded'])).toEqual(checks);
    expect(nightlyDecision(steps, ['interrupted', 'succeeded'])).toEqual(checks);
    expect(nightlyDecision(steps, ['succeeded', 'failed'])).toEqual(checks);
  });

  it('do not stop the next project when they fail, and the night ends failed', () => {
    expect(nightlyDecision(steps, ['succeeded', 'succeeded', 'failed'])).toEqual({ next: { project: 'acme/zippers', kind: 'sweep' } });
    expect(nightlyDecision(steps, ['succeeded', 'succeeded', 'failed', 'succeeded'])).toEqual({ done: 'failed' });
  });

  it('are not started once the service is stopping', () => {
    expect(nightlyDecision(steps, ['succeeded', 'succeeded'], true)).toEqual({ done: 'interrupted' });
  });
});

describe('what a nightly run does next', () => {
  const steps: Step[] = [
    { project: 'acme/anvils', kind: 'sweep' },
    { project: 'acme/widgets', kind: 'sweep' },
    { project: 'acme/zippers', kind: 'sweep' },
  ];

  it('starts with the first project and takes one step at a time', () => {
    expect(nightlyDecision(steps, [])).toEqual({ next: { project: 'acme/anvils', kind: 'sweep' } });
    expect(nightlyDecision(steps, ['succeeded'])).toEqual({ next: { project: 'acme/widgets', kind: 'sweep' } });
  });

  it('carries on to the next project after a sweep that failed', () => {
    expect(nightlyDecision(steps, ['failed'])).toEqual({ next: { project: 'acme/widgets', kind: 'sweep' } });
    expect(nightlyDecision(steps, ['failed', 'failed'])).toEqual({ next: { project: 'acme/zippers', kind: 'sweep' } });
  });

  it('ends succeeded when every step did', () => {
    expect(nightlyDecision(steps, ['succeeded', 'succeeded', 'succeeded'])).toEqual({ done: 'succeeded' });
  });

  it('ends failed when any step failed, wherever it was', () => {
    expect(nightlyDecision(steps, ['failed', 'succeeded', 'succeeded'])).toEqual({ done: 'failed' });
    expect(nightlyDecision(steps, ['succeeded', 'succeeded', 'failed'])).toEqual({ done: 'failed' });
  });

  it("carries on after a sweep its time limit stopped, and ends failed: that project's night is not done", () => {
    expect(nightlyDecision(steps, ['interrupted'])).toEqual({ next: { project: 'acme/widgets', kind: 'sweep' } });
    expect(nightlyDecision(steps, ['interrupted', 'succeeded', 'succeeded'])).toEqual({ done: 'failed' });
  });

  it('takes no further step once the service is stopping, and ends interrupted', () => {
    expect(nightlyDecision(steps, ['succeeded', 'interrupted'], true)).toEqual({ done: 'interrupted' });
    expect(nightlyDecision(steps, ['succeeded'], true)).toEqual({ done: 'interrupted' });
    expect(nightlyDecision(steps, [], true)).toEqual({ done: 'interrupted' });
  });

  it('ends as it would have when the stop came after the last step had finished', () => {
    expect(nightlyDecision(steps, ['succeeded', 'succeeded', 'succeeded'], true)).toEqual({ done: 'succeeded' });
    expect(nightlyDecision(steps, ['succeeded', 'failed', 'succeeded'], true)).toEqual({ done: 'failed' });
  });

  it('ends succeeded at once on a night with no handled project', () => {
    expect(nightlyDecision([], [])).toEqual({ done: 'succeeded' });
  });
});

describe('a nightly run that could not start, because the code reviewer could not be brought up to date', () => {
  it('is a failed run, in the step of the update that failed', () => {
    expect(notStartedResult('installing dependencies', 'exit 3')).toEqual({
      state: 'failed',
      stage: 'installing dependencies',
      errorType: 'exit 3',
    });
    expect(notStartedResult('moving the checkout', 'killed by SIGTERM')).toMatchObject({ errorType: 'killed by SIGTERM' });
    expect(notStartedResult('applying migrations', 'could not start')).toMatchObject({ stage: 'applying migrations' });
  });

  it('is not recorded with a stage or a type of error that is not one of the fixed ones', () => {
    expect(notStartedResult('auditing', 'exit 1')).toBeNull();
    expect(notStartedResult('installing dependencies', 'npm error 404 for @acme/widgets')).toBeNull();
  });
});
