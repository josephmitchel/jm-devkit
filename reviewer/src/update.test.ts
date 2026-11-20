import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { updateCheckout } from '../bin/update.mjs';

/**
 * The step before a nightly run, against a real git: a stand-in for the kit's repository whose
 * default branch is not `main`, and a checkout of it as the machine has. `npm ci` and `migrate` are
 * stood in for by commands that leave a note of having run and of the environment they were given.
 */
function kit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-update-'));
  const origin = path.join(root, 'origin');
  const checkout = path.join(root, 'checkout');
  const notes = path.join(root, 'notes');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(origin, file)), { recursive: true });
      fs.writeFileSync(path.join(origin, file), text);
    }
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', message);
    return git(origin, 'rev-parse', 'HEAD');
  };
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'trunk');
  commit(
    { 'reviewer/package-lock.json': '{"lockfileVersion":3}', 'reviewer/src/cli.ts': 'first', 'reviewer/.gitignore': 'node_modules/\n' },
    'first',
  );
  execFileSync('git', ['clone', '-q', origin, checkout]);

  const note = (name: string) => ['sh', '-c', `echo "${name} $DATABASE_URL|$CLAUDE_CODE_OAUTH_TOKEN|$REVIEWER_APP_PRIVATE_KEY" >> "${notes}"`];
  const update = (overrides: Record<string, unknown> = {}) =>
    updateCheckout({
      kitDir: checkout,
      env: { ...process.env, DATABASE_URL: 'postgres://db', CLAUDE_CODE_OAUTH_TOKEN: 'token', REVIEWER_APP_PRIVATE_KEY: 'key' },
      install: note('install'),
      migrate: note('migrate'),
      record: ['sh', '-c', `echo "record $1|$2" >> "${notes}"`, 'record'],
      log: () => {},
      ...overrides,
    });
  return {
    origin,
    checkout,
    git,
    commit,
    update,
    notes: () => (fs.existsSync(notes) ? fs.readFileSync(notes, 'utf8').trim().split('\n') : []),
  };
}

describe('bringing the code reviewer up to date before a nightly run', () => {
  it("moves the checkout to the head of the kit's default branch, whatever that branch is called", () => {
    const k = kit();
    const head = k.commit({ 'reviewer/src/cli.ts': 'second' }, 'second');

    expect(k.update()).toEqual({ ok: true });

    expect(k.git(k.checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(k.git(k.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk');
    expect(fs.readFileSync(path.join(k.checkout, 'reviewer/src/cli.ts'), 'utf8')).toBe('second');
  });
  it('follows the default branch when the kit names another one, and drops what was changed in the checkout', () => {
    const k = kit();
    k.git(k.origin, 'checkout', '-q', '-b', 'main');
    const head = k.commit({ 'reviewer/src/cli.ts': 'on main' }, 'on main');
    fs.writeFileSync(path.join(k.checkout, 'reviewer/src/cli.ts'), 'edited on the machine');

    expect(k.update()).toEqual({ ok: true });

    expect(k.git(k.checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(k.git(k.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(k.git(k.checkout, 'status', '--porcelain')).toBe('');
  });

  it('installs dependencies on the first run and when the lockfile has changed, and not otherwise', () => {
    const k = kit();
    const installs = () => k.notes().filter((n) => n.startsWith('install')).length;

    k.update();
    expect(installs()).toBe(1);

    k.commit({ 'reviewer/src/cli.ts': 'second' }, 'code only');
    k.update();
    expect(installs()).toBe(1);

    k.commit({ 'reviewer/package-lock.json': '{"lockfileVersion":3,"packages":{}}' }, 'a new dependency');
    k.update();
    expect(installs()).toBe(2);
  });

  it('installs again after an install that failed, though the lockfile is the same', () => {
    const k = kit();
    expect(k.update({ install: ['sh', '-c', 'exit 3'] })).toEqual({ ok: false, stage: 'installing dependencies', errorType: 'exit 3' });

    expect(k.update()).toEqual({ ok: true });
    expect(k.notes().filter((n) => n.startsWith('install'))).toHaveLength(1);
  });

  it('applies migrations every time, after the install', () => {
    const k = kit();
    k.update();
    k.update();
    expect(k.notes().map((n) => n.split(' ')[0])).toEqual(['install', 'migrate', 'migrate']);
  });

  it("keeps the credentials from the install, which runs other people's code, and gives the migration the database address", () => {
    const k = kit();
    k.update();
    expect(k.notes()).toEqual(['install ||', 'migrate postgres://db||']);
  });

  it('stops at the step that failed, so no nightly run starts on stale code, and records which step it was', () => {
    const k = kit();
    fs.renameSync(k.origin, `${k.origin}-gone`);

    expect(k.update()).toEqual({ ok: false, stage: 'moving the checkout', errorType: 'exit 128' });
    expect(k.notes()).toEqual(['record moving the checkout|exit 128']);
  });

  it('records a migration that failed', () => {
    const k = kit();
    expect(k.update({ migrate: ['sh', '-c', 'exit 1'] })).toEqual({ ok: false, stage: 'applying migrations', errorType: 'exit 1' });
    expect(k.notes()).toEqual(['install ||', 'record applying migrations|exit 1']);
  });
});
