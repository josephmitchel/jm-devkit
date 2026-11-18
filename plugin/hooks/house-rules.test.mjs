import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SWEEP_WORKFLOW, generate } from '../generator/generate.mjs';
import { NUDGE } from './house-rules.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(pluginRoot, 'hooks', 'house-rules.mjs');
const rules = fs.readFileSync(path.join(pluginRoot, 'house-rules.md'), 'utf8');

const config = {
  modules: ['process'],
  kit: '0123456789ab',
  sweep: { hour: 3 },
  reviewer: { tests: [{ name: 'unit', command: 'npm test' }] },
};

const dirs = [];
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-hook-'));
  dirs.push(dir);
  return dir;
}

/** A project holding `devkitJson` (text, or an object to serialise) and `files`. */
function project(devkitJson, files = {}) {
  const dir = tempDir();
  if (devkitJson !== undefined) {
    const text = typeof devkitJson === 'string' ? devkitJson : JSON.stringify(devkitJson, null, 2);
    fs.writeFileSync(path.join(dir, 'devkit.json'), text);
  }
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), contents);
  }
  return dir;
}

const level = () => project(config, generate(config));
const behind = () => project(config, { [SWEEP_WORKFLOW]: `${generate(config)[SWEEP_WORKFLOW]}# a hand edit\n` });

function run(event, hook = script) {
  return JSON.parse(execFileSync('node', [hook], { input: JSON.stringify(event) }));
}

function assertRulesOnly(out, hook_event_name) {
  assert.equal(out.hookSpecificOutput.hookEventName, hook_event_name);
  assert.equal(out.hookSpecificOutput.additionalContext, rules);
  assert.equal(out.systemMessage, undefined);
}

for (const hook_event_name of ['SessionStart', 'SubagentStart']) {
  test(`${hook_event_name} gets the house rules as additional context`, () => {
    const out = run({ hook_event_name, session_id: 'test', cwd: tempDir() });
    assert.equal(out.hookSpecificOutput.hookEventName, hook_event_name);
    for (const heading of ['## Git', '## Comments', '## Code intelligence', '## Closing tickets']) {
      assert.ok(out.hookSpecificOutput.additionalContext.includes(heading), heading);
    }
  });
}

test('a session in a project behind the kit tells the user in one line, and Claude too', () => {
  const out = run({ hook_event_name: 'SessionStart', source: 'startup', cwd: behind() });
  assert.equal(out.systemMessage, NUDGE);
  assert.ok(!NUDGE.includes('\n'));
  assert.ok(NUDGE.includes('/devkit:sync'));
  assert.equal(out.hookSpecificOutput.additionalContext, `${rules}\n${NUDGE}\n`);
});

test('a missing kit-owned file is behind too', () => {
  const out = run({ hook_event_name: 'SessionStart', cwd: project(config) });
  assert.equal(out.systemMessage, NUDGE);
});

test('a level project gets no nudge', () => {
  assertRulesOnly(run({ hook_event_name: 'SessionStart', cwd: level() }), 'SessionStart');
});

test('a directory with no devkit.json gets no nudge', () => {
  assertRulesOnly(run({ hook_event_name: 'SessionStart', cwd: tempDir() }), 'SessionStart');
});

test('an invalid devkit.json gets no nudge, and the house rules still arrive', () => {
  for (const devkitJson of ['{ not json', JSON.stringify({ modules: ['web'], sweep: { hour: 99 } })]) {
    assertRulesOnly(run({ hook_event_name: 'SessionStart', cwd: project(devkitJson) }), 'SessionStart');
  }
});

test('a subagent in a project behind the kit is never nudged', () => {
  assertRulesOnly(run({ hook_event_name: 'SubagentStart', agent_type: 'general-purpose', cwd: behind() }), 'SubagentStart');
});

test('the kit commit recorded in devkit.json does not decide whether a project is behind', () => {
  const recorded = { ...config, kit: 'fedcba987654' };
  const dir = project(recorded, generate(config));
  assertRulesOnly(run({ hook_event_name: 'SessionStart', cwd: dir }), 'SessionStart');
});

// A copy of the plugin's runtime pieces, with the generator edited by `edit`, stands in for a kit
// that has moved on since the project last synced.
function kitWith(edit) {
  const root = tempDir();
  for (const relative of ['hooks/house-rules.mjs', 'generator/generate.mjs', 'devkit-config.mjs', 'devkit.schema.json', 'house-rules.md']) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.copyFileSync(path.join(pluginRoot, relative), path.join(root, relative));
  }
  const generator = path.join(root, 'generator', 'generate.mjs');
  const before = fs.readFileSync(generator, 'utf8');
  const changed = edit(before);
  assert.notEqual(changed, before, 'the edit changed nothing in the generator');
  fs.writeFileSync(generator, changed);
  return path.join(root, 'hooks', 'house-rules.mjs');
}

test('a kit change that leaves the project\'s files as they were produces no nudge', () => {
  const hook = kitWith((source) => source.replace('const USAGE =', '// A change to the kit that writes nothing new.\nconst USAGE ='));
  assertRulesOnly(run({ hook_event_name: 'SessionStart', cwd: level() }, hook), 'SessionStart');
});

test('a kit change that rewrites the project\'s files nudges', () => {
  const hook = kitWith((source) => source.replace('timeout-minutes: 10', 'timeout-minutes: 15'));
  const out = run({ hook_event_name: 'SessionStart', cwd: level() }, hook);
  assert.equal(out.systemMessage, NUDGE);
});

test('a generator that fails to load costs the nudge, not the house rules', () => {
  const hook = kitWith((source) => `${source}\n}\n`);
  assertRulesOnly(run({ hook_event_name: 'SessionStart', cwd: behind() }, hook), 'SessionStart');
});
