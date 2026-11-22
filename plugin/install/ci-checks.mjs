// The names of the checks a project's CI workflow reports on a pull request into the default
// branch, read from the workflow's text. The merge rule requires them, and a required check that
// never reports leaves every pull request waiting, so a name is given only when the text settles
// it: a job whose checks are named some other way comes back under `unsure`, and a workflow that
// does not run on every such pull request comes back as a `problem` with nothing to require.
//
// This reads the YAML that workflows are written in, not all of YAML: block mappings by
// indentation, and one-line values.

/** The lines of `text` that hold something, each with its indentation. */
function contentLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => ({ indent: line.search(/\S/), text: line.trim() }))
    .filter((line) => line.indent >= 0 && !line.text.startsWith('#'));
}

/** A one-line value without its trailing comment. */
const bare = (value) => value.replace(/(^|\s)#.*$/, '').trim();

const unquote = (value) => bare(value).replace(/^(["'])(.*)\1$/, '$2');

/**
 * The entries of the block mapping `lines` hold: `{ key, value, lines }`, key null for a line that
 * is not `key: value`. A sequence may sit at its key's own indent.
 */
function entries(lines) {
  const found = [];
  for (const line of lines) {
    const last = found.at(-1);
    const item = /^-(\s|$)/.test(line.text) && last?.key && bare(last.value) === '';
    if (last && (line.indent > lines[0].indent || item)) {
      last.lines.push(line);
      continue;
    }
    const match = line.text.match(/^(?:"([^"]+)"|'([^']+)'|([^\s:"'-][^:]*?))\s*:(?:\s+(.*))?$/);
    found.push({ key: match ? (match[1] ?? match[2] ?? match[3]) : null, value: match ? (match[4] ?? '') : line.text, lines: [] });
  }
  return found;
}

/** The items of a one-line or block sequence, a lone scalar counting as one, or null when `entry` is neither. */
function items({ value, lines }) {
  if (!lines.length) return (bare(value).match(/^\[(.*)\]$/)?.[1].split(',') ?? [value]).map(unquote);
  const sequence = lines.every((line) => line.indent === lines[0].indent && /^- \S/.test(line.text));
  return sequence && bare(value) === '' ? lines.map((line) => unquote(line.text.slice(2))) : null;
}

/** A quoted value that does not end on its own line: what follows it is not what it looks like. */
function spills(value) {
  return (/^"/.test(value) && !/^"(?:[^"\\]|\\.)*"\s*(?:#.*)?$/.test(value)) || (/^'/.test(value) && !/^'(?:[^']|'')*'\s*(?:#.*)?$/.test(value));
}

/** Unquoted text that YAML reads as something other than the string it looks like, or not at all. */
const NOT_THAT_STRING = [
  /^[|>&*!%@`"'[\]{},#]/,
  /^[-?:](\s|$)/,
  /:(\s|$)/,
  /^(~|null|true|false|yes|no|on|off|y|n)$/i,
  /^[-+]?(\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)(e[-+]?\d+)?$/i,
  /^[-+]?0[xob][\da-f_]+$/i,
  /^[-+]?\.(inf|nan)$/i,
  /^[-+]?\d[\d_]*(:[0-5]?\d)+(\.\d*)?$/,
  /^\d{4}-\d\d?-\d\d?([Tt\s].*)?$/,
];

/** The string a one-line `name:` entry holds, or null when the text does not settle it. */
function literal({ value, lines }) {
  if (lines.length) return null;
  const single = value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
  const double = value.match(/^"([^"\\]*)"\s*(?:#.*)?$/);
  const text = single ? single[1].replaceAll("''", "'") : double ? double[1] : bare(value);
  if (text === '' || text !== text.trim() || text.includes('${{')) return null;
  return single || double || !NOT_THAT_STRING.some((pattern) => pattern.test(text)) ? text : null;
}

/**
 * Why the workflow whose `on` entry this is does not run on every pull request into
 * `defaultBranch`, or null when it does. A `branches` filter that names the default branch still
 * runs on all of those; any other filter may not.
 */
function triggerProblem(on, defaultBranch) {
  const unread = 'has triggers written in a form the kit does not read';
  const absent = 'does not run on pull requests';
  const filtered = 'runs on some pull requests only: its pull_request trigger has filters';
  if (!on || bare(on.value).startsWith('{')) return unread;
  const events = items(on);
  if (events) return events.includes('pull_request') ? null : absent;
  if (bare(on.value) !== '') return unread;
  const event = entries(on.lines).find((entry) => entry.key === 'pull_request');
  if (!event) return absent;
  if (!event.lines.length) return ['', '{}', '~', 'null'].includes(bare(event.value)) ? null : filtered;
  const filters = entries(event.lines);
  const branches = filters.length === 1 && filters[0].key === 'branches' && bare(event.value) === '' ? items(filters[0]) : null;
  return branches?.includes(defaultBranch) && branches.every((branch) => !branch.startsWith('!')) ? null : filtered;
}

/**
 * `{ checks, unsure, problem, unrun }` for a CI workflow's text. `checks` are the check names
 * that are certain; `unsure` is `{ job, why }` for each job whose check names are not; `problem`
 * says why none of the workflow's jobs can be required, or is null, and `unrun` is then the checks
 * its jobs report where it does run.
 */
export function ciChecks(text, defaultBranch) {
  const top = entries(contentLines(text));
  const jobs = entries(top.find((entry) => entry.key === 'jobs')?.lines ?? []);
  const checks = [];
  const unsure = [];
  for (const job of jobs) {
    const keys = entries(job.lines);
    const has = (key) => keys.some((entry) => entry.key === key);
    const name = keys.find((entry) => entry.key === 'name');
    const check = name ? literal(name) : job.key;
    if (!job.key || bare(job.value) !== '' || keys.some((entry) => !entry.key || entry.key === '<<' || spills(entry.value))) {
      unsure.push({ job: job.key ?? job.value, why: 'is written in a form the kit does not read' });
    } else if (has('uses')) {
      unsure.push({ job: job.key, why: 'calls another workflow, whose jobs name its checks' });
    } else if (has('strategy')) {
      unsure.push({ job: job.key, why: 'has a matrix, and reports one check for each combination' });
    } else if (check === null) {
      unsure.push({ job: job.key, why: 'has a name the kit cannot read for certain' });
    } else {
      checks.push(check);
    }
  }
  const named = [...new Set(checks)];
  const problem = triggerProblem(top.find((entry) => entry.key === 'on'), defaultBranch) ?? (jobs.length ? null : 'has no jobs the kit can read');
  return problem ? { checks: [], unsure: [], problem, unrun: named } : { checks: named, unsure, problem: null, unrun: [] };
}
