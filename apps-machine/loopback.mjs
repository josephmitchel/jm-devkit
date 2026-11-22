// The identity gate the apps rest on is Tailscale Serve, in front of each app's local port. An app
// that listens on any address but loopback can be reached around it, and a port another app
// listens on answers for the wrong app.

import { must } from './run.mjs';

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|\[::1\]|\[::ffff:127\.\d+\.\d+\.\d+\])(%lo)?$/;

/**
 * Throw unless the app's Linux user, and nobody else, listens on the TCP `port`, and every TCP
 * listener of that user's, on any port, is at a loopback address.
 */
export function checkLoopbackOnly({ run }, app, port) {
  const uid = must(run('id', ['-u', app]), `could not tell which listeners are ${app}'s`).stdout.trim();
  const listed = must(run('ss', ['-H', '-ltne']), 'could not list what the machine listens on');
  const listeners = listed.stdout.split('\n').filter((line) => line.trim() !== '').map(listener);
  const onPort = listeners.filter((one) => one.port === String(port));
  if (onPort.length === 0) throw new Error(`nothing is listening on port ${port}`);
  const stranger = onPort.find((one) => one.uid !== uid);
  if (stranger) throw new Error(`port ${port} is listened on by another user of this machine (uid ${stranger.uid}), not by ${app}: two apps cannot have the same port`);
  const open = listeners.find((one) => one.uid === uid && !LOOPBACK.test(one.address));
  if (open) throw new Error(`${app} listens on ${open.address}, port ${open.port}: an app listens on loopback only (127.0.0.1)`);
}

/** One line of `ss -H -ltne`: state, two queue lengths, local, peer, then the socket's details, where root's socket has no `uid:`. */
function listener(line) {
  const read = /^LISTEN\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s+(?:uid:(\d+)\s+)?ino:\d+\s/.exec(line.trim());
  if (!read) throw new Error(`could not read a line of ss's output: ${line.trim()}`);
  return { address: read[1], port: read[2], uid: read[3] ?? '0' };
}
