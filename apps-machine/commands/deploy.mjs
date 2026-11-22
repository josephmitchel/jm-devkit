import fs from 'node:fs';
import path from 'node:path';

import { parseDeployConfig } from '../../plugin/devkit-config.mjs';
import { dumpDatabase } from '../database.mjs';
import { HEALTH_TIME_LIMIT_SECONDS, answersHealthy } from '../health.mjs';
import { checkLoopbackOnly } from '../loopback.mjs';
import { serviceName } from '../paths.mjs';
import { readRegistry, registrationOf } from '../registry.mjs';
import { deployConfigOf, fetchDefaultBranch, makeRelease, projectConfigAt, pruneReleases, removeRelease, stampOf } from '../releases.mjs';
import { serveApp } from '../serve.mjs';
import { pointServiceAt, servicePointsAt, startService, stopService } from '../service.mjs';
import { runAsApp } from '../settings.mjs';
import { UsageError } from '../usage.mjs';

export const usage = 'apps-machine deploy <name>';
export const summary = 'put the build of an app\'s default branch, as GitHub has it now, in service';

/**
 * A deploy's steps, in the order they run, each with what the command does when that step fails.
 * Both take the world and the deploy so far: `{ app, stamp, previous }` at first, where `app` is the
 * registration and `previous` is what the service ran before, then `dump`, `checkout`, `commit`,
 * `config` and `release` as steps learn them. Nothing before `stop` touches the running app.
 */
export const STEPS = [
  ['dump', dump, leaveAsItWas],
  ['fetch', fetch, leaveAsItWas],
  ['config', config, leaveAsItWas],
  ['release', release, leaveAsItWas],
  ['setup', asApp('setup'), leaveAsItWas],
  ['build', asApp('build'), leaveAsItWas],
  ['stop', stop, goBack],
  ['migrate', asApp('migrate'), goBack],
  ['point', point, goBack],
  ['start', start, goBack],
  ['health', health, goBack],
  ['loopback', loopback, goBack],
  ['serve', serve, keepNew],
  ['prune', prune, keepNew],
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
    for (const [name, step, afterFailure] of STEPS) {
      try {
        step(world, deploy);
      } catch (e) {
        afterFailure(world, deploy);
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

function answers(world, { port, healthPath }, say) {
  say.write(`Asking ${healthPath} on port ${port}, for ${HEALTH_TIME_LIMIT_SECONDS} seconds at most\n`);
  return answersHealthy(world, { port, healthPath });
}

function health(world, deploy) {
  const { port, healthPath } = deploy.config;
  if (!answers(world, deploy.config, world.out)) throw new Error(`${healthPath} on port ${port} did not answer with success within ${HEALTH_TIME_LIMIT_SECONDS} seconds`);
}

function loopback(world, deploy) {
  checkLoopbackOnly(world, deploy.app.name, deploy.config.port);
}

function serve(world, deploy) {
  serveApp(world, deploy.app, deploy.config.port);
  world.out.write(`Serve port ${deploy.app.servePort} goes to port ${deploy.config.port}\n`);
}

function prune(world, deploy) {
  for (const old of pruneReleases(world.paths, deploy.app.name)) world.out.write(`Removed the old release ${path.basename(old)}\n`);
}

/** After a failure before `stop`: the service was not touched, and the release this deploy was making goes. */
function leaveAsItWas(world, deploy) {
  const { app, previous } = deploy;
  const runs = previous ? `on the release ${path.basename(previous.release)}` : 'with no release to run';
  world.err.write(`Nothing was stopped: ${serviceName(app.name)} is as it was, ${runs}.\n`);
  removeFailedRelease(world, deploy);
}

/** After a failure from `stop` on: the service runs what it ran before, and the release this deploy made goes. The data stays. */
function goBack(world, deploy) {
  const { paths, err } = world;
  const { app, previous } = deploy;
  const service = serviceName(app.name);
  try {
    if (previous) err.write(`Putting the previous release back: ${path.basename(previous.release)}\n`);
    stopService(world, app.name);
    pointServiceAt(world, app.name, previous);
    if (previous) {
      startService(world, app.name);
      const healthy = answers(world, deployConfigOf(previous.release), err);
      err.write(healthy
        ? 'The previous release is running again, and its health path answers.\n'
        : `The previous release was started, but its health path did not answer with success within ${HEALTH_TIME_LIMIT_SECONDS} seconds.\n`);
    } else {
      err.write(`There is no previous release to go back to: ${service} is left stopped.\n`);
    }
  } catch (e) {
    const current = servicePointsAt(paths, app.name);
    err.write(`Going back did not finish: ${e.message}. ${service} points at ${current ? `the release ${path.basename(current.release)}` : 'no release'}.\n`);
  }
  removeFailedRelease(world, deploy);
  err.write(`The database was not put back: it is as this deploy left it. The dump this deploy took before anything else: ${deploy.dump}\n`);
  err.write(`To put the database back as it was then: sudo apps-machine restore ${app.name} ${deploy.dump}\n`);
}

/** After a failure once the new release has passed its checks: it is what the app runs, and nothing is undone. */
function keepNew({ err }, { app, commit }) {
  err.write(`${app.name} is running ${commit}: the new release passed its checks and stays in service. What failed is done again by the next deploy.\n`);
}

function removeFailedRelease({ paths, err }, deploy) {
  if (!deploy.release || servicePointsAt(paths, deploy.app.name)?.release === deploy.release) return;
  removeRelease(deploy.release);
  err.write(`Removed the failed release ${path.basename(deploy.release)}\n`);
}
