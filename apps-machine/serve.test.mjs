import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serveApp } from './serve.mjs';
import { SAMPLE as sample, fakeRun, machine } from './test-helpers.mjs';

test('an app\'s Serve port is mapped to its local port on loopback, and stays mapped after the command ends', () => {
  const { run, calls } = fakeRun();
  serveApp({ run, paths: machine() }, sample, 3000);
  assert.deepEqual(calls, [{ program: 'tailscale', args: ['serve', '--bg', '--https=8443', 'http://127.0.0.1:3000'] }]);
});

test('a mapping Tailscale would not make fails with what it said', () => {
  const { run } = fakeRun(() => ({ code: 1, stderr: 'Serve is not enabled on your tailnet.\n' }));
  assert.throws(() => serveApp({ run, paths: machine() }, sample, 3000),
    /^Error: could not map Serve port 8443 to sample's port 3000: Serve is not enabled on your tailnet\.$/);
});

test('a local port that is not a port number is refused before Tailscale is asked', () => {
  const { run, calls } = fakeRun();
  for (const port of [0, 70000, '3000', 3000.5, undefined]) {
    assert.throws(() => serveApp({ run, paths: machine() }, sample, port), /^Error: sample's local port is not a port number$/);
  }
  assert.deepEqual(calls, []);
});
