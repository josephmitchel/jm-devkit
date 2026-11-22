// An app's service: one systemd unit per app, written from `app.service.template`. The unit runs
// whatever `paths.startFile` holds, from wherever `paths.currentRelease` links to, so pointing the
// service at a release is writing those two and never the unit.

import fs from 'node:fs';
import path from 'node:path';

import { serviceName } from './paths.mjs';

const TEMPLATE = path.join(import.meta.dirname, 'app.service.template');

/** The text of an app's unit. */
export function renderUnit(paths, app) {
  const values = { app, settingsFile: paths.settingsFile(app), currentRelease: paths.currentRelease(app), startFile: paths.startFile(app) };
  return fs.readFileSync(TEMPLATE, 'utf8').replace(/\{\{(\w+)\}\}/g, (braces, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`${TEMPLATE} asks for ${braces}, which no app has`);
    return values[name];
  });
}

function systemctl({ run }, ...args) {
  const done = run('systemctl', args);
  if (done.code !== 0) throw new Error(`systemctl ${args.join(' ')} failed: ${done.stderr.trim()}`);
}

function replaceFile(file, text) {
  fs.writeFileSync(`${file}.new`, text, { mode: 0o644 });
  fs.chmodSync(`${file}.new`, 0o644);
  fs.renameSync(`${file}.new`, file);
}

function writeUnit(world, app) {
  const file = world.paths.unitFile(app);
  const unit = renderUnit(world.paths, app);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === unit) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  replaceFile(file, unit);
  systemctl(world, 'daemon-reload');
}

/** Write the app's unit as the template has it and have it start at boot. Starts nothing. Safe to repeat. */
export function installService(world, app) {
  writeUnit(world, app);
  if (world.run('systemctl', ['is-enabled', '--quiet', serviceName(app)]).code !== 0) systemctl(world, 'enable', serviceName(app));
}

export function stopService(world, app) {
  systemctl(world, 'stop', serviceName(app));
}

export function startService(world, app) {
  systemctl(world, 'start', serviceName(app));
}

/** What the app's service runs: `{ release, start }`, or `null` when it has never been pointed at a release. */
export function servicePointsAt(paths, app) {
  let link;
  try {
    link = fs.readlinkSync(paths.currentRelease(app));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return {
    release: path.resolve(paths.appDir(app), link),
    start: fs.readFileSync(paths.startFile(app), 'utf8').replace(/\n$/, ''),
  };
}

/**
 * Make the app's service run the release directory `release` with the shell command `start`, from
 * its next start on; or, given `null`, nothing. Takes what `servicePointsAt` returns. Stops and starts nothing.
 */
export function pointServiceAt(world, app, target) {
  const { paths } = world;
  const link = paths.currentRelease(app);
  if (target === null) {
    fs.rmSync(link, { force: true });
    fs.rmSync(paths.startFile(app), { force: true });
    return;
  }
  const { release, start } = target;
  const isRelease = path.dirname(release) === paths.releasesDir(app) && fs.statSync(release, { throwIfNoEntry: false })?.isDirectory();
  if (!isRelease) throw new Error(`${release} is not a release of ${app}`);
  if (typeof start !== 'string' || start.trim() === '') throw new Error('a release needs a start command');
  writeUnit(world, app);
  replaceFile(paths.startFile(app), `${start}\n`);
  fs.rmSync(`${link}.new`, { force: true });
  fs.symlinkSync(path.relative(paths.appDir(app), release), `${link}.new`);
  fs.renameSync(`${link}.new`, link);
}
