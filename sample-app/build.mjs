// The deploy section's `build`: records the commit the checkout is at, for the app to say which it is.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(import.meta.dirname, 'build.json'), `${JSON.stringify({ commit })}\n`);
console.log(`built ${commit}`);
