import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { commitOf, deployConfigOf, releasesOf } from '../releases.mjs';
import { servicePointsAt } from '../service.mjs';
import { readSettings, writeSettings } from '../settings.mjs';
import { appsMachine, commandLines, deployPrograms, fakeRun, machine, mode, registered } from '../test-helpers.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

const NEVER_DEPLOYED = 'Nothing was stopped: app-sample.service is as it was, with no release to run.\n';

const DEPLOY = { setup: 'npm ci', build: 'npm run build', migrate: 'npm run migrate', start: 'npm start', port: 3000, healthPath: '/healthz' };
/** A project config with this deploy section, or with none. */
const config = (deploy = DEPLOY) => ({ modules: ['process'], reviewer: { tests: [{ name: 'unit', command: 'npm test' }] }, ...(deploy && { deploy }) });


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
  assert.deepEqual(fs.readdirSync(paths.releasesDir('sample')).sort(), releases().flatMap((name) => [name, `${name}.json`]));
  assert.deepEqual(deployConfigOf(servicePointsAt(paths, 'sample').release), DEPLOY);
});

test('the dump is taken before anything is fetched, it is root\'s alone, and its path is printed', async () => {
  const { paths, events, calls, deploy } = world();
  const done = await deploy();
  const file = path.join(paths.deployDumps('sample'), '20261121T143000Z.dump');
  assert.deepEqual(fs.readFileSync(file), Buffer.from('PGDMPdump of sample\0\xff', 'latin1'));
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
  assert.equal(done.err, `${NEVER_DEPLOYED}error: the deploy stopped at dump: could not dump sample's database: pg_dump: error: connection failed\n`);
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
  assert.equal(done.err, `${NEVER_DEPLOYED}error: the deploy stopped at config: the project config at ${A} has no deploy section\n`);
  assertNothingChanged(w);
});

test('a project whose default branch has no project config is refused', async () => {
  const w = world({ remote: { commit: A, config: undefined } });
  const done = await w.deploy();
  assert.equal(done.code, 1);
  assert.equal(done.err, `${NEVER_DEPLOYED}error: the deploy stopped at config: the default branch has no devkit.json at ${A}\n`);
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
    assert.match(done.err.replace(`Nothing was stopped: app-sample.service is as it was, on the release 20261121T143000Z-${A}.\nerror: the deploy stopped at config: `, '').trimEnd(), wrong);
    assertNothingChanged(w, before);
  }
});

test('a deploy section whose port is a Serve port on the machine is refused before anything is stopped', async () => {
  const w = world({ remote: { commit: A, config: config({ ...DEPLOY, port: 8444 }) } });
  registered(w.paths, { name: 'example_app', servePort: 8444 });
  const done = await w.deploy();
  assert.equal(done.code, 1);
  assert.equal(done.err, `${NEVER_DEPLOYED}error: the deploy stopped at config: the deploy section's port, 8444, is the Serve port of example_app: Tailscale listens there\n`);
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

/** A machine where commit A is in service with the start command `npm start`, and the default branch has moved to B, started another way. */
async function deployedOnce(behaviour = {}) {
  const w = world({ behaviour });
  await w.deploy();
  w.before = servicePointsAt(w.paths, 'sample');
  w.events.length = 0;
  w.calls.length = 0;
  w.remote.commit = B;
  w.remote.config = config({ ...DEPLOY, start: 'node server.js' });
  return w;
}

const systemctl = (calls) => commandLines(calls).filter((line) => line.startsWith('systemctl'));

test('a failing setup or build leaves the running release in service and never stopped, and removes the release it was making', async () => {
  for (const [exits, step, message] of [
    [{ 'npm ci': 1 }, 'setup', 'the deploy stopped at setup: `npm ci` exited with 1'],
    [{ 'npm run build': 2 }, 'build', 'the deploy stopped at build: `npm run build` exited with 2'],
  ]) {
    const { paths, behaviour, before, events, calls, deploy, releases } = await deployedOnce();
    behaviour.exits = exits;
    const done = await deploy();
    assert.equal(done.code, 1);
    assert.equal(done.err, `Nothing was stopped: app-sample.service is as it was, on the release 20261121T143000Z-${A}.\nRemoved the failed release 20261121T143100Z-${B}\nerror: ${message}\n`);
    assert.equal(events.at(-1), step);
    assert.deepEqual(systemctl(calls), []);
    assert.deepEqual(servicePointsAt(paths, 'sample'), before);
    assert.deepEqual(fs.readdirSync(paths.releasesDir('sample')).sort(), [`20261121T143000Z-${A}`, `20261121T143000Z-${A}.json`]);
    assert.deepEqual(releases(), [`20261121T143000Z-${A}`]);
    assert.doesNotMatch(done.out, /is running/);
  }
});

test('a failing migrate, health path or loopback check ends with the previous release in service and started, and a non-zero exit naming the step', async () => {
  for (const [behaviour, message] of [
    [{ exits: { 'npm run migrate': 1 } }, 'the deploy stopped at migrate: `npm run migrate` exited with 1'],
    [{ unhealthy: [B] }, 'the deploy stopped at health: /healthz on port 3000 did not answer with success within 90 seconds'],
    [{ listeners: ['LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*'] }, 'the deploy stopped at loopback: port 3000 is open on 0.0.0.0: an app listens on loopback only (127.0.0.1)'],
  ]) {
    const w = await deployedOnce();
    Object.assign(w.behaviour, behaviour);
    const done = await w.deploy();
    assert.equal(done.code, 1);
    assert.equal(done.err.split('\n').at(-2), `error: ${message}`);
    assert.deepEqual(servicePointsAt(w.paths, 'sample'), w.before);
    assert.equal(w.before.start, 'npm start');
    assert.deepEqual(w.events.slice(w.events.lastIndexOf('stop')), ['stop', `start, pointing at 20261121T143000Z-${A}`, 'health']);
    assert.equal(systemctl(w.calls).at(-1), 'systemctl start app-sample.service');
    assert.deepEqual(fs.readdirSync(w.paths.releasesDir('sample')).sort(), [`20261121T143000Z-${A}`, `20261121T143000Z-${A}.json`]);
    assert.doesNotMatch(done.out, /is running/);
  }
});

test('after going back, the output names the dump the deploy took and the command that restores it, and the command has not touched the database', async () => {
  const { paths, behaviour, calls, deploy } = await deployedOnce();
  behaviour.exits = { 'npm run migrate': 1 };
  const done = await deploy();
  const dump = path.join(paths.deployDumps('sample'), '20261121T143100Z.dump');
  assert.equal(done.err, [
    `Putting the previous release back: 20261121T143000Z-${A}`,
    'Asking /healthz on port 3000, for 90 seconds at most',
    'The previous release is running again, and its health path answers.',
    `Removed the failed release 20261121T143100Z-${B}`,
    `The database was not put back: it is as this deploy left it. The dump this deploy took before anything else: ${dump}`,
    `To put the database back as it was then: sudo apps-machine restore sample ${dump}`,
    'error: the deploy stopped at migrate: `npm run migrate` exited with 1',
    '',
  ].join('\n'));
  assert.ok(fs.existsSync(dump));
  const lines = commandLines(calls);
  assert.match(lines[0], /pg_dump/);
  assert.deepEqual(lines.slice(1).filter((line) => /postgres|psql|pg_|dropdb|createdb/.test(line)), []);
  assert.deepEqual(lines.slice(lines.indexOf('runuser -u sample -- /bin/sh -c npm run migrate') + 1).map((line) => line.split(' ').slice(0, 2).join(' ')),
    ['systemctl stop', 'systemctl start', 'timeout --foreground']);
});

test('a deploy interrupted once the service is stopped goes back as after any failure, and says it was interrupted', async () => {
  const { paths, behaviour, before, events, deploy } = await deployedOnce();
  behaviour.interruptedAt = 'health';
  const done = await deploy();
  assert.equal(done.code, 1);
  assert.deepEqual(servicePointsAt(paths, 'sample'), before);
  assert.deepEqual(events.slice(events.lastIndexOf('stop')), ['stop', `start, pointing at 20261121T143000Z-${A}`, 'health']);
  const said = done.err.split('\n');
  assert.equal(said[2], 'The previous release is running again, and its health path answers.');
  assert.equal(said.at(-3), `To put the database back as it was then: sudo apps-machine restore sample ${path.join(paths.deployDumps('sample'), '20261121T143100Z.dump')}`);
  assert.equal(said.at(-2), 'error: the deploy stopped at health: interrupted by SIGINT');
});

test('when the previous release does not answer its health path either, the going back says so', async () => {
  const { paths, behaviour, before, events, deploy } = await deployedOnce();
  behaviour.healthy = false;
  const done = await deploy();
  assert.equal(done.code, 1);
  assert.deepEqual(servicePointsAt(paths, 'sample'), before);
  assert.deepEqual(events.slice(-3), ['stop', `start, pointing at 20261121T143000Z-${A}`, 'health']);
  assert.match(done.err, /^The previous release was started, but its health path did not answer with success within 90 seconds\.$/m);
  assert.doesNotMatch(done.err, /is running again/);
  assert.match(done.err, /\nerror: the deploy stopped at health: [^\n]+\n$/);
});

test('a failed first deploy leaves the service stopped, pointing at nothing, and says there was nothing to go back to', async () => {
  for (const [behaviour, step] of [
    [{ exits: { 'npm run migrate': 1 } }, 'migrate'],
    [{ healthy: false }, 'health'],
    [{ listeners: ['LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*'] }, 'loopback'],
  ]) {
    const { paths, calls, deploy } = world({ behaviour });
    const done = await deploy();
    const dump = path.join(paths.deployDumps('sample'), '20261121T143000Z.dump');
    assert.equal(done.code, 1);
    assert.equal(done.err.split('\n').slice(0, -2).join('\n'), [
      'There is no previous release to go back to: app-sample.service is left stopped.',
      `Removed the failed release 20261121T143000Z-${A}`,
      `The database was not put back: it is as this deploy left it. The dump this deploy took before anything else: ${dump}`,
      `To put the database back as it was then: sudo apps-machine restore sample ${dump}`,
    ].join('\n'));
    assert.match(done.err, new RegExp(`\nerror: the deploy stopped at ${step}: [^\n]+\n$`));
    assert.equal(servicePointsAt(paths, 'sample'), null);
    assert.equal(systemctl(calls).at(-1), 'systemctl stop app-sample.service');
    assert.equal(commandLines(calls).at(-1), 'systemctl stop app-sample.service');
    assert.deepEqual(fs.readdirSync(paths.releasesDir('sample')), []);
    assert.deepEqual(fs.readdirSync(paths.appDir('sample')).sort(), ['home', 'releases']);
  }
});

test('a first deploy that fails at setup or build has stopped nothing and leaves no release', async () => {
  const { paths, calls, deploy } = world({ behaviour: { exits: { 'npm run build': 1 } } });
  const done = await deploy();
  assert.equal(done.code, 1);
  assert.equal(done.err, `${NEVER_DEPLOYED}Removed the failed release 20261121T143000Z-${A}\nerror: the deploy stopped at build: \`npm run build\` exited with 1\n`);
  assert.equal(servicePointsAt(paths, 'sample'), null);
  assert.deepEqual(systemctl(calls), []);
  assert.deepEqual(fs.readdirSync(paths.releasesDir('sample')), []);
});

test('a release that cannot be handed to the app\'s user is not left among the releases', async () => {
  const { paths, behaviour, before, calls, deploy } = await deployedOnce();
  behaviour.exits = { [`chown -R sample:sample ${path.join(paths.releasesDir('sample'), `20261121T143100Z-${B}`)}`]: 1 };
  const done = await deploy();
  assert.equal(done.code, 1);
  assert.match(done.err, /\nerror: the deploy stopped at release: could not give /);
  assert.deepEqual(fs.readdirSync(paths.releasesDir('sample')).sort(), [`20261121T143000Z-${A}`, `20261121T143000Z-${A}.json`]);
  assert.deepEqual(servicePointsAt(paths, 'sample'), before);
  assert.deepEqual(systemctl(calls), []);
});

test('when going back cannot be finished the command says so and where the service points, and still names the step, the dump and the restore', async () => {
  const { paths, behaviour, before, calls, deploy, releases } = await deployedOnce();
  behaviour.exits = { 'systemctl start app-sample.service': 1 };
  const done = await deploy();
  const dump = path.join(paths.deployDumps('sample'), '20261121T143100Z.dump');
  assert.equal(done.code, 1);
  assert.equal(done.err, [
    `Putting the previous release back: 20261121T143000Z-${A}`,
    `Going back did not finish: systemctl start app-sample.service failed: systemctl could not do that. app-sample.service points at the release 20261121T143000Z-${A}.`,
    `Removed the failed release 20261121T143100Z-${B}`,
    `The database was not put back: it is as this deploy left it. The dump this deploy took before anything else: ${dump}`,
    `To put the database back as it was then: sudo apps-machine restore sample ${dump}`,
    'error: the deploy stopped at start: systemctl start app-sample.service failed: systemctl could not do that',
    '',
  ].join('\n'));
  assert.deepEqual(servicePointsAt(paths, 'sample'), before);
  assert.deepEqual(systemctl(calls), ['stop', 'start', 'stop', 'start'].map((verb) => `systemctl ${verb} app-sample.service`));
  assert.deepEqual(releases(), [`20261121T143000Z-${A}`]);
});

test('a service that cannot be stopped is left on the release it was on, and the release that was being put in service stays if the service points at it', async () => {
  const stuck = await deployedOnce();
  stuck.behaviour.exits = { 'systemctl stop app-sample.service': 1 };
  const refused = await stuck.deploy();
  assert.equal(refused.code, 1);
  assert.match(refused.err, /\nerror: the deploy stopped at stop: systemctl stop app-sample\.service failed: systemctl could not do that\n$/);
  assert.deepEqual(servicePointsAt(stuck.paths, 'sample'), stuck.before);
  assert.deepEqual(stuck.releases(), [`20261121T143000Z-${A}`]);

  const w = await deployedOnce({ unhealthy: [B] });
  w.behaviour.exits = { get 'systemctl stop app-sample.service'() { return w.events.includes('health') ? 1 : undefined; } };
  const done = await w.deploy();
  assert.equal(done.code, 1);
  assert.match(done.err, new RegExp(`^Going back did not finish: systemctl stop app-sample\\.service failed: systemctl could not do that\\. app-sample\\.service points at the release 20261121T143100Z-${B}\\.$`, 'm'));
  assert.doesNotMatch(done.err, /Removed the failed release/);
  assert.equal(commitOf(servicePointsAt(w.paths, 'sample').release), B);
  assert.deepEqual(w.releases(), [`20261121T143000Z-${A}`, `20261121T143100Z-${B}`]);
});

test('a failure after the new release passed its checks leaves it in service, and the exit is still non-zero naming the step', async () => {
  const { paths, behaviour, calls, deploy, releases } = await deployedOnce();
  behaviour.exits = { 'tailscale serve --bg --https=8443 http://127.0.0.1:3000': 1 };
  const done = await deploy();
  assert.equal(done.code, 1);
  assert.equal(done.err, [
    `sample is running ${B}: the new release passed its checks and stays in service. What failed is done again by the next deploy.`,
    'error: the deploy stopped at serve: could not map Serve port 8443 to sample\'s port 3000: tailscale could not do that',
    '',
  ].join('\n'));
  assert.deepEqual(servicePointsAt(paths, 'sample'), { release: path.join(paths.releasesDir('sample'), `20261121T143100Z-${B}`), start: 'node server.js' });
  assert.deepEqual(systemctl(calls), ['stop', 'start'].map((verb) => `systemctl ${verb} app-sample.service`));
  assert.deepEqual(releases(), [`20261121T143000Z-${A}`, `20261121T143100Z-${B}`]);
});
