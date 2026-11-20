# Code Reviewer

A standalone, repo-agnostic multi-agent code review service with two modes. The **PR loop** audits a pull request's diff (plus blast radius) against the nine ISO/IEC 25010:2023 quality characteristics plus test quality, posts a report with questions to the PR, plans and pushes fixes after the owner replies, verifies them with judge agents, and gates the PR with a `code-reviewer/gate` commit status on the exact verified head SHA. The **nightly sweep** runs the same audit over what landed on the default branch each day and files the concerns as GitHub issues, and judges every ticket whose PR has merged, its own issues included — advisory, never blocking.

Extracted from SpendRight's in-repo audit system. State lives in Postgres (`code_reviewer` database); the process is stateless — kill it anywhere and re-run the same command to resume.

## Requirements

- Node 24, local Postgres 16 (`createdb code_reviewer`, then `npx drizzle-kit migrate`)
- `gh` authenticated with push access to the target repo
- Claude Code logged in (agents run on the Claude subscription via the Agent SDK)

## Usage

```sh
# one-time repo registration; a project with a devkit.json needs no options
node bin/code-reviewer.mjs repo add owner/name

# the fallback for a project with no devkit.json: its setup and tests go in the database row
node bin/code-reviewer.mjs repo add owner/name \
  --setup "npm ci" \
  --tests "unit=npm test" --tests "db=npm run test:db" \
  --harness-notes-file ./notes.md

# run (or resume) the review loop for a PR
node bin/code-reviewer.mjs run owner/name 42

node bin/code-reviewer.mjs status            # all reviews, concern counts and the recent nightly runs
node bin/code-reviewer.mjs projects          # every project the App is installed on, and its state
node bin/code-reviewer.mjs nightly           # the whole nightly run: every handled project's sweep in turn
node bin/code-reviewer.mjs reset owner/name 42   # forget a review (keeps concerns/policies)
```

`projects` needs the App's credentials in the environment (`REVIEWER_APP_CLIENT_ID`,
`REVIEWER_APP_PRIVATE_KEY`). It prints one line per project, in name order: `handled` when the
project's default branch has a valid `devkit.json` and no sweep workflow, `still on Actions` while
the workflow is there, and `skipped` with the reason otherwise. It exits non-zero when GitHub
refuses the App.

## On GitHub Actions

`action.yml` runs one slice of the loop on a GitHub runner, so reviews happen on GitHub rather
than on your machine. State lives in Postgres and nothing blocks: a review that needs an answer
exits, and a later run continues it once you have replied.

A project's workflow is never written by hand. It is the kit-owned
`.github/workflows/nightly-sweep.yml`, which `plugin/generator/` writes from the project's
`devkit.json` (ADR 0004): the `sweep` job, the `landed` job, and the `review-now` job, which is the
per-PR review, run on demand by labelling a PR `review-now`. Adding a project:

1. Run `/devkit:install` in the project. It writes `devkit.json`, runs the generator to write the
   workflow, sets the secrets (`DATABASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`,
   `REVIEWER_APP_CLIENT_ID`, `REVIEWER_APP_PRIVATE_KEY`) and creates the `review-now` label
   (`plugin/skills/kit/install/SKILL.md`).
2. Install the code reviewer's GitHub App on the project. This is the owner's step: a `gh` login
   cannot add a repository to an App's installation.
3. Until the Worker finds projects through the App, give the project its sweep slot in the Worker
   (`worker/README.md`, "Add a repo").
4. Until the code reviewer creates a project's database row on its first run, create it:
   `node bin/code-reviewer.mjs repo add owner/name`, with no options, since `devkit.json` holds the
   setup and tests.

The App needs these repository permissions: Contents, Issues, Pull requests, Commit statuses and
Actions (all read and write), Metadata (read), and **Workflows (read and write)** — without the last
one, GitHub rejects any fix that touches a file under `.github/workflows/`, and the push fails with
nothing else in the system able to explain why.

Everything that accumulates is scoped per repo: the review slot (one active review per project,
so projects never queue behind each other), concerns, and the policies built from your answers.
One database serves every project. A `CODING_STANDARDS.md` at the repo root is read from the head
commit on every round and put in front of the auditors, the synthesis and the fix planner beside
those policies, so written rules and answered questions bind the same way. The kit's own
`house-standards.md`, beside this README, goes with it as a second, separately labelled source:
house standards hold in every project, including one with no `CODING_STANDARDS.md` of its own.

## The project config: `devkit.json`

A project can say how it is set up and tested in a `devkit.json` at its root, instead of in its
database row. The format is defined once, as a JSON Schema at `plugin/devkit.schema.json`, whose
descriptions document each field; the kit's own `devkit.json` is an example. Its `reviewer`
section holds `setup`, `tests` (`[{ "name", "command" }]`), `env`, `databases`, `harnessNotes`,
`redundancy` and `extraContext`. `sweep.hour` and `reviewer.services` are retired: still accepted,
for a project whose sweep still runs on GitHub Actions, and ignored by the code reviewer.

On every run, in the PR loop and in the sweep, the code reviewer reads the file from the checkout
it has just made (so a PR that changes it is set up and tested as it says):

- **With a `devkit.json`**, its `reviewer` section is the whole answer and the database row's setup,
  tests, harness notes, redundancy and extra context are not consulted; a field the file leaves out
  means none (redundancy 1). `harnessNotes` is a path to a doc in the project, which must exist.
  `env` is applied to the project's setup and test commands only; the action's `repo-env` input is
  applied over it and wins on a name both set, because the input is where a secret comes from.
  `databases` names the variables that each get an empty database: see below.
- **Without one**, everything comes from the database row, exactly as before.
- **A malformed one** fails the run, with a message naming each field at fault
  (`reviewer.tests[0].command is required`). It never falls back to the row.

The code reviewer validates the file with the kit's one small interpreter of the schema's keywords
(`plugin/devkit-config.mjs`, which the workflow generator uses too), so the schema stays the one
definition; its tests fail if the schema starts using a keyword the interpreter does not enforce.

### Test databases

A project whose tests need a database lists the variables that hold one in `reviewer.databases`
(`["TEST_DATABASE_URL"]`). Each time a checkout is about to be set up, the code reviewer creates one
empty Postgres database per variable and puts its address in that variable for the project's setup
and test commands, over a value `env` gives the same name. The addresses travel with `env`, so they
never enter the code reviewer's own environment. The databases are dropped when the run ends,
whether it passed, failed or stopped to wait.

The server they are created on is the setting `REVIEWER_TEST_DATABASES_URL`: a Postgres address
(`postgres://role:password@host:5432/postgres`) as a role that may create databases. Give it a role
of its own that cannot open the code reviewer's database, because the project's commands are handed
that role's addresses. With `reviewer.databases` set and the setting absent the run fails, saying
so; GitHub Actions has no such server, so a project adds `databases` when it moves to the machine.

Every database is recorded in the `test_databases` table before it is created, and a run drops only
what is recorded for it. A run that is killed leaves its record, and the same review or sweep drops
what it left when it next runs.

`npm test` needs no database. The suite that creates and drops databases on a real Postgres runs on
its own, given a server:

```sh
REVIEWER_TEST_DATABASES_URL=postgres://role:password@host:5432/postgres npm run test:postgres
```

It keeps the code reviewer's own state in a scratch database it creates on that server and drops
afterwards, and never opens `DATABASE_URL`.

## The nightly sweep (advisory mode)

The PR loop above gates every PR on a full review, fix cycle and verification — tens of minutes
to hours on the critical path of a merge. The sweep keeps the scrutiny and drops the blocking:
once a night it audits what landed on the default branch and files what it finds as GitHub
issues. It never pushes a fix and never sets a commit status.

```
settle owner decisions → read answers → audit base...head → synthesis → judge `needs-judging` tickets → issues / digest
```

- **Scope:** the default branch's diff since the previous sweep (the first sweep audits nothing
  and only sets up the issues). An empty diff still settles, judges, reads answers and republishes.
- **Issues:** every major or moderate concern becomes an issue labelled `concern`, its
  level (`major` / `moderate`) and its quality characteristic, with locations linked at the commit the sweep saw. Minor
  concerns go in one rolling "Code reviewer: minor findings" issue; tick a box there to dismiss one.
- **One rule for every ticket:** a ticket is any issue a PR can address, and a concern the sweep
  raised is a ticket labelled `concern`. The PR says `Addresses #N` (never `Fixes` / `Closes` /
  `Resolves`); on merge the `landed` job sets the ticket's status to `needs-judging` and lifts its blocking
  edges; the next sweep's judge closes it or labels it `needs-work` with a file-by-file brief. A
  concern is never closed-then-reopened: it stays open until a judge says it is solved.
- **Dismissing:** add the `wontfix` label, with a comment if the reason should be kept. The next
  sweep closes the ticket as not planned, drops every other status label,
  lifts its blocking edges (commenting on each dependent), and saves the comment as a repo policy
  so the auditors never raise the point again. No comment, no policy.
- **Labels:** every ticket carries exactly one kind (`spec`, `bug`, `concern`) and, while open,
  exactly one status; colour tells the groups apart, so names carry no prefix. The sweep and the
  `landed` job rename a repo's old labels in place and set the colours (`code-reviewer labels
  <owner/repo>` does it on demand). The scheme is the plugin's `plugin/docs/ticket-labels.md`,
  which every agent reads.
- **Closing by hand** is final for every ticket and never judged — the way to close a ticket with no
  code behind it. For a concern it is neither a fix claim nor a dismissal.
- **Questions:** a concern whose fix needs a product decision gets the question in its issue and
  the `needs-answer` label. Reply in the thread (`1. <answer>` lines, or free text); the answer
  becomes policy. Everything with a technical default is shown as the suggested direction instead.
- **The judge:** reads the ticket as the spec and the merged PR as the delivery, with the concerns
  tonight's audit raised inside that PR's files in front of it. A `needs-work` verdict does not
  re-block the tickets the merge unblocked. The rule agents follow is "Closing work through PRs" in
  the plugin's `plugin/docs/issue-tracker.md`.
- **What happened:** every action leaves a comment on the issue it touched, and the run's log
  ends with the synthesis's account of the night. A sweep that stops fails its Actions run, so
  GitHub's failed-run notification is the alert; the next run resumes where it stopped.
  `code-reviewer status` lists the recent sweeps.

Run it with `node bin/code-reviewer.mjs sweep owner/name`, or on Actions with the
`.github/workflows/nightly-sweep.yml` that `plugin/generator/` writes from the project's
`devkit.json` (`command: sweep`). GitHub's `schedule` trigger is
best-effort (hours late in practice), so the schedule lives in a Cloudflare Worker that dispatches
each repo's workflow on the minute as the reviewer's App: `worker/README.md`. That workflow also carries a
`review-now` job: label a PR `review-now` to get the full PR review on demand. The two modes share
the database, the concerns and the policies, so an answer given on a PR binds the sweep and vice
versa; running both on the same repo at the same moment is not supported.

## The nightly run (on the machine)

`node bin/code-reviewer.mjs nightly` runs one night for every project the machine handles. It asks
the App for the projects (the `projects` command's list), takes the handled ones in name order and
runs each one's sweep, one at a time, each as a `sweep` command in a process of its own. A project
that is not handled is left alone, with a line saying why. A sweep that fails is recorded and the
run goes on to the next project; the command exits non-zero when any project failed, or when the
projects could not be found. It needs the App's credentials and the database address in its
environment, as `projects` and `sweep` do.

Every run is a row in the `runs` table with a run id (`run-<UTC start time>-<random>`, which names
no project): the nightly run itself, and under it one row per project with how it ended and, when it
failed, the stage it stopped in and the type of error. `code-reviewer status` lists the five most
recent nightly runs with each project's result.

Everything a run's command wrote is kept in a file named by the run id, `runs/<run id>.log` under
the code reviewer's state directory: `REVIEWER_STATE_DIR`, or `~/.local/state/code-reviewer` when
that is not set. It never leaves the machine, and a state directory inside the projects' checkouts
(`REVIEWER_WORKSPACE_ROOT`) is refused, since that is where a project's own commands run. The same
output goes to the command's own output as it comes, so the system journal has it too.

### Failure issues

A run that fails tells the owner through an issue, filed where the fault is. `reportRun`
(`src/failure-report.ts`) is called with every finished run and decides the rest.

- **The project's side:** its project config is invalid, or its setup command failed. The issue is
  opened in that project, with the end of the run's output. Which types of error are a project's
  fault is one list in `src/failure-side.ts`.
- **Everything else** is the code reviewer's side, a run its time limit stopped included. The issue
  is opened in the kit's repository: `REVIEWER_KIT_REPO`, which defaults to the kit's own. That
  repository may be public while a project is private, so the issue is built only from the kind of
  run, the stage it stopped in, the type of error, the kit commit, the time and the run id. Each
  is checked against a fixed set of words or a fixed pattern and left out when it does not fit; no
  project is named and no output is quoted. The run id finds the full output on the machine.

There is one open failure issue per place and kind of run, found again by the first line of its
body. A further failure is a comment on it, so two projects that fail the same way on one night
make one issue and one comment in the kit's repository. The code reviewer closes it at the next
success of the same kind. For the runs that are part of a nightly run the kit's repository is told
once, when the night is over: its issue for sweeps is closed when a sweep succeeded that night and
none failed on the code reviewer's side, so one project's success does not close an issue another
project's failure has just commented on. A run that the service stopping interrupted is neither a
failure nor a success.

A failure issue is not a ticket: it carries no labels. The App acts on one repository per process,
so each report is handed to a `failure-issue` command aimed at its repository, and the one aimed at
the kit's repository is given nothing but those six facts. A report that cannot be made is a line
in the run's log and changes nothing about the run.

## The PR loop

```
intake → audit (scout + 10 auditors) → synthesis ──┬─ clean → gate (commit status) → passed
                                                   └─ concerns → report comment → your reply
                                                        → fix plan → fix pushed → judges → re-audit
```

- The report ends with numbered questions; reply on the PR with `1. <answer>` lines (or `proceed` when there are none). Fixes never start without a reply.
- Answers are saved as per-repo policy and never asked again.
- The gate only ever follows a clean audit of the current head — fix commits are always re-audited.
- Until then `code-reviewer/gate` sits at pending with the current stage (`Round 2: making fixes`), and turns red if the review stops.
- Once a fix cycle starts ("Got it" after your answers), one progress comment is edited as it moves, up to the next report. A stopped review posts a comment saying where and why.
- A passed PR whose head later moves to already-reviewed code (merging a PR stacked on it leaves such a merge commit) gets its gate carried to the new head, on the push or on any comment. Only identical code qualifies, and only when the reviews cover everything since the PR's own gated commit.

## Layout

- `src/review-loop.ts` — PR state machine driver; `src/stages/*` — one module per stage (audit and synthesis are shared)
- `src/sweep/*` — the nightly sweep: `loop.ts` driver, `judge.ts` (owner decisions: `wontfix`, hand closes, ticked minors), `tickets.ts` (`needs-judging` tickets, concerns included), `answers.ts`, `publish.ts`, `render.ts` (issue/digest/status text)
- `src/projects.ts` — which projects there are and whether the machine handles each: asked of the App, never listed in the kit (ADR 0004)
- `src/nightly.ts` — the nightly run: its order of work and what it does after a failure, as decisions; `src/runs.ts` — the record of runs on the machine (run ids, output files, how a run ended)
- `src/failure-side.ts` — which side a failed run is on, from the type of its error; `src/failure-issue.ts` — what a failure issue says and when it is opened, commented on and closed; `src/failure-report.ts` — which places a finished run is reported to, and the reporting (`reportRun`)
- `src/agents/run-agent.ts` — Agent SDK wrapper (structured output, session recording, resume)
- `worker/` — the Cloudflare Worker that starts each repo's sweep on time, as the App (`worker/README.md`)
- `prompts/` — auditor definitions (ISO 25010 verbatim) and pipeline role prompts; `prompts/sweep/` — the sweep's framing of scout, auditor, synthesis and the ticket judge
- `src/test-databases.ts` — the databases a project's tests are given: naming, the record of what to drop, creating and dropping
- `src/db/schema.ts` — repos, reviews, sweeps, rounds, concerns, findings, questions, policies, agent_sessions, github_artifacts, test_databases, runs
