import { test } from 'node:test';
import assert from 'node:assert/strict';

import path from 'node:path';

import { COMMANDS } from './apps-machine.mjs';
import { run } from './run.mjs';
import { appsMachine, machine, registered } from './test-helpers.mjs';

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

test('a command interrupted while a program runs is not killed: it ends as a failure that says so', () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  const from = (file) => JSON.stringify(path.join(import.meta.dirname, file));
  const program = `import { start } from ${from('apps-machine.mjs')};
    import { machinePaths } from ${from('paths.mjs')};
    import { run } from ${from('run.mjs')};
    const journalctl = () => run('/bin/sh', ['-c', 'kill -INT 0; sleep 30']);
    console.log('exit', await start(['logs', 'sample'], { uid: 0, paths: machinePaths(${JSON.stringify(paths.root)}), run: journalctl }));`;
  const done = run('setsid', ['--wait', process.execPath, '--input-type=module', '-e', program]);
  assert.deepEqual(done, { code: 0, stdout: 'exit 1\n', stderr: 'error: interrupted by SIGINT\n' });
});
