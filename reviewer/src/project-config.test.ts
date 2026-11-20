import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DevkitConfigError,
  SCHEMA_PATH,
  parseDevkitConfig,
  validate,
  type JsonSchema,
} from '../../plugin/devkit-config.mjs';
import { readProjectSetup, type ProjectRow } from './project-config.js';

/** What a project registered by hand has in its database row. */
const row: ProjectRow = {
  setupCommand: 'make deps',
  testCommands: [{ name: 'row-suite', command: 'make check' }],
  redundancy: 3,
  harnessNotes: 'notes kept in the database',
  extraContext: 'context kept in the database',
};

let checkout: string;

beforeEach(() => {
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-config-'));
});

afterEach(() => {
  fs.rmSync(checkout, { recursive: true, force: true });
});

function writeConfig(config: unknown): void {
  const text = typeof config === 'string' ? config : JSON.stringify(config, null, 2);
  fs.writeFileSync(path.join(checkout, 'devkit.json'), text);
}

function setupError(): string {
  try {
    readProjectSetup(checkout, row);
  } catch (err) {
    expect(err).toBeInstanceOf(DevkitConfigError);
    return (err as Error).message;
  }
  throw new Error('expected readProjectSetup to refuse this devkit.json');
}

const valid = {
  modules: ['process'],
  sweep: { hour: 4 },
  reviewer: {
    setup: 'npm ci',
    tests: [
      { name: 'unit', command: 'npm test' },
      { name: 'db', command: 'npm run test:db' },
    ],
    env: { TEST_DATABASE_URL: 'postgres://localhost:5432/example_test' },
    databases: ['APP_DATABASE_URL', 'AUDIT_DATABASE_URL'],
    services: { postgres: { image: 'postgres:16', ports: ['5432:5432'] } },
    harnessNotes: 'docs/harness.md',
    redundancy: 2,
    extraContext: 'The example app has no UI.',
  },
  nightly: {
    checks: [
      { name: 'canvas', command: 'npm run canvas:check' },
      { name: 'links', command: 'npm run check:links' },
    ],
  },
};

describe('readProjectSetup with a devkit.json', () => {
  it('answers from the file, not the database row', () => {
    fs.mkdirSync(path.join(checkout, 'docs'));
    fs.writeFileSync(path.join(checkout, 'docs/harness.md'), '# Harness\nVitest, one file per module.\n');
    writeConfig(valid);

    expect(readProjectSetup(checkout, row)).toEqual({
      source: 'devkit.json',
      setupCommand: 'npm ci',
      testCommands: [
        { name: 'unit', command: 'npm test' },
        { name: 'db', command: 'npm run test:db' },
      ],
      redundancy: 2,
      harnessNotes: '# Harness\nVitest, one file per module.\n',
      extraContext: 'The example app has no UI.',
      env: { TEST_DATABASE_URL: 'postgres://localhost:5432/example_test' },
      databases: ['APP_DATABASE_URL', 'AUDIT_DATABASE_URL'],
      nightlyChecks: [
        { name: 'canvas', command: 'npm run canvas:check' },
        { name: 'links', command: 'npm run check:links' },
      ],
    });
  });

  it('takes a field the file leaves out as none, never as the row value', () => {
    writeConfig({ modules: ['process'], sweep: { hour: 0 }, reviewer: { tests: [{ name: 'unit', command: 'npm test' }] } });

    expect(readProjectSetup(checkout, row)).toEqual({
      source: 'devkit.json',
      setupCommand: null,
      testCommands: [{ name: 'unit', command: 'npm test' }],
      redundancy: 1,
      harnessNotes: null,
      extraContext: null,
      env: {},
      databases: [],
      nightlyChecks: [],
    });
  });

  it('takes a nightly section that lists no checks as naming none', () => {
    const reviewer = { tests: [{ name: 'unit', command: 'npm test' }] };
    writeConfig({ modules: ['process'], reviewer, nightly: {} });
    expect(readProjectSetup(checkout, row).nightlyChecks).toEqual([]);
    writeConfig({ modules: ['process'], reviewer, nightly: { checks: [] } });
    expect(readProjectSetup(checkout, row).nightlyChecks).toEqual([]);
  });

  it('accepts a file with no sweep section, now that there are no sweep slots', () => {
    writeConfig({ modules: ['process'], reviewer: { tests: [{ name: 'unit', command: 'npm test' }] } });
    expect(readProjectSetup(checkout, row).source).toBe('devkit.json');
  });

  it('accepts the retired sweep.hour and reviewer.services, and takes nothing from them', () => {
    const tests = [{ name: 'unit', command: 'npm test' }];
    writeConfig({ modules: ['process'], reviewer: { tests } });
    const without = readProjectSetup(checkout, row);
    writeConfig({
      modules: ['process'],
      sweep: { hour: 7 },
      reviewer: { tests, services: { postgres: { image: 'postgres:16' } } },
    });
    expect(readProjectSetup(checkout, row)).toEqual(without);
  });
});

describe('readProjectSetup without a devkit.json', () => {
  it('answers from the database row, with no databases and no nightly checks', () => {
    expect(readProjectSetup(checkout, row)).toEqual({ source: 'database', ...row, env: {}, databases: [], nightlyChecks: [] });
  });
});

describe('readProjectSetup with a malformed devkit.json', () => {
  it('names a test command that is missing its command', () => {
    writeConfig({ ...valid, reviewer: { tests: [{ name: 'unit' }] } });
    expect(setupError()).toContain('reviewer.tests[0].command is required');
  });

  it('names an unknown field, at the top level and in the reviewer section', () => {
    writeConfig({ ...valid, sweeep: { hour: 1 }, reviewer: { ...valid.reviewer, harnesNotes: 'x.md' } });
    const message = setupError();
    expect(message).toContain('sweeep is not a known field');
    expect(message).toContain('reviewer.harnesNotes is not a known field');
  });

  it('names a value of the wrong type or out of range', () => {
    writeConfig({ ...valid, sweep: { hour: 24 }, reviewer: { ...valid.reviewer, redundancy: '2' } });
    const message = setupError();
    expect(message).toContain('sweep.hour must be at most 23');
    expect(message).toContain('reviewer.redundancy must be an integer');
  });

  it('names an empty list of tests and an env value that is not a string', () => {
    writeConfig({ ...valid, reviewer: { tests: [], env: { PORT: 5432 } } });
    const message = setupError();
    expect(message).toContain('reviewer.tests must have at least 1 item');
    expect(message).toContain('reviewer.env.PORT must be a string');
  });

  it('names a database variable that is not a name, or is listed twice', () => {
    writeConfig({ ...valid, reviewer: { tests: valid.reviewer.tests, databases: ['APP_DB', 'APP-DB', 'APP_DB', 7] } });
    const message = setupError();
    expect(message).toContain('reviewer.databases[1] must match');
    expect(message).toContain('reviewer.databases lists "APP_DB" more than once');
    expect(message).toContain('reviewer.databases[3] must be a string');
  });

  it('names a nightly check that is missing its command, has no name, or carries a field it does not know', () => {
    writeConfig({
      ...valid,
      nightly: { checks: [{ name: 'canvas' }, { name: '', command: 'npm run check:links' }, { name: 'slow', command: 'make slow', hour: 3 }] },
    });
    const message = setupError();
    expect(message).toContain('nightly.checks[0].command is required');
    expect(message).toContain('nightly.checks[1].name must not be empty');
    expect(message).toContain('nightly.checks[2].hour is not a known field');
  });

  it('names nightly checks that are not a list, a second check of the same name, and an unknown nightly field', () => {
    writeConfig({ ...valid, nightly: { checks: 'npm run canvas:check', check: [] } });
    const message = setupError();
    expect(message).toContain('nightly.checks must be an array');
    expect(message).toContain('nightly.check is not a known field');

    const canvas = { name: 'canvas', command: 'npm run canvas:check' };
    writeConfig({ ...valid, nightly: { checks: [canvas, canvas] } });
    expect(setupError()).toContain('nightly.checks lists {"name":"canvas","command":"npm run canvas:check"} more than once');
  });

  it('names a missing section and modules without the process module', () => {
    writeConfig({ modules: ['web'], sweep: { hour: 1 } });
    const message = setupError();
    expect(message).toContain('reviewer is required');
    expect(message).toContain('modules must include "process"');
  });

  it('says so when the file is not JSON at all', () => {
    writeConfig('{ "modules": ["process"], }');
    expect(setupError()).toContain('devkit.json is not valid JSON');
  });
});

describe('readProjectSetup with harness notes that are not there', () => {
  it('names the field and the path when the file is missing', () => {
    writeConfig(valid);
    expect(setupError()).toBe(
      'devkit.json: reviewer.harnessNotes points at docs/harness.md, which is not a file in the project',
    );
  });

  it('refuses a path that leaves the project', () => {
    writeConfig({ ...valid, reviewer: { ...valid.reviewer, harnessNotes: '../outside.md' } });
    expect(setupError()).toContain('reviewer.harnessNotes must be a path inside the project');
  });

  it('refuses a symlink that leads out of the project', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.md'), 'not the project\'s');
      fs.mkdirSync(path.join(checkout, 'docs'));
      fs.symlinkSync(path.join(outside, 'secret.md'), path.join(checkout, 'docs/harness.md'));
      writeConfig(valid);
      expect(setupError()).toContain('reviewer.harnessNotes must be a path inside the project');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('the devkit.json schema', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as JsonSchema & { examples: unknown[] };

  it("accepts the kit's own devkit.json", () => {
    const kitConfig = path.resolve(path.dirname(SCHEMA_PATH), '..', 'devkit.json');
    const config = parseDevkitConfig(fs.readFileSync(kitConfig, 'utf8'));
    expect(config.modules).toContain('process');
    expect(config.reviewer.tests.map((t) => t.name)).toEqual(['reviewer', 'plugin']);
  });

  it('accepts each of its own examples', () => {
    expect(schema.examples.length).toBeGreaterThan(0);
    for (const example of schema.examples) expect(validate(schema, example, '')).toEqual([]);
  });

  it('uses only keywords the validator enforces', () => {
    // validate() throws on a keyword it does not know; an empty object reaches every subschema
    // only if something walks them, so walk them here.
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object' || node === null) return;
      const s = node as Record<string, unknown>;
      expect(() => validate(s as JsonSchema, Symbol('probe'), '')).not.toThrow();
      for (const key of ['properties', 'additionalProperties', 'propertyNames', 'items', 'contains']) {
        const child = s[key];
        if (key === 'properties' && child) Object.values(child).forEach(walk);
        else if (typeof child === 'object') walk(child);
      }
    };
    walk(schema);
  });
});
