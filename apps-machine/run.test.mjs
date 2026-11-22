import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './run.mjs';
import { tempDir } from './test-helpers.mjs';

const HOME = import.meta.dirname;
const node = process.execPath;

test('run gives back what the program printed and how it ended', () => {
  const script = 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)';
  assert.deepEqual(run(node, ['-e', script]), { code: 3, stdout: 'out', stderr: 'err' });
});

test('input reaches the program on its stdin', () => {
  const script = 'process.stdin.pipe(process.stdout)';
  assert.equal(run(node, ['-e', script], { input: 'a secret\n' }).stdout, 'a secret\n');
});

test('env is the program\'s whole environment, and cwd is where it runs', () => {
  const cwd = fs.realpathSync(tempDir());
  const script = 'console.log(JSON.stringify({ env: process.env, cwd: process.cwd() }))';
  const seen = JSON.parse(run(node, ['-e', script], { env: { ONLY: 'this' }, cwd }).stdout);
  assert.deepEqual(seen, { env: { ONLY: 'this' }, cwd });
});

test('a live program\'s output goes to the terminal, not back to the command', () => {
  const inner = `import { run } from ${JSON.stringify(path.join(HOME, 'run.mjs'))};
    const done = run(process.execPath, ['-e', 'console.log("seen as it happens")'], { live: true });
    console.log(JSON.stringify(done));`;
  const outer = run(node, ['--input-type=module', '-e', inner]);
  assert.equal(outer.stdout, 'seen as it happens\n{"code":0,"stdout":"","stderr":""}\n');
});

test('a program that cannot be started is an error naming it', () => {
  assert.throws(() => run('no-such-program-on-this-machine'), /^Error: could not run no-such-program-on-this-machine: /);
});

test('run.mjs is the only module in the home that can start a program', () => {
  const ways = [['child', 'process'].join('_'), ['node', 'cluster'].join(':'), ['process', 'binding'].join('.')];
  const modules = fs.readdirSync(HOME, { recursive: true }).filter((file) => /\.m?js$/.test(file));
  assert.ok(modules.includes('run.mjs') && modules.includes(path.basename(fileURLToPath(import.meta.url))));
  for (const file of modules.filter((file) => file !== 'run.mjs')) {
    const text = fs.readFileSync(path.join(HOME, file), 'utf8');
    for (const way of ways) assert.ok(!text.includes(way), `${file} mentions ${way}: start programs through run.mjs`);
  }
});
