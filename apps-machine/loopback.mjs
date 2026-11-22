// The identity gate the apps rest on is Tailscale Serve, in front of each app's local port. An app
// that listens on any address but loopback can be reached around it.

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|\[::1\]|\[::ffff:127\.\d+\.\d+\.\d+\])(%lo)?$/;

/** Throw unless something listens on the TCP `port` and every listener on it is at a loopback address. */
export function checkLoopbackOnly({ run }, port) {
  const done = run('ss', ['-H', '-ltn']);
  if (done.code !== 0) throw new Error(`could not list what the machine listens on: ${done.stderr.trim()}`);
  const addresses = done.stdout.split('\n').filter((line) => line.trim() !== '').map(localAddress).filter((local) => local.port === String(port)).map((local) => local.address);
  if (addresses.length === 0) throw new Error(`nothing is listening on port ${port}`);
  const open = addresses.find((address) => !LOOPBACK.test(address));
  if (open) throw new Error(`port ${port} is open on ${open}: an app listens on loopback only (127.0.0.1)`);
}

/** The local address and port of one line of `ss -H -ltn`: state, two queue lengths, local, peer. */
function localAddress(line) {
  const local = /^LISTEN\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s*$/.exec(line.trim());
  if (!local) throw new Error(`could not read a line of ss's output: ${line.trim()}`);
  return { address: local[1], port: local[2] };
}
