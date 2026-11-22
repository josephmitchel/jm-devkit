import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMMANDS } from './apps-machine.mjs';
import { appsMachine } from './test-helpers.mjs';

test('with no command, or one it does not have, it prints every command and exits 2', async () => {
  for (const argv of [[], ['nonsense'], ['toString']]) {
    const result = await appsMachine(argv);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.match(result.err, /^usage: apps-machine <command>\n/);
    for (const name of Object.keys(COMMANDS)) assert.match(result.err, new RegExp(`^  apps-machine ${name}\\b`, 'm'));
  }
});

test('every command says how it is used and what it does', () => {
  for (const [name, command] of Object.entries(COMMANDS)) {
    assert.match(command.usage, new RegExp(`^apps-machine ${name}\\b`));
    assert.ok(command.summary.length > 0, name);
    assert.equal(typeof command.command, 'function', name);
  }
});

test('anyone but root is refused', async () => {
  assert.deepEqual(await appsMachine(['list'], { uid: 1000 }), { code: 1, out: '', err: 'error: run with sudo\n' });
});
