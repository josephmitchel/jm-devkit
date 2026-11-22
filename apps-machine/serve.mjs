// How an app is reached: Tailscale Serve maps the app's Serve port, on the machine's Tailscale
// address, to the port the app listens on at loopback.

/**
 * Make the mapping for a registered app, or make it again as it is. `localPort` is the `port` of
 * the project's `deploy` section. Tailscale keeps the mapping over restarts.
 */
export function serveApp({ run }, { name, servePort }, localPort) {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error(`${name}'s local port is not a port number`);
  const done = run('tailscale', ['serve', '--bg', `--https=${servePort}`, `http://127.0.0.1:${localPort}`]);
  if (done.code !== 0) throw new Error(`could not map Serve port ${servePort} to ${name}'s port ${localPort}: ${done.stderr.trim()}`);
}
