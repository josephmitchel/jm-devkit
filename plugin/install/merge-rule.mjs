#!/usr/bin/env node
// The merge rule on a project's default branch: reads the project's rulesets and its CI workflow,
// creates the rule where it is missing, and adds the CI checks an existing rule lacks when that
// ruleset is for the default branch alone. It changes nothing else: a rule is never removed,
// loosened or made active here. docs/adr/0006 says what the rule is for and what rests on it;
// MERGE_RULE below is the rule itself.
//
//   node merge-rule.mjs <owner/repo> [--dry-run]
//
// Prints `in place` when the rule is there and whole, with `, as far as this account can see: ...`
// after it when the account is not shown who may bypass the rule. Otherwise one line for each thing:
//   create merge rule: ...      it created the rule (with --dry-run, would)
//   add required checks: ...    it added them to the rule (with --dry-run, would)
//   anything else               for the owner: what is missing or weaker, with the command that
//                               puts it right when there is one, on the line after
// Creating and adding need admin rights on the repository; without them both are for the owner.
// Exit 0 whatever the rule's state, 1 when gh failed, 2 on bad arguments.

import { ciChecks } from './ci-checks.mjs';
import { gh as realGh, isMain, repoSlug } from './gh.mjs';

/** The project's CI workflow, on its default branch. */
export const CI_WORKFLOW = '.github/workflows/ci.yml';

/** GitHub Actions' app id: a required check counts only when Actions reported it. */
const GITHUB_ACTIONS = 15368;

/**
 * The merge rule: a repository ruleset on the default branch, active, that nobody may bypass, with
 * each restriction in `restrictions` and every job of the project's CI workflow a required check.
 * `weaker` is what a ruleset without the restriction is said to do.
 */
export const MERGE_RULE = {
  name: 'merge rule',
  target: 'branch',
  enforcement: 'active',
  bypass_actors: [],
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  restrictions: [
    { rule: { type: 'deletion' }, weaker: 'it lets the default branch be deleted' },
    { rule: { type: 'non_fast_forward' }, weaker: 'it allows force-pushes' },
    {
      rule: {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      weaker: 'it does not require a pull request',
    },
  ],
};

const STATUS_CHECKS = 'required_status_checks';
const requiredCheck = (context) => ({ context, integration_id: GITHUB_ACTIONS });

/** The ruleset GitHub is asked to create for a project whose CI checks are `checks`. */
export function mergeRuleset(checks) {
  const { restrictions, ...ruleset } = MERGE_RULE;
  const rules = restrictions.map(({ rule }) => rule);
  if (checks.length) {
    rules.push({ type: STATUS_CHECKS, parameters: { strict_required_status_checks_policy: false, required_status_checks: checks.map(requiredCheck) } });
  }
  return { ...ruleset, rules };
}

/**
 * How far `ruleset` reaches, as far as its conditions can be read without matching patterns:
 * 'only' the default branch, 'more' than it, or null when it is not known to cover it. Only a
 * ruleset for the default branch alone is ever written to: a check added to a broader one would be
 * required on every branch it covers.
 */
function reach(ruleset, defaultBranch) {
  const own = ['~DEFAULT_BRANCH', `refs/heads/${defaultBranch}`];
  const { include = [], exclude = [] } = ruleset.conditions?.ref_name ?? {};
  const covers = include.some((ref) => ref === '~ALL' || own.includes(ref)) && exclude.every((ref) => ref !== '~ALL' && !own.includes(ref) && !/[*?[{]/.test(ref));
  if (!covers) return null;
  return include.every((ref) => own.includes(ref)) ? 'only' : 'more';
}

const ruleOf = (ruleset, type) => (ruleset.rules ?? []).find((rule) => rule.type === type);
const requiredChecks = (ruleset) => (ruleOf(ruleset, STATUS_CHECKS)?.parameters?.required_status_checks ?? []).map((check) => check.context);

/** A ruleset that holds no part of the merge rule is some other rule, and is not judged as this one. */
function holdsPartOfTheRule(ruleset) {
  return [...MERGE_RULE.restrictions.map(({ rule }) => rule.type), STATUS_CHECKS].some((type) => ruleOf(ruleset, type));
}

/**
 * `ruleset` against the merge rule requiring `checks`: `weaker` says each way it falls short that
 * the kit leaves alone, `missing` is the checks it does not require. More than the rule asks
 * (other rules, other checks, reviews) is never a shortfall.
 */
export function compare(ruleset, checks) {
  const weaker = [];
  if (ruleset.enforcement !== 'active') weaker.push(`it is not active (enforcement: ${ruleset.enforcement})`);
  const actors = ruleset.bypass_actors?.length ?? 0;
  if (actors) weaker.push(`it can be bypassed (${actors} bypass ${actors === 1 ? 'actor' : 'actors'})`);
  else if (!ruleset.bypass_actors && (ruleset.current_user_can_bypass ?? 'never') !== 'never') weaker.push('this account can bypass it');
  for (const restriction of MERGE_RULE.restrictions) {
    if (!ruleOf(ruleset, restriction.rule.type)) weaker.push(restriction.weaker);
  }
  const required = requiredChecks(ruleset);
  return { weaker, missing: checks.filter((check) => !required.includes(check)) };
}

/** `ruleset` as GitHub is asked to hold it once it also requires `checks`: everything it had, and those. */
function withChecks(ruleset, checks) {
  const { name, target, enforcement, conditions, bypass_actors: actors } = ruleset;
  const added = checks.map(requiredCheck);
  const rules = ruleOf(ruleset, STATUS_CHECKS)
    ? ruleset.rules.map((rule) =>
        rule.type === STATUS_CHECKS
          ? { ...rule, parameters: { ...rule.parameters, required_status_checks: [...(rule.parameters?.required_status_checks ?? []), ...added] } }
          : rule,
      )
    : [...(ruleset.rules ?? []), { type: STATUS_CHECKS, parameters: { strict_required_status_checks_policy: false, required_status_checks: added } }];
  return { name, target, enforcement, conditions, ...(actors ? { bypass_actors: actors } : {}), rules };
}

/** The one command that makes `request` of GitHub, for an account that may. */
function command({ method, path, body }) {
  return `printf '%s' '${JSON.stringify(body).replaceAll("'", "'\\''")}' | gh api --method ${method} ${path} --input -`;
}

/**
 * The ruleset judged as the project's merge rule, with its `reach`, `weaker` and `missing`, or
 * undefined when the default branch has none. A whole one comes first; short of that, one in force
 * before one that is not, then one for the default branch alone, then the one that lacks least.
 */
function judgedRuleset(rulesets, defaultBranch, checks) {
  const shortfalls = ({ weaker, missing }) => weaker.length + missing.length;
  const rank = (found) => ((shortfalls(found) ? 4 : 0) + (found.ruleset.enforcement === 'active' ? 0 : 2) + (found.reach === 'only' ? 0 : 1)) * 1000 + shortfalls(found);
  return rulesets
    .map((ruleset) => ({ ruleset, reach: reach(ruleset, defaultBranch), ...compare(ruleset, checks) }))
    .filter((found) => found.reach && holdsPartOfTheRule(found.ruleset))
    .sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * What to say and do about the merge rule of a project in `state`: `project`, `defaultBranch`,
 * `admin`, `rulesets`, `ci`, and `refused` when GitHub has just refused this account the change.
 * Returns `{ change, report, inPlace }`: `change` is the one request that creates the rule or adds
 * checks, with the line that says so, or null; `report` is the lines for the owner; `inPlace` is
 * the line to print when there is neither.
 */
export function decide({ project, defaultBranch, admin, refused = false, rulesets, ci }) {
  const report = [];
  let change = null;
  const judged = judgedRuleset(rulesets, defaultBranch, ci.checks);
  const named = `the ruleset "${judged?.ruleset.name}"`;
  const url = `https://github.com/${project}/rules/${judged?.ruleset.id}`;
  const propose = (line, request, said, note = '') => {
    const them = judged ? 'them' : 'it';
    const whyNot = refused ? `GitHub refused this account when it tried to add ${them}` : `this account has no admin rights on the project to add ${them}`;
    if (admin) change = { line, ...request };
    else report.push(`${said}, and ${whyNot}.${note} Run this as an account that has ${refused ? 'admin rights on the project' : 'them'}:\n${command(request)}`);
  };

  if (!judged) {
    propose(
      `create merge rule: ${ci.checks.length ? `requires the CI checks ${ci.checks.join(', ')}` : 'no required checks'}`,
      { what: 'create the merge rule on', method: 'POST', path: `repos/${project}/rulesets`, body: mergeRuleset(ci.checks) },
      `${project} has no merge rule on its default branch`,
    );
  } else {
    const { ruleset, weaker, missing } = judged;
    const rule = `The merge rule of ${project} (${named})`;
    const lacks = `does not require the CI checks ${missing.join(', ')}`;
    if (judged.reach === 'more') {
      const short = [...weaker, ...(missing.length ? [`it ${lacks}`] : [])];
      if (short.length) {
        report.push(`${rule} is weaker than the kit's: ${short.join('; ')}. It covers more than the default branch, so install and sync do not change it: put these right at ${url}`);
      }
    } else {
      if (weaker.length) {
        const later = missing.length && !admin ? ` It also ${lacks}: once the rest is right, the next install or sync adds them or gives the command that does.` : '';
        report.push(`${rule} is weaker than the kit's: ${weaker.join('; ')}. Install and sync never change these: put them right at ${url}${later}`);
      }
      // A printed command carries the ruleset as read, so it is given only when running it late could undo nothing but a check.
      if (missing.length && (admin || !weaker.length)) {
        propose(
          `add required checks: ${missing.join(', ')}`,
          { what: 'add required checks to the merge rule of', method: 'PUT', path: `repos/${project}/rulesets/${ruleset.id}`, body: withChecks(ruleset, missing) },
          `${rule} ${lacks}`,
          ' The command sends the whole ruleset as it was read just now, with the checks added, so run it before the ruleset is changed again.',
        );
      }
    }
  }

  const workflow = `${CI_WORKFLOW} on ${defaultBranch}`;
  if (ci.problem) {
    const required = judged ? requiredChecks(judged.ruleset) : [];
    const waiting = ci.unrun ? required.filter((check) => ci.unrun.includes(check)) : required;
    report.push(
      waiting.length
        ? `${project}'s CI workflow (${workflow}) ${ci.problem}, and the merge rule (${named}) still requires the checks ${waiting.join(', ')}. ` +
            `A pull request that nothing reports them on waits for them and cannot merge: put the workflow right, or take them out of the ruleset at ${url}`
        : `${project}'s CI workflow (${workflow}) ${ci.problem}, so the merge rule cannot require its jobs. They become required at the next install or sync after that is put right.`,
    );
  }
  for (const { job, why } of ci.unsure) {
    report.push(`The merge rule does not cover the CI job ${job} of ${project} (${workflow}): it ${why}. Requiring its checks in the rule is yours.`);
  }
  const inPlace = judged?.ruleset.bypass_actors
    ? 'in place'
    : `in place, as far as this account can see: who may bypass a ruleset is shown only to an account with admin rights on ${project}. ` +
      `For such an account this prints [] when nobody may: gh api repos/${project}/rulesets/${judged?.ruleset.id} --jq .bypass_actors`;
  return { change, report, inPlace };
}

/** The project's state as `gh` shows it to the account running it. Throws when GitHub cannot be read. */
export function readState(project, gh = realGh) {
  const read = (what, args) => {
    const run = gh(['api', ...args]);
    if (run.code !== 0) throw new Error(`could not read ${what} of ${project}: ${run.stderr.trim()}`);
    return run.stdout;
  };
  const json = (what, path) => {
    try {
      return JSON.parse(read(what, [path]));
    } catch (e) {
      throw e instanceof SyntaxError ? new Error(`could not read ${what} of ${project}: GitHub's answer is not JSON`) : e;
    }
  };
  const repo = json('the repository', `repos/${project}`);
  const rulesets = json('the rulesets', `repos/${project}/rulesets?per_page=100`)
    .filter((ruleset) => ruleset.target === 'branch' && ruleset.source_type === 'Repository')
    .map((ruleset) => json(`the ruleset "${ruleset.name}"`, `repos/${project}/rulesets/${ruleset.id}`));
  const file = gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${project}/contents/${CI_WORKFLOW}`]);
  const absent = file.code !== 0 && /HTTP 404/.test(file.stderr);
  if (file.code !== 0 && !absent) throw new Error(`could not read the CI workflow of ${project}: ${file.stderr.trim()}`);
  return {
    project,
    defaultBranch: repo.default_branch,
    admin: repo.permissions?.admin === true,
    rulesets,
    ci: absent ? { checks: [], unsure: [], problem: 'is missing', unrun: null } : ciChecks(file.stdout, repo.default_branch),
  };
}

/** The CLI. Returns the exit code. */
export function main(argv, { gh = realGh, out = process.stdout, err = process.stderr } = {}) {
  const dryRun = argv.includes('--dry-run');
  const rest = argv.filter((a) => a !== '--dry-run');
  const project = rest.length === 1 ? repoSlug(rest[0]) : null;
  if (!project) {
    err.write('usage: node merge-rule.mjs <owner/repo> [--dry-run]\n');
    return 2;
  }
  let state;
  try {
    state = readState(project, gh);
  } catch (e) {
    err.write(`${e.message}\n`);
    return 1;
  }
  const { change, report, inPlace } = decide(state);
  let lines = report.length ? report : [inPlace];
  let code = 0;
  if (change) {
    const run = dryRun ? { code: 0 } : gh(['api', '--method', change.method, change.path, '--input', '-'], { input: JSON.stringify(change.body) });
    if (run.code === 0) lines = [change.line, ...report];
    else {
      err.write(`could not ${change.what} ${project}: ${run.stderr.trim()}\n`);
      lines = decide({ ...state, admin: false, refused: true }).report;
      code = 1;
    }
  }
  out.write(`${lines.join('\n')}\n`);
  return code;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
