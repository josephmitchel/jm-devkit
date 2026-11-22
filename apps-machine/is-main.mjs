import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when `metaUrl` is the script node was started with, directly or through a link. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(metaUrl);
}
