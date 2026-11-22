// The names of the checks a project's CI workflow reports on a pull request, read from the
// workflow's text. The merge rule requires them, and a required check that never reports leaves
// every pull request waiting, so a name is given only when the text settles it: a job whose checks
// are named some other way comes back under `unsure`, and a workflow that does not run on every
// pull request comes back as a `problem` with no checks at all.
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

/** The entries of the block mapping `lines` hold: `{ key, value, lines }`, key null for a line that is not `key: value`. */
function entries(lines) {
  const found = [];
  for (const line of lines) {
    if (line.indent > lines[0].indent && found.length) {
      found.at(-1).lines.push(line);
      continue;
    }
    const match = line.text.match(/^(?:"([^"]+)"|'([^']+)'|([^\s:"'-][^:]*?))\s*:(?:\s+(.*))?$/);
    found.push({ key: match ? (match[1] ?? match[2] ?? match[3]) : null, value: match ? (match[4] ?? '') : line.text, lines: [] });
  }
  return found;
}

/** A one-line value without its trailing comment. */
const bare = (value) => value.replace(/(^|\s)#.*$/, '').trim();

/**
 * `{ checks, unsure, problem }` for a CI workflow's text. `checks` are the check names that are
 * certain; `unsure` is `{ job, why }` for each job whose check names are not; `problem` says why
 * none of the workflow's jobs can be required, or is null.
 */
export function ciChecks(text) {
  const top = entries(contentLines(text));
  const jobs = entries(top.find((entry) => entry.key === 'jobs')?.lines ?? []);
  const problem = triggerProblem(top.find((entry) => entry.key === 'on')) ?? (jobs.length ? null : 'has no jobs the kit can read');
  if (problem) return { checks: [], unsure: [], problem };
  const checks = [];
  const unsure = [];
  for (const job of jobs) {
    const keys = entries(job.lines);
    const has = (key) => keys.some((entry) => entry.key === key);
    const name = keys.find((entry) => entry.key === 'name');
    const check = name ? literal(name) : job.key;
    if (!job.key || bare(job.value) !== '' || keys.some((entry) => !entry.key || entry.key === '<<')) {
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
  return { checks: [...new Set(checks)], unsure, problem: null };
}

/** Why the workflow whose `on` entry this is does not run on every pull request, or null when it does. */
function triggerProblem(on) {
  const unread = 'has triggers written in a form the kit does not read';
  const absent = 'does not run on pull requests';
  if (!on) return unread;
  const value = bare(on.value);
  const items = on.lines.filter((line) => line.indent === on.lines[0].indent && line.text.startsWith('- '));
  if (!on.lines.length || items.length) {
    const list = items.length ? items.map((line) => line.text.slice(2)) : value.match(/^\[(.*)\]$/)?.[1].split(',');
    if (value.startsWith('{') || (items.length && value !== '')) return unread;
    return (list ?? [value]).map((event) => bare(event).replace(/^(["'])(.*)\1$/, '$2')).includes('pull_request') ? null : absent;
  }
  if (value !== '') return unread;
  const event = entries(on.lines).find((entry) => entry.key === 'pull_request');
  if (!event) return absent;
  return event.lines.length || !['', '{}', '~', 'null'].includes(bare(event.value))
    ? 'runs on some pull requests only: its pull_request trigger has filters'
    : null;
}

/** The string a one-line `name:` entry holds, or null when it is not a plain literal. */
function literal({ value, lines }) {
  if (lines.length) return null;
  const single = value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
  const double = value.match(/^"([^"\\]*)"\s*(?:#.*)?$/);
  const text = single ? single[1].replaceAll("''", "'") : double ? double[1] : bare(value);
  const quoted = Boolean(single || double);
  if (text.includes('${{') || (!quoted && (text === '' || /^[|>&*!%@`"'[{]/.test(text)))) return null;
  return text;
}
