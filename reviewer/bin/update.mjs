#!/usr/bin/env node
// Brings the code reviewer's own checkout up to date. The machine runs it before each nightly run.
// Plain Node with no dependency of the code reviewer's: it is what installs them, and it replaces
// the files under it while it runs.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MINUTE = 60_000;

/** The stages of bringing the code reviewer up to date, by the fixed names a run records. */
export const UPDATE_STAGES = ['moving the checkout', 'installing dependencies', 'applying migrations'];

/** A step that did not succeed, with the same type of error a run records. */
class StepFailed extends Error {}

function run(command, { cwd, env, timeoutMs, capture = false }) {
  const [file, ...args] = command;
  const done = spawnSync(file, args, {
    cwd,
    env,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
  });
  if (done.status === 0) return capture ? done.stdout.trim() : '';
  throw new StepFailed(done.signal ? `killed by ${done.signal}` : done.status === null ? 'could not start' : `exit ${done.status}`);
}

/**
 * Move the checkout at `kitDir` to the head of the kit's default branch. The branch is asked of the
 * remote each time, so the kit renaming it needs nothing done here. Anything changed in the
 * checkout is discarded: nothing is ever edited there.
 */
function moveToDefaultBranch(kitDir, env) {
  const git = (...args) => run(['git', ...args], { cwd: kitDir, env, timeoutMs: 5 * MINUTE, capture: true });
  git('fetch', '--prune', 'origin');
  git('remote', 'set-head', 'origin', '--auto');
  const branch = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '');
  git('checkout', '--quiet', '--force', '-B', branch, `origin/${branch}`);
  return { branch, commit: git('rev-parse', 'HEAD') };
}

/**
 * What the code reviewer needs of its environment to install its own dependencies: none of its
 * credentials. An install runs the install scripts of every package it fetches.
 */
function withoutCredentials(env) {
  const kept = { ...env };
  for (const name of Object.keys(kept)) {
    if (name.startsWith('REVIEWER_') || name === 'DATABASE_URL' || name === 'CLAUDE_CODE_OAUTH_TOKEN') delete kept[name];
  }
  return kept;
}

/**
 * Install the dependencies when the lockfile is not the one they were last installed from. The
 * note of that lockfile is written only after an install succeeds and lives in `node_modules`, so
 * an install that failed, or one that never happened, is tried again the next time.
 */
function installWhenLockfileChanged(reviewerDir, install, env, log) {
  const lockfile = crypto.createHash('sha256').update(fs.readFileSync(path.join(reviewerDir, 'package-lock.json'))).digest('hex');
  const note = path.join(reviewerDir, 'node_modules', '.installed-from-lockfile');
  if (fs.existsSync(note) && fs.readFileSync(note, 'utf8').trim() === lockfile) {
    log('dependencies are those of the lockfile: nothing to install');
    return;
  }
  fs.rmSync(note, { force: true });
  log('the lockfile has changed since the last install: installing dependencies');
  run(install, { cwd: reviewerDir, env: withoutCredentials(env), timeoutMs: 20 * MINUTE });
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, `${lockfile}\n`);
}

/**
 * Bring the checkout up to date: move it to the kit's default branch, install dependencies when
 * the lockfile changed, apply migrations. The first step that fails ends it, so a nightly run
 * never starts on code, dependencies or a database that are out of step with each other. The
 * failure is then recorded as a nightly run that did not start, when the code reviewer is in a
 * state to record anything. Returns `{ ok: true }`, or which stage failed and how.
 */
export function updateCheckout({
  kitDir,
  env = process.env,
  install = ['npm', 'ci'],
  migrate = [process.execPath, 'bin/code-reviewer.mjs', 'migrate'],
  record = [process.execPath, 'bin/code-reviewer.mjs', 'nightly-not-started'],
  log = console.log,
}) {
  const reviewerDir = path.join(kitDir, 'reviewer');
  let stage = UPDATE_STAGES[0];
  try {
    const { branch, commit } = moveToDefaultBranch(kitDir, withoutCredentials(env));
    log(`the code reviewer is at ${commit.slice(0, 10)} on ${branch}`);
    stage = UPDATE_STAGES[1];
    installWhenLockfileChanged(reviewerDir, install, env, log);
    stage = UPDATE_STAGES[2];
    run(migrate, { cwd: reviewerDir, env: { ...withoutCredentials(env), DATABASE_URL: env.DATABASE_URL }, timeoutMs: 10 * MINUTE });
    return { ok: true };
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    log(`${stage} failed (${err.message}): the nightly run is not started`);
    try {
      run([...record, stage, err.message], { cwd: reviewerDir, env, timeoutMs: MINUTE });
    } catch {
      log('the failure could not be recorded as a run: the system journal has it');
    }
    return { ok: false, stage, errorType: err.message };
  }
}

if (import.meta.main) {
  const kitDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  if (!updateCheckout({ kitDir }).ok) process.exitCode = 1;
}
