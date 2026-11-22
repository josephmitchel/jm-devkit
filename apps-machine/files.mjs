// How the commands write root's files on the machine, and read the ones the owner writes by hand.

import fs from 'node:fs';

/** Make `dir` if it is missing, with what it is in, and close it to everyone but root. */
export function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Put `content` in `file` with `mode`, whatever the umask: written beside it and renamed in, so a reader has the old file or the new. */
export function replaceFile(file, content, mode) {
  fs.writeFileSync(`${file}.new`, content, { mode });
  fs.chmodSync(`${file}.new`, mode);
  fs.renameSync(`${file}.new`, file);
}

const BLANKS = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;

/**
 * The lines of one of the machine's own settings files that hold a value: neither blank nor a `#`
 * comment, without the blanks around them. A missing file has none. Blanks are the ASCII ones, as
 * for the setup script's grep in the C locale.
 */
export function valueLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return text.split('\n').map((line) => line.replace(BLANKS, '')).filter((line) => line !== '' && !line.startsWith('#'));
}
