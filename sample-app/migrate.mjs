// The deploy section's `migrate`: applies each file in migrations/ the database has not had.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { query as psql } from './db.mjs';

const MIGRATIONS = path.join(import.meta.dirname, 'migrations');

/** Apply the migrations not yet recorded in the database, in name order, each with its record. Returns their names. */
export async function migrate(query) {
  await query('CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const had = (await query('SELECT name FROM migrations')).split('\n');
  const applied = [];
  for (const name of fs.readdirSync(MIGRATIONS).filter((file) => /^[\w-]+\.sql$/.test(file)).sort()) {
    if (had.includes(name)) continue;
    await query(`BEGIN;\n${fs.readFileSync(path.join(MIGRATIONS, name), 'utf8')}\nINSERT INTO migrations (name) VALUES ('${name}');\nCOMMIT;`);
    applied.push(name);
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const applied = await migrate(psql);
  console.log(applied.length > 0 ? `applied ${applied.join(', ')}` : 'no migration to apply');
}
