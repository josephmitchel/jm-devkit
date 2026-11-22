// The apps registered on the machine: one JSON file per app, `<name>.json` in `paths.appsDir`.

import fs from 'node:fs';

/** Every registration, by name. A machine with none, or never registered on, has `[]`. */
export function readRegistry(paths) {
  let files;
  try {
    files = fs.readdirSync(paths.appsDir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return files
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => file.slice(0, -'.json'.length))
    .map((name) => readRegistration(paths, name));
}

function readRegistration(paths, name) {
  const file = paths.registration(name);
  let registration;
  try {
    registration = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not a registration: ${e.message}`);
  }
  if (registration?.name !== name) throw new Error(`${file} is not the registration of an app named ${name}`);
  return registration;
}
