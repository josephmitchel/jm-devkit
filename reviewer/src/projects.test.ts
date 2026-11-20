import { describe, expect, it } from 'vitest';

import { classifyProjects, projectLine, projectState } from './projects.js';

const config = JSON.stringify({
  modules: ['process'],
  sweep: { hour: 4 },
  reviewer: { tests: [{ name: 'unit', command: 'npm test' }] },
});

describe('projectState', () => {
  it('is handled with a project config and no sweep workflow', () => {
    expect(projectState({ config, sweepWorkflow: false })).toEqual({ state: 'handled' });
  });

  it('is still on Actions while the sweep workflow is there, whatever else it has', () => {
    const onActions = {
      state: 'still on Actions',
      reason: 'its default branch has .github/workflows/nightly-sweep.yml',
    };
    expect(projectState({ config, sweepWorkflow: true })).toEqual(onActions);
    expect(projectState({ config: null, sweepWorkflow: true })).toEqual(onActions);
    expect(projectState({ config: '{"modules":[]}', sweepWorkflow: true })).toEqual(onActions);
  });

  it('is skipped with no project config', () => {
    expect(projectState({ config: null, sweepWorkflow: false })).toEqual({
      state: 'skipped',
      reason: 'its default branch has no devkit.json',
    });
  });

  it('is skipped with a project config that is not valid, saying what is wrong with it', () => {
    expect(projectState({ config: '{"modules":["process"],"sweep":{"hour":4}}', sweepWorkflow: false })).toEqual({
      state: 'skipped',
      reason: 'devkit.json is malformed: reviewer is required',
    });
    const unparsable = projectState({ config: 'not json', sweepWorkflow: false });
    expect(unparsable.state).toBe('skipped');
    expect(unparsable).toHaveProperty('reason', expect.stringMatching(/^devkit\.json is not valid JSON: /));
  });
});

describe('the list of projects', () => {
  it('is one line per project, in name order, with the reason when it is not handled', () => {
    const projects = classifyProjects([
      { slug: 'acme/widgets', config, sweepWorkflow: false },
      { slug: 'acme/gadgets', config, sweepWorkflow: true },
      { slug: 'Acme/bare', config: null, sweepWorkflow: false },
      { slug: 'acme/anvils', config, sweepWorkflow: false },
    ]);
    expect(projects.map(projectLine)).toEqual([
      'acme/anvils handled',
      'Acme/bare skipped: its default branch has no devkit.json',
      'acme/gadgets still on Actions: its default branch has .github/workflows/nightly-sweep.yml',
      'acme/widgets handled',
    ]);
  });

  it('keeps a reason that spans lines on the one line', () => {
    const [project] = classifyProjects([{ slug: 'acme/widgets', config: '{\n  "modules": x\n}', sweepWorkflow: false }]);
    expect(projectLine(project)).toMatch(/^acme\/widgets skipped: devkit\.json is not valid JSON: [^\n]+$/);
  });
});
