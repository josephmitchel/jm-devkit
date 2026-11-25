import { db, schema } from './db/client.js';

/**
 * A project registers itself through the App and its project config (ADR 0004), so its row is made
 * the first time it is met. Safe to call before every run.
 */
export async function ensureProjectRow(slug: string): Promise<void> {
  await db
    .insert(schema.repos)
    .values({ slug })
    .onConflictDoNothing({ target: schema.repos.slug });
}
