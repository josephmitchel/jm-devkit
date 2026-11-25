import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitFacts, repoCommandEnv, runRepoCommand } from './workspace.js';

/**
 * The reviewed repo's setup and test commands are arbitrary code — `npm ci` alone runs that
 * repo's install scripts. Handing them the reviewer's own environment leaks the App private key
 * that can push to the repo, the credential that pays for the review, and a connection string
 * to the reviewer's database. The last one nearly caused real damage: one project's db suite
 * falls back to `DATABASE_URL`, so on the first CI run it aimed at the reviewer's Neon database
 * and was stopped only by a `_test`-suffix guard in that project's own test helper.
 */
describe('repoCommandEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    DATABASE_URL: 'postgresql://user:pw@host/neondb',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    GH_TOKEN: 'ghs_secret',
    GITHUB_TOKEN: 'ghs_secret',
    REVIEWER_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----',
    REVIEWER_APP_CLIENT_ID: 'Iv23li',
    REVIEWER_AGENT_CONCURRENCY: '5',
  };

  it('strips every reviewer-owned credential', () => {
    const env = repoCommandEnv(source);
    for (const key of [
      'DATABASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'REVIEWER_APP_PRIVATE_KEY',
      'REVIEWER_APP_CLIENT_ID',
      'REVIEWER_AGENT_CONCURRENCY',
    ]) {
      expect(env, `${key} must not reach the reviewed repo`).not.toHaveProperty(key);
    }
  });

  it('keeps what a build actually needs, and marks the run as CI', () => {
    const env = repoCommandEnv(source);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/runner');
    expect(env.CI).toBe('true');
  });

  it('does not mutate the environment it was given', () => {
    repoCommandEnv(source);
    expect(source.DATABASE_URL).toBe('postgresql://user:pw@host/neondb');
  });

  it('strips any future REVIEWER_-prefixed variable without being told', () => {
    expect(repoCommandEnv({ ...source, REVIEWER_SOMETHING_NEW: 'x' })).not.toHaveProperty(
      'REVIEWER_SOMETHING_NEW',
    );
  });
});

describe("repoCommandEnv on the machine, where the service's environment holds the credentials file", () => {
  // The names the machine setup says the file holds, read from the setup itself.
  const setup = fs.readFileSync(path.join(import.meta.dirname, '../../vm/dev-vm-setup.sh'), 'utf8');
  const names = /^CREDENTIAL_NAMES=\(([A-Z_ ]+)\)$/m.exec(setup)![1].split(' ');

  it("gives a project's commands none of the credentials, nor where the code reviewer keeps its state", () => {
    expect(names).toContain('REVIEWER_TEST_DATABASES_URL');
    const service = {
      PATH: '/usr/bin',
      HOME: '/home/reviewer',
      REVIEWER_WORKSPACE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-machine-')),
      REVIEWER_STATE_DIR: '/var/lib/code-reviewer/state',
      ...Object.fromEntries(names.map((name) => [name, 'secret'])),
    };
    const env = repoCommandEnv(service);
    for (const name of [...names, 'REVIEWER_STATE_DIR', 'REVIEWER_WORKSPACE_ROOT']) {
      expect(env, `${name} must not reach a project's commands`).not.toHaveProperty(name);
    }
    expect(Object.values(env)).not.toContain('secret');
    expect(env.HOME).toBe(path.join(service.REVIEWER_WORKSPACE_ROOT, 'repo-home'));
  });
});

/**
 * A project's `devkit.json` env reaches its commands, a name the reviewer strips included, and
 * never the reviewer's own environment.
 */
describe('repoCommandEnv with a devkit.json env', () => {
  const source = { PATH: '/usr/bin', DATABASE_URL: 'postgresql://reviewer/neondb' };

  it('passes the project its variables, including a name that is otherwise stripped', () => {
    const env = repoCommandEnv(source, { TEST_FLAG: '1', DATABASE_URL: 'postgresql://localhost/app_test' });
    expect(env.TEST_FLAG).toBe('1');
    expect(env.DATABASE_URL).toBe('postgresql://localhost/app_test');
  });

  it('reaches the command itself', async () => {
    const res = await runRepoCommand('/tmp', 'test "$DEVKIT_PROBE" = here', { DEVKIT_PROBE: 'here' }, 10_000);
    expect(res.passed).toBe(true);
  });
});

/**
 * A command killed for running too long used to be recorded as `passed: false` with a partial log,
 * indistinguishable from a suite that genuinely failed — and ten auditors were then handed that log
 * as evidence of broken code. The detection relies on what execFile actually reports when it kills a
 * child, so this exercises a real process rather than trusting an assumption about `err.killed`.
 */
describe('runRepoCommand timeouts', () => {
  it('marks a command killed for exceeding its budget, and says so in the output', async () => {
    const res = await runRepoCommand('/tmp', 'sleep 5', {}, 400);
    expect(res.passed).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.trimmedOutput).toContain('killed after');
  });

  it('does not mark an ordinary failure as a timeout', async () => {
    const res = await runRepoCommand('/tmp', 'echo boom >&2; exit 1', {}, 10_000);
    expect(res.passed).toBe(false);
    expect(res.timedOut).toBe(false);
  });

  it('passes a command that succeeds', async () => {
    expect((await runRepoCommand('/tmp', 'true', {}, 10_000)).passed).toBe(true);
  });
});

/**
 * Node reports a buffer overflow with its own code and leaves `killed` and `signal` undefined — so
 * without checking it first, a command drowned in output falls through to the generic branch and is
 * reported as a failing test, with a truncated log standing in as the explanation.
 */
describe('runRepoCommand output overflow', () => {
  it('reports a command killed for flooding its buffer as inconclusive, not failed', async () => {
    const res = await runRepoCommand('/tmp', 'yes hello', {}, 10_000, 1024);
    expect(res.passed).toBe(false);
    expect(res.timedOut).toBe(true); // carried on the same flag: both mean "this says nothing"
    expect(res.trimmedOutput).toContain('more output than the reviewer will buffer');
  });
});

/**
 * The reviewed repo's install and test commands are arbitrary code, and HOME is where the git
 * credential helper is named (~/.gitconfig), alongside ~/.claude and ~/.npmrc. An install script that
 * rewrote the helper would have the fixer's later push hand its token wherever the repo chose.
 */
describe('repoCommandEnv home isolation', () => {
  it('redirects HOME when a workspace root is configured', () => {
    const env = repoCommandEnv({
      HOME: '/Users/someone',
      REVIEWER_WORKSPACE_ROOT: '/tmp/claude-reviewer-home-test',
    });
    expect(env.HOME).toBe('/tmp/claude-reviewer-home-test/repo-home');
    expect(env.HOME).not.toBe('/Users/someone');
  });

  it('leaves HOME alone with no workspace root, so a laptop behaves as before', () => {
    expect(repoCommandEnv({ HOME: '/Users/someone' }).HOME).toBe('/Users/someone');
  });
});

describe('commitFacts', () => {
  it("reads a head's parent, author and full message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-facts-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('-c', 'user.name=a', '-c', 'user.email=a@example.com', 'commit', '-q', '--allow-empty', '-m', 'first');
    const first = git('rev-parse', 'HEAD');
    git('-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com', 'commit', '-q', '--allow-empty',
      '-m', 'Settle link re-rating order', '-m', 'Addresses review concerns:\n- some-slug');
    const facts = await commitFacts(dir, 'HEAD');
    expect(facts.parents).toEqual([first]);
    expect(facts.authorEmail).toBe('noreply@anthropic.com');
    expect(facts.message).toBe('Settle link re-rating order\n\nAddresses review concerns:\n- some-slug');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
