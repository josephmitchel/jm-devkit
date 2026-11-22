// The sample app: a deploy on the apps machine can be rehearsed with it, without any real project.
// It counts its visits in a table, and its health path reads that table. With SAMPLE_HEALTH=fail
// in its settings the health path fails on purpose, to rehearse a deploy that is put back. It
// answers a stop as many servers do, with an exit of 128 plus SIGTERM's number, to rehearse that too.

import http from 'node:http';
import os from 'node:os';

/**
 * Start the app on loopback. `query` runs SQL on its database, `env` holds its settings and
 * `commit` is the commit it was built from. Resolves with the server once it listens.
 */
export function listen({ query, env, commit, port }) {
  const server = http.createServer(async (request, response) => {
    const answer = (status, text) => {
      if (!server.listening) response.setHeader('connection', 'close');
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`${text}\n`);
    };
    try {
      if (request.url === '/healthz') {
        if (env.SAMPLE_HEALTH === 'fail') return answer(503, 'failing on purpose: SAMPLE_HEALTH=fail is in the settings');
        await query('SELECT count(*) FROM visits');
        return answer(200, 'ok');
      }
      if (request.url !== '/') return answer(404, 'not found');
      const visits = await query('INSERT INTO visits DEFAULT VALUES; SELECT count(*) FROM visits');
      return answer(200, `The sample app at commit ${commit}. Visits: ${visits}.`);
    } catch (e) {
      console.error(e.message);
      return answer(503, 'the database did not answer');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** On SIGTERM, have `server` finish the answers it owes and take no more, then exit `proc` with 128 plus the signal's number. */
export function exitOnSigterm(server, proc = process) {
  proc.once('SIGTERM', () => server.close(() => proc.exit(128 + os.constants.signals.SIGTERM)));
}
