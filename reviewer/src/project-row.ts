import { db, schema } from './db/client.js';

export function cloneUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

/**
 * A project registers itself through the App and its project config (ADR 0004), so its row is made
 * the first time it is met. Safe to call before every run.
 */
export async function ensureProjectRow(slug: string): Promise<void> {
  await db
    .insert(schema.repos)
    .values({ slug, cloneUrl: cloneUrl(slug) })
    .onConflictDoNothing({ target: schema.repos.slug });
}
