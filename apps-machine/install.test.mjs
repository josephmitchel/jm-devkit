import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ENTRY, KIT_FILES, install, main } from './install.mjs';
import { run } from './run.mjs';
import { fakeRun, filesUnder, machine, machinePrograms, mode, sink, tempDir, withUmask } from './test-helpers.mjs';

const KIT = path.resolve(import.meta.dirname, '..');

function installed() {
  const destDir = path.join(tempDir(), 'lib/apps-machine');
  assert.equal(install({ destDir }), 'installed');
  return destDir;
}

/** A made-up kit holding what the real one installs, to change at will. */
function kitCopy() {
  const kitDir = tempDir();
  fs.cpSync(path.join(KIT, 'apps-machine'), path.join(kitDir, 'apps-machine'), { recursive: true });
  for (const file of KIT_FILES) fs.cpSync(path.join(KIT, file), path.join(kitDir, file));
  return kitDir;
}


test('the installed copy lists a new machine\'s apps with nothing else from the kit', async () => {
  const destDir = installed();
  const entry = await import(pathToFileURL(path.join(destDir, ENTRY)).href);
  const out = sink();
  assert.equal(await entry.main(['list'], { paths: machine(), out, err: sink(), uid: 0 }), 0);
  assert.equal(out.text, 'No app is registered.\n');
});

test('the installed entry point runs as a program, through a link on the path', () => {
  const destDir = installed();
  const link = path.join(tempDir(), 'apps-machine');
  fs.symlinkSync(path.join(destDir, ENTRY), link);
  const done = run(link, ['nonsense']);
  assert.equal(done.code, 2);
  assert.match(done.stderr, /^usage: apps-machine <command>/);
});

test('the project-config reader comes along, with its schema', async () => {
  const destDir = installed();
  const reader = await import(pathToFileURL(path.join(destDir, 'plugin/devkit-config.mjs')).href);
  assert.equal(reader.SCHEMA_PATH, path.join(destDir, 'plugin/devkit.schema.json'));
  assert.equal(typeof reader.devkitSchema(), 'object');
});

test('the installed copy registers an app, writing its unit from the template that came along', async () => {
  const destDir = installed();
  const entry = await import(pathToFileURL(path.join(destDir, ENTRY)).href);
  const paths = machine();
  const err = sink();
  const argv = ['register', 'sample', 'git@github.com:example/sample.git', '8443'];
  assert.equal(await entry.main(argv, { paths, run: fakeRun(machinePrograms()).run, out: sink(), err, uid: 0 }), 0, err.text);
  assert.match(fs.readFileSync(paths.unitFile('sample'), 'utf8'), /^User=sample$/m);
});

test('no test, test helper or note is installed', () => {
  const copied = filesUnder(installed());
  assert.ok(copied.includes('apps-machine/commands/list.mjs'));
  assert.deepEqual(copied.filter((file) => !file.endsWith('.mjs') && !KIT_FILES.includes(file)), ['apps-machine/app.service.template']);
  assert.deepEqual(copied.filter((file) => /test/.test(file)), []);
});

test('a second install changes nothing', () => {
  const destDir = installed();
  const before = fs.statSync(path.join(destDir, ENTRY));
  assert.equal(install({ destDir }), 'unchanged');
  const after = fs.statSync(path.join(destDir, ENTRY));
  assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs]);
});

test('a module the kit changed, added or dropped is the same in the copy after the next install', () => {
  const kitDir = kitCopy();
  const destDir = path.join(tempDir(), 'lib/apps-machine');
  install({ kitDir, destDir });
  fs.appendFileSync(path.join(kitDir, 'apps-machine/paths.mjs'), '// changed\n');
  fs.writeFileSync(path.join(kitDir, 'apps-machine/commands/added.mjs'), 'export {};\n');
  fs.rmSync(path.join(kitDir, 'apps-machine/usage.mjs'));
  assert.equal(install({ kitDir, destDir }), 'installed');
  assert.match(fs.readFileSync(path.join(destDir, 'apps-machine/paths.mjs'), 'utf8'), /\/\/ changed\n$/);
  assert.ok(fs.existsSync(path.join(destDir, 'apps-machine/commands/added.mjs')));
  assert.ok(!fs.existsSync(path.join(destDir, 'apps-machine/usage.mjs')));
  assert.deepEqual(fs.readdirSync(path.dirname(destDir)), ['apps-machine']);
  assert.equal(install({ kitDir, destDir }), 'unchanged');
});

test('the copy is readable by all and writable by its owner alone, whatever the umask', () => {
  withUmask(0o077, () => {
    const destDir = installed();
    const modeOf = (file) => mode(path.join(destDir, file));
    assert.equal(modeOf('.'), 0o755);
    assert.equal(modeOf('apps-machine/commands'), 0o755);
    assert.equal(modeOf('apps-machine/commands/list.mjs'), 0o644);
    assert.equal(modeOf('plugin/devkit.schema.json'), 0o644);
    assert.equal(modeOf(ENTRY), 0o755);
  });
});

test('a copy whose modes were loosened is put right', () => {
  const destDir = installed();
  fs.chmodSync(path.join(destDir, 'apps-machine/run.mjs'), 0o666);
  assert.equal(install({ destDir }), 'installed');
  assert.equal(mode(path.join(destDir, 'apps-machine/run.mjs')), 0o644);
});

test('the installer says what it did, and wants one absolute path', () => {
  const destDir = path.join(tempDir(), 'lib/apps-machine');
  const say = (argv) => {
    const out = sink();
    const err = sink();
    return { code: main(argv, { out, err }), out: out.text, err: err.text };
  };
  assert.deepEqual(say([destDir]), { code: 0, out: `Installed the commands in ${destDir}.\n`, err: '' });
  assert.deepEqual(say([destDir]), { code: 0, out: `The commands in ${destDir} are as the kit has them.\n`, err: '' });
  for (const argv of [[], ['lib/apps-machine'], [destDir, 'more']]) {
    assert.deepEqual(say(argv), { code: 2, out: '', err: 'usage: node install.mjs <absolute directory>\n' });
  }
});
