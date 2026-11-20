// The generator's folder is the only place in the kit that holds a code reviewer workflow's text.
// Hand-copied templates drifted from it before; this keeps a second one from coming back anywhere
// in the kit. The workflow is retired, so nothing writes it now, but its last form is still there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SWEEP_WORKFLOW } from './generator/generate.mjs';
import { lastSweepWorkflow } from './generator/retired-sweep-workflow.mjs';

const kitRoot = fileURLToPath(new URL('../', import.meta.url));
const self = relative(kitRoot, fileURLToPath(import.meta.url)).split(sep).join('/');
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

// The generator's folder and its tests hold the workflow's text on purpose. This file is skipped
// because it holds the very lines it looks for, as checks that the patterns still catch them.
const exempt = (path) => path.startsWith('plugin/generator/') || path === self;

// A job step on the code reviewer's action, under its old name or its place in the kit.
const ACTION_STEP = /uses:\s*["']?josephmitchel\/(code-reviewer|jm-devkit\/reviewer)@/;
// A sentence telling the reader to put a workflow into a repository by copying it.
const COPY = /\b(copy|paste)\b.*\binto\b/i;
const WORKFLOW = /\.github\/workflows|\bworkflows?\b|\.ya?ml\b/i;

/** Every file under `dir`, relative to the kit root with `/` separators. */
function files(dir = kitRoot) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED_DIRS.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.isFile() ? [relative(kitRoot, path).split(sep).join('/')] : [];
  });
}

/** Each line of `text` that is a workflow template's: `path:line: the line`. */
function templateLines(path, text) {
  const lines = text.split(/\r?\n/);
  // A line's prose: no comment or list marker in front, and single spaces.
  const strip = (line) => (line ?? '').replace(/^\s*(?:#+|\/\/+|\*+|>+|-|\d+\.)?\s*/, '').replace(/\s+/g, ' ').trim();
  const hits = [];
  lines.forEach((line, i) => {
    // A sentence may wrap, so each line is read with the one after it, but a sentence counts as
    // this line's only when its "copy" is on this line.
    const own = strip(line);
    let at = 0;
    const copies = `${own} ${strip(lines[i + 1])}`.split(/(?<=[.!?])\s+/).some((sentence) => {
      const verb = at + sentence.search(COPY);
      at += sentence.length + 1;
      return COPY.test(sentence) && verb < own.length && WORKFLOW.test(sentence);
    });
    if (ACTION_STEP.test(line) || copies) hits.push(`${path}:${i + 1}: ${line.trim()}`);
  });
  return hits;
}

// The kit is a project too, and until it moves to the owner's machine it keeps its own copy of the
// retired workflow, which names the action. That copy passes only while it is exactly the
// workflow's last form for the kit's devkit.json: a hand edit makes it a template. Once the kit
// has moved there is no copy, and nothing here asks for one.
const kitConfig = JSON.parse(readFileSync(join(kitRoot, 'devkit.json'), 'utf8'));
const retiredCopy = { [SWEEP_WORKFLOW]: lastSweepWorkflow(kitConfig) };

test('the patterns catch the lines of the old hand-copied templates', () => {
  const old = [
    '# Copy this into the repository you want swept, as .github/workflows/nightly-sweep.yml.',
    "2. Copy `examples/workflows/code-review.yml` into the project's `.github/workflows/`.",
    '      - uses: josephmitchel/code-reviewer@main',
    '      - uses: josephmitchel/jm-devkit/reviewer@main',
  ];
  for (const line of old) assert.equal(templateLines('x', line).length, 1, line);
  assert.deepEqual(templateLines('x', 'Copy the sweep workflow\ninto your repository.'), ['x:1: Copy the sweep workflow']);
  assert.deepEqual(templateLines('x', '```\n2. Copy `a.yml` into the repo.'), ['x:2: 2. Copy `a.yml` into the repo.']);
});

test('the patterns pass prose that only names the action or copies something else', () => {
  const fine = [
    'Copy `install/coding-standards.md` to `CODING_STANDARDS.md` if the plan says so.',
    'a job that `uses:` the code reviewer\'s action (`josephmitchel/code-reviewer@…`)',
    'Paste the key into the prompt.',
    'Copy the key.\nThe workflow goes into devkit.json.',
  ];
  for (const text of fine) assert.deepEqual(templateLines('x', text), [], text);
});

test('no file outside the generator is a hand-copied code reviewer workflow', () => {
  const all = files();
  assert.ok(all.includes('reviewer/README.md') && all.includes('.github/workflows/ci.yml'), 'the walk missed the kit');
  const found = [];
  for (const path of all) {
    if (exempt(path)) continue;
    const text = readFileSync(join(kitRoot, path), 'utf8');
    if (retiredCopy[path] === text) continue;
    found.push(...templateLines(path, text));
  }
  assert.deepEqual(found, []);
});
