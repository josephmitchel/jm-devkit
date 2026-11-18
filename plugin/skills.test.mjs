import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
