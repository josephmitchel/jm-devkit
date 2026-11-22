// What leaves the machine each night: the bundles, uploaded with `rclone` to the storage the owner
// configured, and the alive request, made with `curl`. The storage credential stays in rclone's
// config file and the address goes to curl on its input, so neither is ever an argument.

import fs from 'node:fs';

import { parseBundleName } from './bundle.mjs';

/** The one value of a settings file of the machine's: its first line that is not blank or a `#` comment, or null. */
function valueIn(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).find((line) => line !== '' && !line.startsWith('#')) ?? null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

const NAMED_REMOTE = /^[\w.+@][\w.+@ -]*:/;

/**
 * Where the bundles are uploaded, as rclone names it: `<remote>:<folder>`. Throws when uploads are
 * not set up. Only a remote named in the config is taken, because a remote spelled out in the
 * destination could carry its credential into an argument list.
 */
export function storageOf(paths) {
  const storage = valueIn(paths.backupStorage);
  if (storage === null) throw new Error(`uploads are not set up: ${paths.backupStorage} names no storage. Put the rclone destination there, <remote>:<folder>, and define the remote with: sudo rclone config --config ${paths.rcloneConfig}`);
  if (!NAMED_REMOTE.test(storage)) throw new Error(`uploads are not set up: ${paths.backupStorage} must hold <remote>:<folder>, where <remote> is the name of a remote in ${paths.rcloneConfig}`);
  if (!fs.existsSync(paths.rcloneConfig)) throw new Error(`uploads are not set up: there is no ${paths.rcloneConfig} to define the remote. Make it with: sudo rclone config --config ${paths.rcloneConfig}`);
  return storage;
}

const onStorage = (storage, name) => (/[:/]$/.test(storage) ? `${storage}${name}` : `${storage}/${name}`);

function rclone({ run, paths }, verb, args) {
  return run('rclone', [verb, '--config', paths.rcloneConfig, ...args], { cwd: paths.root });
}

/** Put a bundle on the storage under its own name, replacing one of that name. */
export function uploadBundle(world, storage, { app, name, file }) {
  const done = rclone(world, 'copyto', ['--ignore-times', file, onStorage(storage, name)]);
  if (done.code !== 0) throw new Error(`could not upload ${app}'s bundle: ${done.stderr.trim()}`);
}

/** The bundles on the storage by name, as `parseBundleName` gives them. Anything there that is not a bundle is passed over. */
export function bundlesOnStorage(world, storage) {
  const done = rclone(world, 'lsf', ['--files-only', storage]);
  if (done.code !== 0) throw new Error(`could not list the bundles on the storage: ${done.stderr.trim()}`);
  return done.stdout.split('\n').sort().map(parseBundleName).filter(Boolean);
}

export function removeFromStorage(world, storage, { name }) {
  const done = rclone(world, 'deletefile', [onStorage(storage, name)]);
  if (done.code !== 0) throw new Error(`could not remove ${name} from the storage: ${done.stderr.trim()}`);
}

const HTTP_ADDRESS = /^https?:\/\/[^\s"\\]+$/;

/** The address the owner set for the alive request, or null when he set none. One that curl's config could not hold as it is throws, unprinted. */
export function aliveAddressOf(paths) {
  const address = valueIn(paths.backupAliveAddress);
  if (address !== null && !(HTTP_ADDRESS.test(address) && URL.canParse(address))) {
    throw new Error(`${paths.backupAliveAddress} does not hold an http or https address, so the alive request was not made`);
  }
  return address;
}

const CURL_EXITS = { 6: 'its host was not found', 7: 'it could not be reached', 22: 'it answered with an error', 28: 'it did not answer in time' };

/**
 * Request the alive address once. curl reads it from a config on its input and what curl prints is
 * dropped, since its messages name the address's host: a failure is told by exit code alone.
 */
export function requestAlive({ run, paths }, address) {
  const done = run('curl', ['--disable', '--config', '-', '--fail', '--silent', '--globoff', '--max-time', '10', '--retry', '5', '--output', '/dev/null'], { input: `url = "${address}"\n`, cwd: paths.root });
  if (done.code !== 0) throw new Error(`the alive request failed: ${CURL_EXITS[done.code] ?? 'curl could not make it'} (curl exit ${done.code})`);
}
