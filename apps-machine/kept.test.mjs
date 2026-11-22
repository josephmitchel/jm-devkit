import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { keptByDeploys, keptByRestores, newKeptName } from './kept.mjs';
import { machine, mode } from './test-helpers.mjs';

function holding(dir, ...names) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(dir, name), 'kept');
}

test('what the deploys of an app kept is its dumps named for a time, oldest first, and nothing else in the directory', () => {
  const paths = machine();
  const dir = paths.deployDumps('sample');
  assert.deepEqual(keptByDeploys(paths, 'sample'), []);
  holding(dir, '20261101T120000Z.dump', '20261001T120000Z.dump', 'notes.txt', '20261001T120000Z.dump.new', 'sample-2026-01-01.dump', '20261341T120000Z.dump', '20260901T120000Z.env', '20260901T120000Z-2.dump', '.dump');
  fs.mkdirSync(path.join(dir, '20260801T120000Z.dump'));
  fs.symlinkSync(path.join(dir, 'notes.txt'), path.join(dir, '20260701T120000Z.dump'));
  holding(paths.deployDumps('example_app'), '20250101T120000Z.dump');
  assert.deepEqual(keptByDeploys(paths, 'sample'), [
    { name: '20261001T120000Z', time: new Date('2026-10-01T12:00:00Z'), files: [path.join(dir, '20261001T120000Z.dump')] },
    { name: '20261101T120000Z', time: new Date('2026-11-01T12:00:00Z'), files: [path.join(dir, '20261101T120000Z.dump')] },
  ]);
});

test('what a restore kept is one thing: its dump, and the settings file kept beside it', () => {
  const paths = machine();
  const dir = paths.restoreDumps('sample');
  assert.deepEqual(keptByRestores(paths, 'sample'), []);
  holding(dir, '20261101T120000Z.dump', '20261001T120000Z.env', '20261001T120000Z.dump', '20260901T120000Z.env', 'notes.txt', '20261001T120000Z.txt', '20261001T120000Z-x.dump', '20261001T120000Z.dump.env');
  assert.deepEqual(keptByRestores(paths, 'sample'), [
    { name: '20260901T120000Z', time: new Date('2026-09-01T12:00:00Z'), files: [path.join(dir, '20260901T120000Z.env')] },
    { name: '20261001T120000Z', time: new Date('2026-10-01T12:00:00Z'), files: [path.join(dir, '20261001T120000Z.dump'), path.join(dir, '20261001T120000Z.env')] },
    { name: '20261101T120000Z', time: new Date('2026-11-01T12:00:00Z'), files: [path.join(dir, '20261101T120000Z.dump')] },
  ]);
});

test('a second restore in one second keeps under a name of its own, which is read back after the first', () => {
  const paths = machine();
  const dir = paths.restoreDumps('sample');
  const stamp = '20261121T143005Z';
  const names = [];
  for (let n = 0; n < 11; n += 1) {
    names.push(path.basename(newKeptName(dir, stamp)));
    fs.writeFileSync(path.join(dir, `${names.at(-1)}.dump`), 'kept');
  }
  assert.equal(mode(dir), 0o700);
  assert.deepEqual(names, [stamp, ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `${stamp}-${n}`)]);
  fs.writeFileSync(path.join(dir, `${stamp}-2.env`), 'kept');
  holding(dir, `${stamp}-1.dump`, `${stamp}-0.dump`, `${stamp}-02.dump`, '20261121T143004Z.dump');
  const kept = keptByRestores(paths, 'sample');
  assert.deepEqual(kept.map((one) => one.name), ['20261121T143004Z', ...names]);
  assert.deepEqual(kept[2].files, [path.join(dir, `${stamp}-2.dump`), path.join(dir, `${stamp}-2.env`)]);
});
