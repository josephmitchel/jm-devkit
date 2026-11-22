import fs from 'node:fs';
import path from 'node:path';

import { parseDeployConfig } from '../../plugin/devkit-config.mjs';
import { dumpDatabase } from '../database.mjs';
import { HEALTH_TIME_LIMIT_SECONDS, answersHealthy } from '../health.mjs';
import { checkLoopbackOnly } from '../loopback.mjs';
import { serviceName } from '../paths.mjs';
import { readRegistry, registrationOf } from '../registry.mjs';
import { fetchDefaultBranch, makeRelease, projectConfigAt, pruneReleases, stampOf } from '../releases.mjs';
import { serveApp } from '../serve.mjs';
import { pointServiceAt, servicePointsAt, startService, stopService } from '../service.mjs';
import { runAsApp } from '../settings.mjs';
import { UsageError } from '../usage.mjs';

export const usage = 'apps-machine deploy <name>';
export const summary = 'put the build of an app\'s default branch, as GitHub has it now, in service';

/**
 * A deploy's steps, in the order they run. Each takes the world and the deploy so far:
 * `{ app, stamp, previous }` at first, where `app` is the registration and `previous` is what the
 * service ran before, then `dump`, `checkout`, `commit`, `config` and `release` as steps learn them.
 * Nothing before `stop` touches the running app.
 */
export const STEPS = [
  ['dump', dump],
  ['fetch', fetch],
  ['config', config],
  ['release', release],
  ['setup', asApp('setup')],
  ['build', asApp('build')],
  ['stop', stop],
  ['migrate', asApp('migrate')],
  ['point', point],
  ['start', start],
  ['health', health],
  ['loopback', loopback],
  ['serve', serve],
  ['prune', prune],
];

/** A deploy that a step ended. `step` is that step's name in `STEPS`. */
export class DeployStopped extends Error {
  constructor(step, cause) {
    super(`the deploy stopped at ${step}: ${cause.message}`);
    this.name = 'DeployStopped';
    this.step = step;
  }
}

export function command(args, world) {
  if (args.length !== 1 || args[0].startsWith('-')) {
    throw new UsageError(args.length > 1 ? 'a deploy takes an app\'s name and nothing else: what it deploys is the default branch as GitHub has it' : '');
  }
  const { paths, out, now } = world;
  const app = registrationOf(paths, args[0]);
  const deploy = { app, stamp: stampOf(now()), previous: servicePointsAt(paths, app.name) };
  try {
    for (const [name, step] of STEPS) {
      try {
        step(world, deploy);
      } catch (e) {
        throw new DeployStopped(name, e);
      }
    }
  } finally {
    fs.rmSync(paths.incomingRelease(app.name), { recursive: true, force: true });
  }
  out.write(`${app.name} is running ${deploy.commit}.\n`);
}

function dump(world, deploy) {
  const dir = world.paths.deployDumps(deploy.app.name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  deploy.dump = path.join(dir, `${deploy.stamp}.dump`);
  dumpDatabase(world, deploy.app.name, deploy.dump);
  world.out.write(`Dumped ${deploy.app.name}'s database to ${deploy.dump}\n`);
}

function fetch(world, deploy) {
  Object.assign(deploy, fetchDefaultBranch(world, deploy.app));
  world.out.write(`Fetched ${deploy.commit} from ${deploy.app.repository}\n`);
}

function config(world, deploy) {
  const section = parseDeployConfig(projectConfigAt(world, deploy));
  if (!section) throw new Error(`the project config at ${deploy.commit} has no deploy section`);
  const holder = readRegistry(world.paths).find((other) => other.servePort === section.port);
  if (holder) throw new Error(`the deploy section's port, ${section.port}, is the Serve port of ${holder.name}: Tailscale listens there`);
  deploy.config = section;
}

function release(world, deploy) {
  deploy.release = makeRelease(world, deploy.app.name, deploy);
}

/** A step that is one of the deploy section's commands, run in the release as the app's user with the app's settings. */
function asApp(step) {
  return (world, deploy) => {
    const line = deploy.config[step];
    if (line === undefined) return;
    world.out.write(`Running ${step}: ${line}\n`);
    const done = runAsApp(world, deploy.app.name, line, { cwd: deploy.release, live: true });
    if (done.code !== 0) throw new Error(`\`${line}\` exited with ${done.code}`);
  };
}

function stop(world, deploy) {
  world.out.write(`Stopping ${serviceName(deploy.app.name)}\n`);
  stopService(world, deploy.app.name);
}

function point(world, deploy) {
  pointServiceAt(world, deploy.app.name, { release: deploy.release, start: deploy.config.start });
}

function start(world, deploy) {
  world.out.write(`Starting ${serviceName(deploy.app.name)} on ${path.basename(deploy.release)}\n`);
  startService(world, deploy.app.name);
}

function health(world, deploy) {
  const { port, healthPath } = deploy.config;
  world.out.write(`Asking ${healthPath} on port ${port}, for ${HEALTH_TIME_LIMIT_SECONDS} seconds at most\n`);
  if (!answersHealthy(world, deploy.config)) throw new Error(`${healthPath} on port ${port} did not answer with success within ${HEALTH_TIME_LIMIT_SECONDS} seconds`);
}

function loopback(world, deploy) {
  checkLoopbackOnly(world, deploy.config.port);
}

function serve(world, deploy) {
  serveApp(world, deploy.app, deploy.config.port);
  world.out.write(`Serve port ${deploy.app.servePort} goes to port ${deploy.config.port}\n`);
}

function prune(world, deploy) {
  for (const old of pruneReleases(world.paths, deploy.app.name)) world.out.write(`Removed the old release ${path.basename(old)}\n`);
}
