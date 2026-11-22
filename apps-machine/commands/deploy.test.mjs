import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { commitOf, releasesOf } from '../releases.mjs';
import { servicePointsAt } from '../service.mjs';
import { readSettings, writeSettings } from '../settings.mjs';
import { appsMachine, deployPrograms, fakeRun, machine, registered } from '../test-helpers.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

const DEPLOY = { setup: 'npm ci', build: 'npm run build', migrate: 'npm run migrate', start: 'npm start', port: 3000, healthPath: '/healthz' };
/** A project config with this deploy section, or with none. */
const config = (deploy = DEPLOY) => ({ modules: ['process'], reviewer: { tests: [{ name: 'unit', command: 'npm test' }] }, ...(deploy && { deploy }) });

const commandLines = (calls) => calls.map(({ program, args }) => [program, ...args].join(' '));
const mode = (file) => fs.statSync(file).mode & 0o777;

/**
 * A machine with the sample app registered, a remote whose default branch is at commit A, and
 * `deploy(argv?)` run there. Each deploy begins a minute after the one before, from 14:30:00.
 */
function world({ remote = { commit: A, config: config() }, behaviour = {} } = {}) {
  const paths = machine();
  const app = registered(paths, { name: 'sample', repository: 'git@github.com:example/sample.git', servePort: 8443 });
  const { respond, events } = deployPrograms(paths, 'sample', remote, behaviour);
  const { run, calls } = fakeRun(respond);
  let deploys = 0;
  const now = () => new Date(Date.UTC(2026, 10, 21, 14, 30 + deploys++, 0));
  const deploy = (argv = ['deploy', 'sample']) => appsMachine(argv, { run, paths, now });
  const releases = () => releasesOf(paths, 'sample').map((release) => path.basename(release));
  return { paths, app, remote, behaviour, events, calls, deploy, releases };
}

test('a first deploy ends with the service running the new release, the health path answering, and the commit printed', async () => {
  const { paths, events, calls, deploy, releases } = world();
  const done = await deploy();
  assert.equal(done.err, '');
  assert.equal(done.code, 0);
  assert.deepEqual(releases(), [`20261121T143000Z-${A}`]);
  const release = path.join(paths.releasesDir('sample'), `20261121T143000Z-${A}`);
  assert.deepEqual(servicePointsAt(paths, 'sample'), { release, start: 'npm start' });
  assert.equal(events.at(-4), `start, pointing at 20261121T143000Z-${A}`);
  assert.match(commandLines(calls).find((line) => line.includes('curl')), / http:\/\/127\.0\.0\.1:3000\/healthz$/);
  assert.match(done.out, new RegExp(`\nsample is running ${A}\\.\n$`));
});

test('the steps run in the fixed order, and the service is pointed at the new release between migrate and start', async () => {
  const { remote, events, deploy } = world();
  await deploy();
  assert.deepEqual(events, [
    'dump', 'fetch', 'config', 'release', 'setup', 'build', 'stop', 'migrate, pointing at nothing',
    `start, pointing at 20261121T143000Z-${A}`, 'health', 'loopback', 'serve',
  ]);
  events.length = 0;
  remote.commit = B;
  await deploy();
  assert.deepEqual(events, [
    'dump', 'fetch', 'config', 'release', 'setup', 'build', 'stop', `migrate, pointing at 20261121T143000Z-${A}`,
    `start, pointing at 20261121T143100Z-${B}`, 'health', 'loopback', 'serve',
  ]);
});

test('a second deploy after a new commit switches to it and leaves the previous release in place', async () => {
  const { paths, remote, deploy, releases } = world();
  await deploy();
  remote.commit = B;
  const done = await deploy();
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(releases(), [`20261121T143000Z-${A}`, `20261121T143100Z-${B}`]);
  assert.equal(commitOf(servicePointsAt(paths, 'sample').release), B);
  assert.match(done.out, new RegExp(`\nsample is running ${B}\\.\n$`));
});

test('after a fourth deploy only the three newest releases remain', async () => {
  const { paths, remote, deploy, releases } = world();
  for (const commit of [A, B, C]) {
    remote.commit = commit;
    await deploy();
  }
  assert.equal(releases().length, 3);
  remote.commit = D;
  const done = await deploy();
  assert.deepEqual(releases(), [`20261121T143100Z-${B}`, `20261121T143200Z-${C}`, `20261121T143300Z-${D}`]);
  assert.equal(commitOf(servicePointsAt(paths, 'sample').release), D);
  assert.match(done.out, new RegExp(`^Removed the old release 20261121T143000Z-${A}$`, 'm'));
  assert.deepEqual(fs.readdirSync(paths.appDir('sample')).sort(), ['current', 'home', 'releases', 'start']);
});

test('the dump is taken before anything is fetched, it is root\'s alone, and its path is printed', async () => {
  const { paths, events, calls, deploy } = world();
  const done = await deploy();
  const file = path.join(paths.deployDumps('sample'), '20261121T143000Z.dump');
  assert.equal(fs.readFileSync(file, 'utf8'), 'a dump of sample\n');
  assert.equal(mode(file), 0o600);
  assert.equal(mode(paths.deployDumps('sample')), 0o700);
  assert.ok(file.startsWith(paths.backupDir + path.sep));
  assert.equal(events[0], 'dump');
  assert.match(commandLines(calls)[0], /pg_dump/);
  assert.equal(done.out.split('\n')[0], `Dumped sample's database to ${file}`);
});

test('each deploy keeps its own dump', async () => {
  const { paths, remote, deploy } = world();
  await deploy();
  remote.commit = B;
  await deploy();
  assert.deepEqual(fs.readdirSync(paths.deployDumps('sample')).sort(), ['20261121T143000Z.dump', '20261121T143100Z.dump']);
});

test('a database that cannot be dumped stops the deploy before anything is fetched', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  const { run, calls } = fakeRun((program) => (program === '/bin/sh' ? { code: 1, stderr: 'pg_dump: error: connection failed\n' } : {}));
  const done = await appsMachine(['deploy', 'sample'], { run, paths });
  assert.equal(done.code, 1);
  assert.equal(done.err, 'error: the deploy stopped at dump: could not dump sample\'s database: pg_dump: error: connection failed\n');
  assert.equal(calls.length, 1);
});

test('setup, build and migrate run in the release as the app\'s user, with the settings and nothing of root\'s', async () => {
  const { paths, calls, deploy } = world();
  writeSettings(paths, 'sample', 'DATABASE_URL=postgres://sample:secret@127.0.0.1:5432/sample\nAPI_KEY="a production key"\n');
  await deploy();
  const { release } = servicePointsAt(paths, 'sample');
  const asApp = calls.filter((call) => call.program === 'runuser' && call.args[1] === 'sample');
  assert.deepEqual(asApp.map((call) => call.args), ['npm ci', 'npm run build', 'npm run migrate'].map((line) => ['-u', 'sample', '--', '/bin/sh', '-c', line]));
  for (const call of asApp) {
    assert.equal(call.cwd, release);
    assert.deepEqual(Object.keys(call.env).sort(), ['API_KEY', 'DATABASE_URL', 'HOME', 'LOGNAME', 'PATH', 'USER']);
    assert.equal(call.env.API_KEY, 'a production key');
    assert.equal(call.env.DATABASE_URL, 'postgres://sample:secret@127.0.0.1:5432/sample');
    assert.equal(call.env.HOME, paths.appHome('sample'));
  }
});

test('the settings file is still root\'s alone after a deploy: no step is given its path, and only the release changes owner', async () => {
  const { paths, calls, deploy } = world();
  const before = fs.statSync(paths.settingsFile('sample'));
  await deploy();
  const after = fs.statSync(paths.settingsFile('sample'));
  assert.equal(after.mode & 0o777, 0o600);
  assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs]);
  assert.equal(mode(paths.settingsDir), 0o700);
  assert.deepEqual(commandLines(calls).filter((line) => line.includes(paths.settingsDir)), []);
  assert.deepEqual(commandLines(calls).filter((line) => line.startsWith('chown')), [`chown -R sample:sample ${servicePointsAt(paths, 'sample').release}`]);
});

test('no secret from the settings is printed', async () => {
  const { paths, deploy } = world();
  writeSettings(paths, 'sample', 'DATABASE_URL=postgres://sample:secret@127.0.0.1:5432/sample\nAPI_KEY=a-production-key\n');
  const done = await deploy();
  assert.equal(done.code, 0, done.err);
  assert.doesNotMatch(done.out + done.err, /secret|a-production-key/);
  assert.deepEqual(Object.keys(readSettings(paths, 'sample')), ['DATABASE_URL', 'API_KEY']);
});

test('a project with no migrate command is deployed without one', async () => {
  const { migrate, ...noMigrate } = DEPLOY;
  const { events, deploy } = world({ remote: { commit: A, config: config(noMigrate) } });
  const done = await deploy();
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(events.slice(4, 8), ['setup', 'build', 'stop', `start, pointing at 20261121T143000Z-${A}`]);
});

test('the Serve mapping goes from the app\'s Serve port to the port in the deploy section, and is made again at every deploy', async () => {
  const { calls, deploy } = world();
  await deploy();
  await deploy();
  assert.deepEqual(commandLines(calls).filter((line) => line.startsWith('tailscale')), Array(2).fill('tailscale serve --bg --https=8443 http://127.0.0.1:3000'));
});

/** After a refusal: nothing was stopped or run as the app, no release was made and nothing waits to become one. */
function assertNothingChanged({ paths, events, releases }, before = null) {
  assert.deepEqual(events, ['dump', 'fetch', 'config']);
  assert.deepEqual(releases(), before ? [path.basename(before.release)] : []);
  assert.deepEqual(servicePointsAt(paths, 'sample'), before);
  assert.ok(!fs.existsSync(paths.incomingRelease('sample')));
}

test('a project whose default branch has no deploy section is refused, and nothing is stopped', async () => {
  const w = world({ remote: { commit: A, config: config(null) } });
  const done = await w.deploy();
  assert.equal(done.code, 1);
  assert.equal(done.err, `error: the deploy stopped at config: the project config at ${A} has no deploy section\n`);
  assertNothingChanged(w);
});

test('a project whose default branch has no project config is refused', async () => {
  const w = world({ remote: { commit: A, config: undefined } });
  const done = await w.deploy();
  assert.equal(done.code, 1);
  assert.equal(done.err, `error: the deploy stopped at config: the default branch has no devkit.json at ${A}\n`);
  assertNothingChanged(w);
});

test('an invalid deploy section is refused with what is wrong with it, and the release that was running still is', async () => {
  const w = world();
  await w.deploy();
  const before = servicePointsAt(w.paths, 'sample');
  const { port, ...noPort } = DEPLOY;
  for (const [broken, wrong] of [
    [config({ ...noPort, healthPath: 'healthz' }), /^devkit\.json is malformed: deploy\.port is required; deploy\.healthPath must match /],
    [config({ ...DEPLOY, branch: 'unmerged' }), /^devkit\.json is malformed: deploy\.branch is not a known field$/],
    ['{ not json', /^devkit\.json is not valid JSON: /],
  ]) {
    w.events.length = 0;
    w.remote.commit = B;
    w.remote.config = broken;
    const done = await w.deploy();
    assert.equal(done.code, 1);
    assert.match(done.err.replace(/^error: the deploy stopped at config: /, '').trimEnd(), wrong);
    assertNothingChanged(w, before);
  }
});

test('a deploy section whose port is a Serve port on the machine is refused before anything is stopped', async () => {
  const w = world({ remote: { commit: A, config: config({ ...DEPLOY, port: 8444 }) } });
  registered(w.paths, { name: 'example_app', servePort: 8444 });
  const done = await w.deploy();
  assert.equal(done.code, 1);
  assert.equal(done.err, 'error: the deploy stopped at config: the deploy section\'s port, 8444, is the Serve port of example_app: Tailscale listens there\n');
  assertNothingChanged(w);
});

test('the command accepts no way to deploy anything other than the default branch', async () => {
  const USAGE = 'usage: apps-machine deploy <name>\n';
  const { paths, calls, deploy } = world();
  for (const more of [['unmerged'], ['--branch', 'unmerged'], [B], ['/home/admin/checkout'], ['--ref=unmerged']]) {
    assert.deepEqual(await deploy(['deploy', 'sample', ...more]), {
      code: 2, out: '', err: `error: a deploy takes an app's name and nothing else: what it deploys is the default branch as GitHub has it\n${USAGE}`,
    });
  }
  for (const argv of [['deploy'], ['deploy', '--branch=unmerged']]) assert.deepEqual(await deploy(argv), { code: 2, out: '', err: USAGE });
  assert.deepEqual(calls, []);
  await deploy();
  assert.deepEqual(commandLines(calls).filter((line) => /^git .*(clone|fetch|pull|checkout|switch)/.test(line)),
    [`git clone --quiet --depth 1 --no-tags git@github.com:example/sample.git ${paths.incomingRelease('sample')}`]);
});

test('an app that is not registered cannot be deployed', async () => {
  const { run, calls } = fakeRun();
  assert.deepEqual(await appsMachine(['deploy', 'sample'], { run }), { code: 1, out: '', err: 'error: no app named sample is registered on this machine\n' });
  assert.deepEqual(calls, []);
});

test('a step that fails stops the command with a non-zero exit naming the step, and no later step runs', async () => {
  const failing = [
    [{ exits: { 'npm ci': 1 } }, 'setup', 'the deploy stopped at setup: `npm ci` exited with 1'],
    [{ exits: { 'npm run build': 2 } }, 'build', 'the deploy stopped at build: `npm run build` exited with 2'],
    [{ exits: { 'npm run migrate': 1 } }, 'migrate, pointing at nothing', 'the deploy stopped at migrate: `npm run migrate` exited with 1'],
    [{ healthy: false }, 'health', 'the deploy stopped at health: /healthz on port 3000 did not answer with success within 90 seconds'],
    [{ listeners: ['LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*'] }, 'loopback', 'the deploy stopped at loopback: port 3000 is open on 0.0.0.0: an app listens on loopback only (127.0.0.1)'],
  ];
  for (const [behaviour, last, message] of failing) {
    const { events, deploy } = world({ behaviour });
    const done = await deploy();
    assert.equal(done.code, 1);
    assert.equal(done.err, `error: ${message}\n`);
    assert.equal(events.at(-1), last);
    assert.doesNotMatch(done.out, /is running/);
  }
});
