import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './db/client.js';
import { MIGRATE_LOCK, takeLock } from './locks.js';

/**
 * Apply pending migrations under a Postgres advisory lock.
 *
 * One database serves every project, while the workflow's concurrency group is per reviewed repo —
 * so two repos opening a PR in the same minute both reached the migrate step at once. drizzle-kit
 * takes no lock: both read the journal, both see the same pending file, both apply it, and the loser
 * dies on `column already exists`. With `set -euo pipefail` that fails the step, so that PR gets no
 * review at all and the only explanation on the PR is a migration error.
 *
 * The lock is held on a connection of its own, so it serialises whole processes rather than
 * statements, and it is released even when a migration throws.
 */
export async function runMigrations(): Promise<void> {
  const lock = await takeLock(MIGRATE_LOCK);
  try {
    const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
    await migrate(db, { migrationsFolder: folder });
    console.log('migrations up to date');
  } finally {
    await lock.release();
  }
}
