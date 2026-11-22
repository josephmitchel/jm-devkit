// Whether an app is up: its health path, on its local port, answers with success.

/** How long an app has, from its service's start, to answer its health path with success. */
export const HEALTH_TIME_LIMIT_SECONDS = 90;
/** How long one ask waits for its answer before the app is asked again. */
export const HEALTH_ANSWER_SECONDS = 30;

/**
 * Ask `healthPath` on the local `port`, again every second, until it answers with a 2xx status or
 * the time limit passes. Returns whether it answered. A redirect is not success.
 */
export function answersHealthy({ run }, { port, healthPath }) {
  const done = run('timeout', [
    String(HEALTH_TIME_LIMIT_SECONDS),
    'curl', '--silent', '--output', '/dev/null', '--fail', '--location', '--max-redirs', '0',
    '--max-time', String(HEALTH_ANSWER_SECONDS),
    '--retry', String(HEALTH_TIME_LIMIT_SECONDS), '--retry-delay', '1', '--retry-all-errors', '--retry-max-time', String(HEALTH_TIME_LIMIT_SECONDS),
    `http://127.0.0.1:${port}${healthPath}`,
  ]);
  return done.code === 0;
}
