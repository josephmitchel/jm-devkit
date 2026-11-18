import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./house-rules.mjs', import.meta.url));

function run(event) {
  return JSON.parse(execFileSync('node', [script], { input: JSON.stringify(event) }));
}

for (const hook_event_name of ['SessionStart', 'SubagentStart']) {
  test(`${hook_event_name} gets the house rules as additional context`, () => {
    const out = run({ hook_event_name, session_id: 'test' });
    assert.equal(out.hookSpecificOutput.hookEventName, hook_event_name);
    for (const heading of ['## Git', '## Comments', '## Code intelligence', '## Closing tickets']) {
      assert.ok(out.hookSpecificOutput.additionalContext.includes(heading), heading);
    }
  });
}
