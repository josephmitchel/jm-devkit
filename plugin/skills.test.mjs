import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));

// The top-level keys of a SKILL.md's YAML frontmatter, each with its value
// (a block scalar's value is its indented lines).
function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) return null;
  const fields = {};
  let key = null;
  for (const line of match[1].split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (top) {
      key = top[1];
      fields[key] = /^[|>][-+]?$/.test(top[2]) ? '' : top[2];
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] += ` ${line.trim()}`;
    }
  }
  for (const k of Object.keys(fields)) fields[k] = fields[k].trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  return fields;
}

test('the plugin manifest lists skills', () => {
  assert.ok(Array.isArray(manifest.skills) && manifest.skills.length > 0);
});

for (const path of manifest.skills ?? []) {
  test(`${path} has a SKILL.md with a name and a description`, () => {
    const file = join(pluginRoot, path, 'SKILL.md');
    assert.ok(existsSync(file), `missing ${file}`);
    const fields = frontmatter(readFileSync(file, 'utf8'));
    assert.ok(fields, 'no frontmatter');
    assert.ok(fields.name, 'frontmatter has no name');
    assert.equal(fields.name, basename(path), 'name differs from the folder name');
    assert.ok(fields.description, 'frontmatter has no description');
  });
}

// Every file under the plugin, as a path relative to the plugin root.
function pluginFiles(dir = pluginRoot) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? pluginFiles(path) : [relative(pluginRoot, path)];
  });
}

const files = pluginFiles();
const skillFiles = files.filter((path) => path.startsWith('skills/'));

test('every plugin doc a skill points at exists', () => {
  const missing = [];
  for (const path of skillFiles) {
    const text = readFileSync(join(pluginRoot, path), 'utf8');
    for (const [, doc] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(docs\/[^\s`'")]+)/g)) {
      if (!existsSync(join(pluginRoot, doc))) missing.push(`${path} -> ${doc}`);
    }
  }
  assert.deepEqual(missing, []);
});

// The kit is public and never names a project. Whole words only, so that ordinary
// English that contains one ("services", "blockers") is not caught.
const forbidden = ['spendright', 'outlier', 'vices', 'blocker', 'josephmitchel/spendright', 'josephmitchel/vices'];
const forbiddenPattern = new RegExp(`\\b(${forbidden.map((word) => word.replace(/[/]/g, '\\/')).join('|')})\\b`, 'gi');
const thisFile = relative(pluginRoot, fileURLToPath(import.meta.url));

test('no file under the plugin names a project', () => {
  assert.ok(files.includes('docs/issue-tracker.md'), 'the walk did not reach the docs');
  const found = [];
  for (const path of files) {
    if (path === thisFile) continue;
    for (const [i, line] of readFileSync(join(pluginRoot, path), 'utf8').split('\n').entries()) {
      for (const [word] of line.matchAll(forbiddenPattern)) found.push(`${path}:${i + 1}: ${word}`);
    }
    for (const [word] of path.matchAll(forbiddenPattern)) found.push(`${path}: ${word} in the path`);
  }
  assert.deepEqual(found, []);
});
