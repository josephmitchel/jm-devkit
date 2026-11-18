import { test } from 'node:test';
import { createHash } from 'node:crypto';
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

// The kit is public and never names a project. The forbidden words are held only as
// SHA-256 digests of their lowercased form, so that the public kit does not carry the
// names. A file's tokens are its lowercased whole words, plus every owner/name pair in
// a slash-separated run (so a repository slug is caught inside a URL too).
const forbiddenDigests = new Set([
  'ab4c02eddf4b490a644ed18586192934f14e6cbc563290e4ef281af36baa6981',
  '2aed12b734be9cf4a09a1f9f0dd96b7245af53861591373fcc414496094a9203',
  'ed5fe17178325242856da927fdca416ae19698c863b41804fab2d61324a0540c',
  '1a48940a9383be191a715f95a09c7c253b725555cf61f72272482836e8710eef',
  'c09c0ce5757c079609bee8bd67078ceca4566ddf95373f515558a1c477577432',
  '5ad00841d236fe237a59067d66d758099e548a3af191d24bd9b3d572abb7081b',
]);

function tokens(text) {
  const lower = text.toLowerCase();
  const found = new Set(lower.match(/[a-z0-9_]+/g) ?? []);
  for (const run of lower.match(/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+/g) ?? []) {
    const parts = run.split('/').map((part) => part.replace(/(\.git)?\.*$/, ''));
    for (let i = 0; i + 1 < parts.length; i++) found.add(`${parts[i]}/${parts[i + 1]}`);
  }
  return found;
}

const digest = (token) => createHash('sha256').update(token).digest('hex');

test('no file under the plugin names a project', () => {
  assert.ok(files.includes('docs/issue-tracker.md'), 'the walk did not reach the docs');
  const found = [];
  for (const path of files) {
    const text = `${path}\n${readFileSync(join(pluginRoot, path), 'utf8')}`;
    for (const token of tokens(text)) {
      const hash = digest(token);
      if (forbiddenDigests.has(hash)) found.push(`${path}: forbidden word with digest ${hash}`);
    }
  }
  assert.deepEqual(found, []);
});
