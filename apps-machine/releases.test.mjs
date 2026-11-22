import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { GITHUB_HOST_KEYS } from './github-host-keys.mjs';
import { KEPT_RELEASES, commitOf, deployConfigOf, fetchDefaultBranch, makeRelease, projectConfigAt, pruneReleases, releasesOf, stampOf } from './releases.mjs';
import { run as realRun } from './run.mjs';
import { pointServiceAt, servicePointsAt } from './service.mjs';
import { commandLines, fakeRun, machine, registered, tempDir } from './test-helpers.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const CONFIG = { setup: 'npm ci', build: 'npm run build', start: 'npm start', port: 3000, healthPath: '/healthz' };

/** A machine with the sample app registered and these releases, named as given, in place. */
function withReleases(...names) {
  const paths = machine();
  registered(paths, { name: 'sample' });
  for (const name of names) fs.mkdirSync(path.join(paths.releasesDir('sample'), name, 'src'), { recursive: true });
  return paths;
}

const names = (paths) => fs.readdirSync(paths.releasesDir('sample')).sort();

test('a release is named for when its deploy began and the commit it holds', () => {
  assert.equal(stampOf(new Date('2026-11-21T14:30:05.678Z')), '20261121T143005Z');
  const paths = withReleases();
  const checkout = paths.incomingRelease('sample');
  fs.mkdirSync(checkout);
  const { run, calls } = fakeRun();
  const release = makeRelease({ run, paths }, 'sample', { checkout, commit: A, stamp: '20261121T143005Z', config: CONFIG });
  assert.equal(release, path.join(paths.releasesDir('sample'), `20261121T143005Z-${A}`));
  assert.equal(commitOf(release), A);
  assert.ok(fs.statSync(release).isDirectory());
  assert.ok(!fs.existsSync(checkout));
});

test('a release is handed to the app\'s user whole, and its directory stays closed to other users', () => {
  const paths = withReleases();
  fs.mkdirSync(paths.incomingRelease('sample'));
  const { run, calls } = fakeRun();
  const release = makeRelease({ run, paths }, 'sample', { checkout: paths.incomingRelease('sample'), commit: A, stamp: '20261121T143005Z', config: CONFIG });
  assert.deepEqual(commandLines(calls), [`chown -R sample:sample ${release}`]);
  assert.equal(fs.statSync(paths.releasesDir('sample')).mode & 0o777, 0o750);
});

test('root keeps the deploy section a release was deployed with, beside the release and out of the app\'s reach', () => {
  const paths = withReleases();
  fs.mkdirSync(paths.incomingRelease('sample'));
  const release = makeRelease({ run: fakeRun().run, paths }, 'sample', { checkout: paths.incomingRelease('sample'), commit: A, stamp: '20261121T143005Z', config: CONFIG });
  assert.deepEqual(deployConfigOf(release), CONFIG);
  assert.deepEqual(fs.readdirSync(release), []);
  assert.deepEqual(names(paths), [path.basename(release), `${path.basename(release)}.json`]);
  assert.deepEqual(releasesOf(paths, 'sample'), [release]);
});

test('an app\'s releases are listed oldest first, and nothing else in the directory is one', () => {
  const paths = withReleases(`20261121T143005Z-${B}`, `20261120T090000Z-${A}`, `20261122T000000Z-${A}`, 'notes', `20261121T143005Z-${B}.old`);
  assert.deepEqual(releasesOf(paths, 'sample').map((release) => path.basename(release)),
    [`20261120T090000Z-${A}`, `20261121T143005Z-${B}`, `20261122T000000Z-${A}`]);
  assert.deepEqual(releasesOf(machine(), 'sample'), []);
  assert.throws(() => commitOf(path.join(paths.releasesDir('sample'), 'notes')), /notes is not a release/);
});

test('pruning keeps the three newest releases and removes the older ones, whole', () => {
  assert.equal(KEPT_RELEASES, 3);
  const all = ['20261101T000000Z', '20261102T000000Z', '20261103T000000Z', '20261104T000000Z', '20261105T000000Z'].map((stamp) => `${stamp}-${A}`);
  const paths = withReleases(...all, 'notes');
  for (const name of all) fs.writeFileSync(path.join(paths.releasesDir('sample'), `${name}.json`), '{}\n');
  const removed = pruneReleases(paths, 'sample');
  assert.deepEqual(removed.map((release) => path.basename(release)), all.slice(0, 2));
  assert.deepEqual(names(paths), [...all.slice(2).flatMap((name) => [name, `${name}.json`]), 'notes']);
  assert.deepEqual(pruneReleases(paths, 'sample'), []);
});

test('three releases or fewer are all kept', () => {
  const all = ['20261101T000000Z', '20261102T000000Z', '20261103T000000Z'].map((stamp) => `${stamp}-${A}`);
  const paths = withReleases(...all);
  assert.deepEqual(pruneReleases(paths, 'sample'), []);
  assert.deepEqual(names(paths), all);
});

test('the release the service runs is never pruned, however old', () => {
  const all = ['20261101T000000Z', '20261102T000000Z', '20261103T000000Z', '20261104T000000Z', '20261105T000000Z'].map((stamp) => `${stamp}-${A}`);
  const paths = withReleases(...all);
  const world = { run: fakeRun().run, paths };
  pointServiceAt(world, 'sample', { release: path.join(paths.releasesDir('sample'), all[0]), start: 'node server.mjs' });
  pruneReleases(paths, 'sample');
  assert.deepEqual(names(paths), [all[0], ...all.slice(2)]);
  assert.equal(path.basename(servicePointsAt(paths, 'sample').release), all[0]);
});

test('the fetch is of the repository\'s default branch, with the app\'s deploy key, from a host that proves it is GitHub', () => {
  const paths = withReleases();
  const { run, calls } = fakeRun((program, args) => (args.includes('rev-parse') ? { stdout: `${A}\n` } : {}));
  const fetched = fetchDefaultBranch({ run, paths }, { name: 'sample', repository: 'git@github.com:example/sample.git' });
  assert.deepEqual(fetched, { checkout: paths.incomingRelease('sample'), commit: A });
  assert.deepEqual(commandLines(calls), [
    `git clone --quiet --depth 1 --no-tags git@github.com:example/sample.git ${fetched.checkout}`,
    `git -C ${fetched.checkout} rev-parse --verify HEAD`,
  ]);
  const ssh = calls[0].env.GIT_SSH_COMMAND;
  assert.match(ssh, new RegExp(`^ssh -F /dev/null -i '${paths.deployKey('sample')}' `));
  for (const option of ['IdentitiesOnly=yes', 'BatchMode=yes', 'StrictHostKeyChecking=yes', `UserKnownHostsFile='${paths.githubHostKeys}'`, 'GlobalKnownHostsFile=/dev/null']) {
    assert.ok(ssh.includes(` -o ${option}`), option);
  }
  assert.equal(calls[0].env.GIT_TERMINAL_PROMPT, '0');
  assert.deepEqual(fs.readFileSync(paths.githubHostKeys, 'utf8').trimEnd().split('\n'), GITHUB_HOST_KEYS.map((key) => `github.com ${key}`));
});

test('the host keys a fetch accepts are the ones GitHub publishes the fingerprints of', () => {
  const fingerprint = (key) => createHash('sha256').update(Buffer.from(key.split(' ')[1], 'base64')).digest('base64').replace(/=+$/, '');
  assert.deepEqual(GITHUB_HOST_KEYS.map((key) => `${key.split(' ')[0]} ${fingerprint(key)}`), [
    'ssh-ed25519 +DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
    'ecdsa-sha2-nistp256 p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM',
    'ssh-rsa uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
  ]);
});

test('a checkout left by a deploy that stopped is cleared before the next fetch', () => {
  const paths = withReleases();
  fs.mkdirSync(path.join(paths.incomingRelease('sample'), 'left-over'), { recursive: true });
  const { run } = fakeRun((program, args) => {
    if (args[0] === 'clone') assert.ok(!fs.existsSync(paths.incomingRelease('sample')));
    return args.includes('rev-parse') ? { stdout: `${A}\n` } : {};
  });
  fetchDefaultBranch({ run, paths }, { name: 'sample', repository: 'git@github.com:example/sample.git' });
});

test('a fetch that fails says why, in git\'s words', () => {
  const paths = withReleases();
  const { run } = fakeRun(() => ({ code: 128, stderr: 'git@github.com: Permission denied (publickey).\n' }));
  assert.throws(() => fetchDefaultBranch({ run, paths }, { name: 'sample', repository: 'git@github.com:example/sample.git' }),
    { message: 'could not fetch git@github.com:example/sample.git: git@github.com: Permission denied (publickey).' });
});

/** A repository on this disk, made with real git, whose default branch is not git's own default. */
function repository(files) {
  const dir = tempDir();
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => {
    const done = realRun('git', ['-C', dir, '-c', 'user.name=Someone', '-c', 'user.email=someone@example.com', ...args], { env });
    assert.equal(done.code, 0, done.stderr);
    return done.stdout.trim();
  };
  const commit = (branch, changed) => {
    git('checkout', '--quiet', '-B', branch);
    for (const [file, text] of Object.entries(changed)) fs.writeFileSync(path.join(dir, file), text);
    git('add', '--all');
    git('commit', '--quiet', '--message', `on ${branch}`);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet', '--initial-branch=trunk');
  const first = commit('trunk', files);
  return { address: `file://${dir}`, first, commit, git };
}

test('with real git: the fetch takes the remote\'s default branch as it is now, and the project config is read from that commit', () => {
  const paths = withReleases();
  const remote = repository({ 'devkit.json': '{"first":true}\n', 'app.js': 'one\n' });
  remote.commit('unmerged', { 'devkit.json': '{"unmerged":true}\n' });
  const second = remote.commit('trunk', { 'devkit.json': '{"second":true}\n', 'app.js': 'two\n' });
  remote.git('checkout', '--quiet', 'unmerged');
  remote.git('symbolic-ref', 'HEAD', 'refs/heads/trunk');
  const world = { run: realRun, paths };
  const fetched = fetchDefaultBranch(world, { name: 'sample', repository: remote.address });
  assert.equal(fetched.commit, second);
  assert.notEqual(second, remote.first);
  assert.equal(fs.readFileSync(path.join(fetched.checkout, 'app.js'), 'utf8'), 'two\n');
  fs.writeFileSync(path.join(fetched.checkout, 'devkit.json'), '{"changed":"after the fetch"}\n');
  assert.equal(projectConfigAt(world, fetched), '{"second":true}\n');
});

test('with real git: a commit with no project config has none to read', () => {
  const paths = withReleases();
  const remote = repository({ 'app.js': 'one\n' });
  const world = { run: realRun, paths };
  const fetched = fetchDefaultBranch(world, { name: 'sample', repository: remote.address });
  assert.throws(() => projectConfigAt(world, fetched), { message: `the default branch has no devkit.json at ${remote.first}` });
});
