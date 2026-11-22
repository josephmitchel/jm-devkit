import { test } from 'node:test';
import assert from 'node:assert/strict';

import path from 'node:path';

import { HEALTH_ANSWER_SECONDS, HEALTH_TIME_LIMIT_SECONDS, answersHealthy, mustAnswerHealthy } from './health.mjs';
import { run as realRun } from './run.mjs';
import { commandLines, fakeRun, machine, sink } from './test-helpers.mjs';

test('a command that needs the app to answer says what it asks and for how long, and fails when no answer comes', () => {
  const asked = 'Asking /healthz on port 3000, for 90 seconds at most\n';
  const healthy = { run: fakeRun().run, paths: machine(), out: sink() };
  mustAnswerHealthy(healthy, { port: 3000, healthPath: '/healthz' });
  assert.equal(healthy.out.text, asked);
  const silent = { run: fakeRun(() => ({ code: 124 })).run, paths: machine(), out: sink() };
  assert.throws(() => mustAnswerHealthy(silent, { port: 3000, healthPath: '/healthz' }),
    /^Error: \/healthz on port 3000 did not answer with success within 90 seconds$/);
  assert.equal(silent.out.text, asked);
});

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
  assert.match(line, /^timeout --foreground 90 curl /);
  assert.match(line, / --max-time 30 /);
  assert.match(line, / --fail /);
  assert.match(line, / --location --max-redirs 0 /);
  assert.match(line, / --retry 90 --retry-delay 1 --retry-all-errors /);
  assert.match(line, / http:\/\/127\.0\.0\.1:8080\/up\?deep=1$/);
});

test('an interrupt from the terminal ends the asking at once: timeout stays in the command\'s process group', () => {
  const from = (file) => JSON.stringify(path.join(import.meta.dirname, file));
  const asking = `import { answersHealthy } from ${from('health.mjs')};
    import { outliveSignals, run } from ${from('run.mjs')};
    outliveSignals();
    run('/bin/sh', ['-c', '(sleep 0.5; kill -INT 0) > /dev/null 2>&1 &']);
    const began = Date.now();
    try {
      console.log(answersHealthy({ run }, { port: 9, healthPath: '/' }));
    } catch (e) {
      console.log(e.message, Date.now() - began < 10000 ? 'at once' : 'late');
    }`;
  assert.equal(realRun('setsid', ['--wait', process.execPath, '--input-type=module', '-e', asking]).stdout, 'interrupted by SIGINT at once\n');
});
