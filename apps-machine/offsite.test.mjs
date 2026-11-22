import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

import { requestAlive } from './offsite.mjs';
import { run as realRun } from './run.mjs';
import { machine } from './test-helpers.mjs';

// The commands' `run` waits for its program, so the service curl talks to answers from another thread.
const SERVICE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const requests = [];
  const server = require('node:http').createServer((request, response) => {
    requests.push(request.method + ' ' + request.url);
    response.statusCode = workerData.status;
    response.end('the service answers, naming ' + request.url);
  });
  server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
  parentPort.on('message', () => parentPort.postMessage(requests));
`;

/** A stand-in alerting service answering every request with `status`. `requests()` ends it and gives what it was asked. */
async function aliveService(status = 200) {
  const worker = new Worker(SERVICE, { eval: true, workerData: { status } });
  const [port] = await once(worker, 'message');
  const requests = async () => {
    worker.postMessage('report');
    const [asked] = await once(worker, 'message');
    await worker.terminate();
    return asked;
  };
  return { address: `http://127.0.0.1:${port}/ping/made-up-id`, port, requests };
}

/** The real `run`, keeping what each program was given as arguments and what it printed. */
function watchedRun() {
  const shown = [];
  const run = (program, args, options) => {
    const done = realRun(program, args, options);
    shown.push(JSON.stringify({ program, args, env: options.env, ...done }));
    return done;
  };
  return { run, shown };
}

test('the machine\'s own curl requests the address it reads on its input, once, and shows it to nobody', async () => {
  const service = await aliveService();
  const { run, shown } = watchedRun();
  const address = `${service.address}?night=2026-11-21&apps={sample,other}[1-2]`;
  requestAlive({ run, paths: machine() }, address);
  assert.deepEqual(await service.requests(), ['GET /ping/made-up-id?night=2026-11-21&apps={sample,other}[1-2]']);
  assert.equal(shown.length, 1);
  assert.doesNotMatch(shown[0], /made-up-id|127\.0\.0\.1/);
});

test('a service that answers with an error fails the request, and curl prints neither the address nor the answer', async () => {
  const service = await aliveService(404);
  const { run, shown } = watchedRun();
  assert.throws(() => requestAlive({ run, paths: machine() }, service.address), { message: 'the alive request failed: it answered with an error (curl exit 22)' });
  assert.deepEqual(await service.requests(), ['GET /ping/made-up-id']);
  assert.doesNotMatch(shown[0], /made-up-id|127\.0\.0\.1|the service answers/);
});

test('a service that cannot be reached fails the request, and curl prints nothing of the address', async () => {
  const service = await aliveService();
  await service.requests();
  const { run, shown } = watchedRun();
  assert.throws(() => requestAlive({ run, paths: machine() }, service.address), { message: 'the alive request failed: it could not be reached (curl exit 7)' });
  assert.doesNotMatch(shown[0], /made-up-id|127\.0\.0\.1/);
});
