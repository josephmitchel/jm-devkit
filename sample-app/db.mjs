// The sample app's database, reached with psql so the app needs no package. The address is the
// DATABASE_URL in the app's settings; its password goes to psql in the environment, not in an argument.

import { execFile } from 'node:child_process';

/** Run SQL against the app's database. Resolves with what psql printed, unaligned; rejects when it fails. */
export function query(sql, env = process.env) {
  return new Promise((resolve, reject) => {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not in the environment');
    const address = new URL(env.DATABASE_URL);
    const PGPASSWORD = decodeURIComponent(address.password);
    address.password = '';
    execFile('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql, address.href], { env: { ...env, PGPASSWORD } }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
  });
}
