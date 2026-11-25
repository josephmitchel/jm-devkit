import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DevkitConfigError,
  SCHEMA_PATH,
  parseDeployConfig,
  parseDevkitConfig,
  validate,
  type JsonSchema,
} from '../../plugin/devkit-config.mjs';
import { projectFault } from './failure-side.js';
import { readProjectSetup } from './project-config.js';
import { errorType } from './run-vocabulary.js';

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
    readProjectSetup(checkout);
  } catch (err) {
    expect(err).toBeInstanceOf(DevkitConfigError);
    return (err as Error).message;
  }
  throw new Error('expected readProjectSetup to refuse this devkit.json');
}

const valid = {
  modules: ['process'],
  reviewer: {
    setup: 'npm ci',
    tests: [
      { name: 'unit', command: 'npm test' },
      { name: 'db', command: 'npm run test:db' },
    ],
    env: { TEST_DATABASE_URL: 'postgres://localhost:5432/example_test' },
    databases: ['APP_DATABASE_URL', 'AUDIT_DATABASE_URL'],
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
  it('answers from the file', () => {
    fs.mkdirSync(path.join(checkout, 'docs'));
    fs.writeFileSync(path.join(checkout, 'docs/harness.md'), '# Harness\nVitest, one file per module.\n');
    writeConfig(valid);

    expect(readProjectSetup(checkout)).toEqual({
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

  it('takes a field the file leaves out as none', () => {
    writeConfig({ modules: ['process'], reviewer: { tests: [{ name: 'unit', command: 'npm test' }] } });

    expect(readProjectSetup(checkout)).toEqual({
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
    expect(readProjectSetup(checkout).nightlyChecks).toEqual([]);
    writeConfig({ modules: ['process'], reviewer, nightly: { checks: [] } });
    expect(readProjectSetup(checkout).nightlyChecks).toEqual([]);
  });

  it('accepts a file with no sweep section, now that there are no sweep slots', () => {
    writeConfig({ modules: ['process'], reviewer: { tests: [{ name: 'unit', command: 'npm test' }] } });
    expect(readProjectSetup(checkout).testCommands).toEqual([{ name: 'unit', command: 'npm test' }]);
  });

  it('refuses the retired sweep and reviewer.services, saying to remove each', () => {
    writeConfig({ ...valid, sweep: { hour: 7 }, reviewer: { ...valid.reviewer, services: { postgres: { image: 'postgres:16' } } } });
    const message = setupError();
    expect(message).toContain('sweep is retired: remove it from devkit.json');
    expect(message).toContain('reviewer.services is retired: remove it from devkit.json, and name in reviewer.databases');
    expect(message).not.toContain('not a known field');
  });
});

describe('readProjectSetup for a project not under the kit', () => {
  it('refuses a project with no devkit.json, naming install', () => {
    expect(setupError()).toMatch(/no devkit\.json: run \/devkit:install in the project/);
  });

  it('refuses a project with no devkit.json as not under the kit, not as having an invalid one', () => {
    let thrown: unknown;
    try {
      readProjectSetup(checkout);
    } catch (err) {
      thrown = err;
    }
    expect(errorType(thrown)).toBe('NotUnderKitError');
    expect(projectFault(errorType(thrown))).toMatch(/has no project config \(`devkit\.json`\).*\/devkit:install/);
  });

  it('refuses a devkit.json whose modules leave out process, naming install', () => {
    writeConfig({ ...valid, modules: ['web'] });
    expect(setupError()).toMatch(/modules must include "process".*: run \/devkit:install in the project/);
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
    writeConfig({ ...valid, reviewer: { ...valid.reviewer, redundancy: '2' } });
    expect(setupError()).toContain('reviewer.redundancy must be an integer');
    writeConfig({ ...valid, reviewer: { ...valid.reviewer, redundancy: 0 } });
    expect(setupError()).toContain('reviewer.redundancy must be at least 1');
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

  it('names a second nightly check of the same name, though its command differs: results are reported by name', () => {
    const canvas = { name: 'canvas', command: 'npm run canvas:check' };
    writeConfig({ ...valid, nightly: { checks: [canvas, { name: 'links', command: 'npm run check:links' }, { name: 'canvas', command: 'npm run canvas:all' }] } });
    expect(setupError()).toContain('nightly.checks has more than one item whose name is "canvas"');
    // Two names for one command are two checks.
    const twoNames = { modules: ['process'], reviewer: { tests: valid.reviewer.tests }, nightly: { checks: [canvas, { ...canvas, name: 'boards' }] } };
    expect(() => parseDevkitConfig(JSON.stringify(twoNames))).not.toThrow();
  });

  it('names a missing section and modules without the process module', () => {
    writeConfig({ modules: ['web'] });
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

const deploy = {
  setup: 'npm ci',
  build: 'npm run build',
  start: 'npm start',
  port: 3000,
  healthPath: '/healthz',
};

function withDeploy(section: unknown): string {
  return JSON.stringify({ modules: ['process'], reviewer: { tests: valid.reviewer.tests }, deploy: section });
}

function deployErrors(section: unknown): string[] {
  try {
    parseDeployConfig(withDeploy(section));
  } catch (err) {
    expect(err).toBeInstanceOf(DevkitConfigError);
    return (err as DevkitConfigError).errors;
  }
  return [];
}

describe('the deploy section of a devkit.json', () => {
  it('is returned as written, with a migrate command or without one', () => {
    expect(parseDeployConfig(withDeploy(deploy))).toEqual(deploy);
    const migrating = { ...deploy, migrate: 'npm run migrate' };
    expect(parseDeployConfig(withDeploy(migrating))).toEqual(migrating);
  });

  it('is none for a project that does not declare one, which is still a valid project', () => {
    expect(parseDeployConfig(withDeploy(undefined))).toBeNull();
  });

  it('names each required field a section leaves out, and asks for no migrate command', () => {
    expect(deployErrors({})).toEqual([
      'deploy.setup is required',
      'deploy.build is required',
      'deploy.start is required',
      'deploy.port is required',
      'deploy.healthPath is required',
    ]);
  });

  it('names a port that is not a port a program can listen on', () => {
    expect(deployErrors({ ...deploy, port: 0 })).toEqual(['deploy.port must be at least 1']);
    expect(deployErrors({ ...deploy, port: 65536 })).toEqual(['deploy.port must be at most 65535']);
    expect(deployErrors({ ...deploy, port: 3000.5 })).toEqual(['deploy.port must be an integer']);
    expect(deployErrors({ ...deploy, port: '3000' })).toEqual(['deploy.port must be an integer']);
    expect(deployErrors({ ...deploy, port: 65535 })).toEqual([]);
  });

  it('names a health path that is not a path', () => {
    for (const healthPath of ['healthz', 'http://127.0.0.1:3000/healthz', '', '/health z']) {
      const errors = deployErrors({ ...deploy, healthPath });
      expect(errors, healthPath).toHaveLength(1);
      expect(errors[0], healthPath).toMatch(/^deploy\.healthPath must /);
    }
    expect(deployErrors({ ...deploy, healthPath: '/' })).toEqual([]);
    expect(deployErrors({ ...deploy, healthPath: '/api/health?deep=1' })).toEqual([]);
  });

  it('names an empty command, a command that is not text, and a field it does not know', () => {
    expect(deployErrors({ ...deploy, setup: '', build: ['npm', 'run', 'build'], migrate: '', healthCheck: '/healthz' })).toEqual([
      'deploy.setup must not be empty',
      'deploy.build must be a string',
      'deploy.migrate must not be empty',
      'deploy.healthCheck is not a known field',
    ]);
    expect(deployErrors({ ...deploy, start: '' })).toEqual(['deploy.start must not be empty']);
    expect(deployErrors('npm start')).toEqual(['deploy must be an object']);
  });

  it('changes nothing about how the code reviewer sets the project up and tests it', () => {
    const config = { modules: ['process'], reviewer: { tests: valid.reviewer.tests }, nightly: valid.nightly };
    writeConfig(config);
    const without = readProjectSetup(checkout);
    writeConfig({ ...config, deploy: { ...deploy, migrate: 'npm run migrate' } });
    expect(readProjectSetup(checkout)).toEqual(without);
  });

  it('fails a run of the code reviewer when it is malformed, as any other section does', () => {
    writeConfig({ modules: ['process'], reviewer: { tests: valid.reviewer.tests }, deploy: { ...deploy, port: 0 } });
    expect(setupError()).toBe('devkit.json is malformed: deploy.port must be at least 1');
  });
});

describe('the devkit.json schema', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as JsonSchema & { examples: unknown[] };

  it("accepts the kit's own devkit.json", () => {
    const kitConfig = path.resolve(path.dirname(SCHEMA_PATH), '..', 'devkit.json');
    const config = parseDevkitConfig(fs.readFileSync(kitConfig, 'utf8'));
    expect(config.modules).toContain('process');
    expect(config.reviewer.tests.map((t) => t.name)).toEqual(['reviewer', 'plugin', 'apps-machine']);
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
