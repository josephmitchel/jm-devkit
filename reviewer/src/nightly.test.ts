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
