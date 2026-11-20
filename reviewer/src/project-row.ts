import { db, schema } from './db/client.js';

/** Where a project is cloned from. */
export function cloneUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

/**
 * Make sure a project has its row in the code reviewer's database, creating it the first time the
 * project is met. A project registers itself through the App and its project config (ADR 0004),
 * and the row holds only what the code reviewer learns about it, so there is nothing for a person
 * to enter. Safe to call before every run.
 */
export async function ensureProjectRow(slug: string): Promise<void> {
  await db
    .insert(schema.repos)
    .values({ slug, cloneUrl: cloneUrl(slug) })
    .onConflictDoNothing({ target: schema.repos.slug });
}
