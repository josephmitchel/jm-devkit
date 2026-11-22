import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HEALTH_ANSWER_SECONDS, HEALTH_TIME_LIMIT_SECONDS, answersHealthy } from './health.mjs';
import { commandLines, fakeRun, machine } from './test-helpers.mjs';

test('an app whose health path answers with success in time is healthy', () => {
  const { run, calls } = fakeRun();
  assert.equal(answersHealthy({ run, paths: machine() }, { port: 3000, healthPath: '/healthz' }), true);
  assert.equal(calls.length, 1);
  assert.match(commandLines(calls)[0], / http:\/\/127\.0\.0\.1:3000\/healthz$/);
});

test('an app that has not answered with success when the time limit passes is not healthy', () => {
  for (const code of [124, 7, 22, 47]) {
    const { run } = fakeRun(() => ({ code, stderr: 'curl: (22) The requested URL returned error: 503\n' }));
    assert.equal(answersHealthy({ run, paths: machine() }, { port: 3000, healthPath: '/healthz' }), false);
  }
});

test('the asking stops at the time limit, an ask is given up on sooner, and a redirect or an error is not an answer', () => {
  assert.equal(HEALTH_TIME_LIMIT_SECONDS, 90);
  assert.equal(HEALTH_ANSWER_SECONDS, 30);
  const { run, calls } = fakeRun();
  answersHealthy({ run, paths: machine() }, { port: 8080, healthPath: '/up?deep=1' });
  const [line] = commandLines(calls);
  assert.match(line, /^timeout 90 curl /);
  assert.match(line, / --max-time 30 /);
  assert.match(line, / --fail /);
  assert.match(line, / --location --max-redirs 0 /);
  assert.match(line, / --retry 90 --retry-delay 1 --retry-all-errors /);
  assert.match(line, / http:\/\/127\.0\.0\.1:8080\/up\?deep=1$/);
});
