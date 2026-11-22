// The deploy section's `setup`. The app has no packages to install, so this checks what it needs
// of the machine instead: its settings in the environment, and a database that answers them.

import { query } from './db.mjs';

await query('SELECT 1');
console.log('the database in DATABASE_URL answers');
