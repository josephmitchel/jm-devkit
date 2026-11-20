import { describe, expect, it } from 'vitest';

import { nightlyDecision, nightlyWork, type Step } from './nightly.js';
import { classifyProjects } from './projects.js';

const config = JSON.stringify({
  modules: ['process'],
  sweep: { hour: 4 },
  reviewer: { tests: [{ name: 'unit', command: 'npm test' }] },
});

describe("the nightly run's order of work", () => {
  it('sweeps the handled projects in name order and says why it skips the others', () => {
    const projects = classifyProjects([
      { slug: 'acme/widgets', config, sweepWorkflow: false },
      { slug: 'acme/gadgets', config, sweepWorkflow: true },
      { slug: 'Acme/bare', config: null, sweepWorkflow: false },
      { slug: 'acme/anvils', config, sweepWorkflow: false },
    ]);
    expect(nightlyWork(projects)).toEqual({
      steps: [
        { project: 'acme/anvils', kind: 'sweep' },
        { project: 'acme/widgets', kind: 'sweep' },
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

  it('come straight after that project\'s sweep, as one step, and only for a project that names some', () => {
    const projects = classifyProjects([
      { slug: 'acme/zippers', config: naming([]), sweepWorkflow: false },
      { slug: 'acme/widgets', config: naming([canvas, links]), sweepWorkflow: false },
      { slug: 'acme/anvils', config, sweepWorkflow: false },
      { slug: 'acme/gadgets', config: naming([canvas]), sweepWorkflow: true },
    ]);
    expect(nightlyWork(projects).steps).toEqual([
      { project: 'acme/anvils', kind: 'sweep' },
      { project: 'acme/widgets', kind: 'sweep' },
      { project: 'acme/widgets', kind: 'checks' },
      { project: 'acme/zippers', kind: 'sweep' },
    ]);
  });

  const steps: Step[] = [
    { project: 'acme/widgets', kind: 'sweep' },
    { project: 'acme/widgets', kind: 'checks' },
    { project: 'acme/zippers', kind: 'sweep' },
  ];

  it('run after a sweep that succeeded', () => {
    expect(nightlyDecision(steps, ['succeeded'])).toEqual({ next: { project: 'acme/widgets', kind: 'checks' } });
  });

  it('still run after a sweep that failed: they are the project\'s own, and the sweep failing says nothing about them', () => {
    expect(nightlyDecision(steps, ['failed'])).toEqual({ next: { project: 'acme/widgets', kind: 'checks' } });
  });

  it('do not stop the next project when they fail, and the night ends failed', () => {
    expect(nightlyDecision(steps, ['succeeded', 'failed'])).toEqual({ next: { project: 'acme/zippers', kind: 'sweep' } });
    expect(nightlyDecision(steps, ['succeeded', 'failed', 'succeeded'])).toEqual({ done: 'failed' });
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

  it('ends succeeded at once on a night with no handled project', () => {
    expect(nightlyDecision([], [])).toEqual({ done: 'succeeded' });
  });
});
