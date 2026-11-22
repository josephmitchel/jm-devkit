// How an app is reached: Tailscale Serve maps the app's Serve port, on the machine's Tailscale
// address, to the port the app listens on at loopback.

import { isPort } from './registry.mjs';
import { must } from './run.mjs';

/**
 * Make the mapping for a registered app, or make it again as it is. `localPort` is the `port` of
 * the project's `deploy` section. Tailscale keeps the mapping over restarts.
 */
export function serveApp({ run }, { name, servePort }, localPort) {
  if (!isPort(localPort)) throw new Error(`${name}'s local port is not a port number`);
  must(run('tailscale', ['serve', '--bg', `--https=${servePort}`, `http://127.0.0.1:${localPort}`]), `could not map Serve port ${servePort} to ${name}'s port ${localPort}`);
}
