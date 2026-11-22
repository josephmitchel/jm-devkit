// The deploy section's `start`: the app, on the port the project config gives it, at the commit build recorded.

import fs from 'node:fs';
import path from 'node:path';

import { listen } from './app.mjs';
import { query } from './db.mjs';

const read = (file) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, file), 'utf8'));
const { port } = read('../devkit.json').deploy;
const { commit } = read('build.json');

await listen({ query, env: process.env, commit, port });
console.log(`the sample app at ${commit} listens on 127.0.0.1:${port}`);
