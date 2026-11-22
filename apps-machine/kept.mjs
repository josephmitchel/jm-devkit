// What a deploy or a restore keeps of an app before it changes anything, in a directory of the
// app's under the backups: its database as `<stamp>.dump`, the stamp being `stampOf` the time. A
// restore keeps the settings file it replaced beside its dump as `.env`, and a second restore in
// one second keeps as `<stamp>-2`.

import fs from 'node:fs';
import path from 'node:path';

import { privateDir } from './files.mjs';
import { timeOfStamp } from './releases.mjs';

const DEPLOYS = /^(?<stamp>[^.-]+)\.dump$/;
const RESTORES = /^(?<stamp>[^.-]+)(?:-(?<nth>[2-9]|[1-9]\d+))?\.(?:dump|env)$/;

/** A name in `dir` no earlier restore has used, so a dump kept there is never written over: least of all the one being restored. */
export function newKeptName(dir, stamp) {
  privateDir(dir);
  let name = stamp;
  for (let n = 2; fs.existsSync(path.join(dir, `${name}.dump`)); n += 1) name = `${stamp}-${n}`;
  return path.join(dir, name);
}

/** What is kept in `dir`, oldest first, as `{ name, time, files }`. A file `named` does not match, or with no time in its name, is passed over. */
function keptIn(dir, named) {
  const kept = new Map();
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const { stamp = '', nth = 1 } = (entry.isFile() && named.exec(entry.name)?.groups) || {};
    const time = timeOfStamp(stamp);
    if (!time) continue;
    const { name } = path.parse(entry.name);
    if (!kept.has(name)) kept.set(name, { name, time, nth: Number(nth), files: [] });
    kept.get(name).files.push(path.join(dir, entry.name));
  }
  return [...kept.values()].sort((a, b) => a.time - b.time || a.nth - b.nth).map(({ name, time, files }) => ({ name, time, files: files.sort() }));
}

/** The dumps the deploys of `app` took, oldest first: `{ name, time, files }`. */
export const keptByDeploys = (paths, app) => keptIn(paths.deployDumps(app), DEPLOYS);

/** What the restores of `app` replaced, oldest first: a dump and the settings file kept with it are one, `{ name, time, files }`. */
export const keptByRestores = (paths, app) => keptIn(paths.restoreDumps(app), RESTORES);
