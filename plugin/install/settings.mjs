#!/usr/bin/env node
// Removes the permission rules in a project's .claude/settings.json that make an agent ask (or
// refuse) before a plain `git commit` or `git push`. The Git house rule has agents commit and push
// their own work, so such a rule contradicts it. A rule about something narrower, `git push
// --force` say, agrees with the house rule and stays.
//
//   node settings.mjs <projectDir> [--dry-run]
//
// Prints `remove <list> "<rule>"` for each rule it removes (or, with --dry-run, would), and
// `remove .claude/settings.json` if nothing is left in the file; nothing when there is no such
// rule. Exit 0 done, 2 the file is not valid JSON, or bad arguments.

import fs from 'node:fs';
import path from 'node:path';

import { isMain } from './gh.mjs';

export const SETTINGS_FILE = '.claude/settings.json';
const LISTS = ['ask', 'deny'];

/** True for a Bash rule that catches a plain `git commit` or `git push`: `Bash(git commit:*)`, `Bash(git *)`. */
export function contradictsGitRule(rule) {
  const match = typeof rule === 'string' && rule.match(/^Bash\((.*)\)$/s);
  if (!match) return false;
  return /^git(\s+(commit|push))?(:\*|\s*\*)?$/.test(match[1].trim());
}

/** `settings` without those rules, and the `{ list, rule }` pairs taken out. */
export function withoutGitPrompts(settings) {
  const removed = [];
  const next = structuredClone(settings);
  const permissions = next.permissions;
  if (permissions && typeof permissions === 'object') {
    for (const list of LISTS) {
      if (!Array.isArray(permissions[list])) continue;
      const kept = permissions[list].filter((rule) => {
        if (!contradictsGitRule(rule)) return true;
        removed.push({ list: `permissions.${list}`, rule });
        return false;
      });
      if (kept.length > 0) permissions[list] = kept;
      else if (removed.some((r) => r.list === `permissions.${list}`)) delete permissions[list];
    }
    if (removed.length > 0 && Object.keys(permissions).length === 0) delete next.permissions;
  }
  return { settings: next, removed };
}

/** The CLI. Returns the exit code. */
export function main(argv, { out = process.stdout, err = process.stderr } = {}) {
  const dryRun = argv.includes('--dry-run');
  const rest = argv.filter((a) => a !== '--dry-run');
  if (rest.length !== 1 || rest[0].startsWith('-')) {
    err.write('usage: node settings.mjs <projectDir> [--dry-run]\n');
    return 2;
  }
  const file = path.join(rest[0], SETTINGS_FILE);
  if (!fs.existsSync(file)) return 0;

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    err.write(`${SETTINGS_FILE} is not valid JSON: ${e.message}\n`);
    return 2;
  }
  const { settings: next, removed } = withoutGitPrompts(settings);
  if (removed.length === 0) return 0;

  for (const { list, rule } of removed) out.write(`remove ${list} ${JSON.stringify(rule)}\n`);
  const empty = Object.keys(next).filter((k) => k !== '$schema').length === 0;
  if (empty) out.write(`remove ${SETTINGS_FILE}\n`);
  if (dryRun) return 0;
  if (empty) fs.rmSync(file);
  else fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
