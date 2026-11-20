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

node bin/code-reviewer.mjs status            # all reviews, concern counts, the recent nightly runs and the poller's last passes
node bin/code-reviewer.mjs projects          # every project the App is installed on, and its state
node bin/code-reviewer.mjs nightly           # the whole nightly run: every handled project's sweep in turn
node bin/code-reviewer.mjs checks owner/name # one project's nightly checks, now
node bin/code-reviewer.mjs poll              # one pass of the poller: landed for each newly merged pull request, carry-gate for a passed one's new head
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

A project on GitHub Actions has the kit-owned `.github/workflows/nightly-sweep.yml`: the `sweep`
job, the `landed` job, and the `review-now` job, which is the per-PR review, run on demand by
labelling a PR `review-now`. The kit has retired that file. The generator (`plugin/generator/`) no
longer writes it, so no project is added to Actions any more, and a project that still has it
keeps working there until it moves: `/devkit:sync` opens a pull request that removes the workflow,
and merging that pull request hands the project to the machine (`projects` then shows it
`handled`). The pull request lists what is left for the owner: the project's four repository
secrets to remove, and its line in the Worker's list (`worker/README.md`).

Adding a project, which puts it on the machine from the start:

1. Run `/devkit:install` in the project. It writes `devkit.json`, creates the `review-now` label,
   and checks two things it cannot do itself: that the App is installed, and that the project has
   discussions turned on with the code reviewer's category
   (`plugin/skills/kit/install/SKILL.md`). It sets no repository secret and writes no workflow.
2. Install the code reviewer's GitHub App on the project. This is the owner's step: a `gh` login
   cannot add a repository to an App's installation.
3. Create what install said is missing for the summaries (see "The night's summary").

The nightly run creates the project's database row the first night it meets the project. A project
still on GitHub Actions got its row from `node bin/code-reviewer.mjs repo add owner/name`.

The App needs these repository permissions: Contents, Issues, Pull requests, Commit statuses,
Actions and **Discussions** (all read and write), Metadata (read), and **Workflows (read and
write)** — without the last one, GitHub rejects any fix that touches a file under
`.github/workflows/`, and the push fails with nothing else in the system able to explain why.
Discussions is what lets the code reviewer post each night's summary (see "The night's summary").
Granting a permission added to the App is the owner's step, as are the two things each project
needs for its summaries: Discussions turned on, and a discussion category named `Code reviewer`.

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
`redundancy` and `extraContext`. Its `nightly` section holds `checks` (`[{ "name", "command" }]`),
the project's nightly checks: see "Nightly checks" below. `sweep.hour` and `reviewer.services` are
retired: still accepted, for a project whose sweep still runs on GitHub Actions, and ignored by the
code reviewer.

On every run, in the PR loop and in the sweep, the code reviewer reads the file from the checkout
it has just made (so a PR that changes it is set up and tested as it says):

- **With a `devkit.json`**, its `reviewer` section is the whole answer and the database row's setup,
  tests, harness notes, redundancy and extra context are not consulted; a field the file leaves out
  means none (redundancy 1). `harnessNotes` is a path to a doc in the project, which must exist.
  `env` is applied to the project's setup, test and nightly check commands only; the action's `repo-env` input is
  applied over it and wins on a name both set, because the input is where a secret comes from.
  `databases` names the variables that each get an empty database: see below.
- **Without one**, everything comes from the database row, exactly as before.
- **A malformed one** fails the run, with a message naming each field at fault
  (`reviewer.tests[0].command is required`). It never falls back to the row.

The code reviewer validates the file with the kit's one small interpreter of the schema's keywords
(`plugin/devkit-config.mjs`, which the generator uses too), so the schema stays the one
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
  ends with the synthesis's account of the night. On the machine that account is also posted as a
  discussion in the project ("The night's summary"). A sweep that stops fails its Actions run, so
  GitHub's failed-run notification is the alert; the next run resumes where it stopped.
  `code-reviewer status` lists the recent sweeps.

Run it with `node bin/code-reviewer.mjs sweep owner/name`, or on Actions with the retired
`.github/workflows/nightly-sweep.yml` of a project that has not moved (`command: sweep`). GitHub's `schedule` trigger is
best-effort (hours late in practice), so the schedule lives in a Cloudflare Worker that dispatches
each repo's workflow on the minute as the reviewer's App: `worker/README.md`. That workflow also carries a
`review-now` job: label a PR `review-now` to get the full PR review on demand. The two modes share
the database, the concerns and the policies, so an answer given on a PR binds the sweep and vice
versa; running both on the same repo at the same moment is not supported.

## The nightly run (on the machine)

`node bin/code-reviewer.mjs nightly` runs one night for every project the machine handles. It asks
the App for the projects (the `projects` command's list), takes the handled ones in name order and
runs each one's sweep, posts its summary and then runs its nightly checks if it names any, one at a
time, each as a `sweep`, `summary` or `checks` command in a process of its own. A project that is
not handled is left alone, with a line saying why. A step that fails is recorded and the run goes
on to the next; the command exits non-zero when any step failed, or when the projects could not be
found. It needs the App's credentials and the database address in its environment, as `projects`
and `sweep` do. A handled project needs nothing registered: the nightly run makes its row in the
code reviewer's database the first night it meets it (ADR 0004).

A nightly run has the machine for the night. If a review is running when it starts, it waits for
that review to finish and then goes; while it is going no review starts, and a second nightly run
does not start beside it (see "The queue of reviews").

A sweep has five and a half hours, as a run on GitHub Actions had. One that runs longer is stopped,
with the agents and commands it started, and the run goes on to the next step. Told to stop
(SIGTERM, as when its service is stopped), the nightly run stops the step it is on and takes no
further step. Either way the run is recorded as `interrupted`, with what stopped it, and so is a
run found still `running` when the next nightly run starts, whose process died before it could
record anything. An interrupted sweep resumes from its own state the next time it is run.

Every run is a row in the `runs` table with a run id (`run-<UTC start time>-<random>`, which names
no project): the nightly run itself, and under it one row for each project's sweep and one for its
summary, with how it ended and, when it failed, the stage it stopped in and the type of error.
`code-reviewer status` lists the five most recent nightly runs with each project's result.

Everything a run's command wrote is kept in a file named by the run id, `runs/<run id>.log` under
the code reviewer's state directory: `REVIEWER_STATE_DIR`, or `~/.local/state/code-reviewer` when
that is not set. It never leaves the machine, and a state directory inside the projects' checkouts
(`REVIEWER_WORKSPACE_ROOT`) is refused, since that is where a project's own commands run. The same
output goes to the command's own output as it comes, so the system journal has it too.

### The night's summary

After a project's sweep, `node bin/code-reviewer.mjs summary owner/name` posts the night as a
discussion in that project: the synthesis's account that ends the sweep's log, then what the sweep
did (what landed, what it filed and closed, the tickets it judged, the owner's decisions it
settled), each issue by its number. Nothing is run again: the post is made from the sweep's row and
its round's. The title is `Nightly summary, <date>`, the date the sweep finished on the machine's
own calendar.

- **A quiet night posts nothing.** A sweep with no diff, nothing judged and no decision settled is
  skipped, as is a sweep that did not finish. The rule is `summaryPlan` in `src/night-summary.ts`.
- **One discussion per sweep.** The discussion's address is recorded on the sweep's row
  (`sweeps.discussion_url`, shown by `status`), so a nightly run started again the same night, or
  the command run by hand, posts nothing more. Only a project's latest sweep is ever posted: a
  night that could not be posted is not caught up once a later sweep has run, so after creating a
  missing category run `summary` by hand to post that night.
- **The category** is named by the setting `REVIEWER_DISCUSSION_CATEGORY`, `Code reviewer` when it
  is not set, and matched whatever its capitals. The name, the matching and the words the owner is
  told are in `plugin/discussion-category.mjs`, which install's check
  (`plugin/install/discussions.mjs`) reads too, so install and the code reviewer agree on whether
  a project is ready. GitHub's API creates discussions but not
  categories (checked 2026-11-20: no such mutation in the GraphQL schema, and no discussions
  endpoint in REST), so the owner creates it: in the project, turn on Discussions (Settings,
  General, Features), then Discussions, the pencil beside Categories, New category, with the
  format Open-ended discussion.
- **A project with discussions off, or without the category,** fails the summary on the project's
  side: a failure issue in the project says what to create. It is checked on every night, a quiet
  one included, so the issue stays open until the category exists and closes at the first summary
  run after that. The summary is a run of its own kind (`summary`), so the sweep's recorded result
  is never changed by a summary that could not be posted.

### Nightly checks

A project can name checks that are too slow for every pull request in `nightly.checks`, a list of
`{ "name", "command" }`. The nightly run runs them after that project's sweep and its summary, as
a step and a run of their own (kind `checks`), whether or not the sweep succeeded. A project that
names none has no such step: no checkout is made and no run is recorded.
`node bin/code-reviewer.mjs checks owner/name` runs one project's checks by hand; it is recorded
and reported the same way, and exits 1 when a check failed.

- **Where they run.** In a checkout of their own, `checks/<owner>__<name>` under the checkouts'
  root, at the default branch's head as it is when the checks start. That is the head the sweep
  audited or a newer one, and it is made and set up the way the sweep's checkout is: the same
  reset, then `reviewer.setup`. The sweep's own checkout is not reused because the checks can be
  run by hand while a review or a sweep of the project is working in it.
- **What they are given.** `reviewer.env`, and fresh databases for `reviewer.databases`: the
  sweep's are dropped when the sweep ends, so the checks get their own, dropped when the checks
  end. None of the code reviewer's credentials, as for every command of the project's. No agent
  runs.
- **A check that fails** (a non-zero exit, or one stopped for running longer than thirty minutes,
  or than the setting `REVIEWER_CHECK_TIMEOUT_MS` when it is set) does not stop the checks after
  it. The run fails if any check did, as a failure on the project's side, and ends with an account
  of each failed check and the end of what it wrote, which is what the project's failure issue
  quotes. Being a kind of run of their own, the checks never change the sweep's result, and their
  failure issue is beside the sweep's: each is closed only by a success of its own kind. The run
  as a whole has no time limit: the setup command and each check have their own.
- **Output.** Everything a check writes goes to the run's output file and the journal, as a
  sweep's output does.

### Failure issues

A run that fails tells the owner through an issue, filed where the fault is. `reportRun`
(`src/failure-report.ts`) is called with every finished run and decides the rest.

- **The project's side:** its project config is invalid, its setup command failed, it has no
  discussion category for the night's summary, or one of its nightly checks failed. The issue is
  opened in that project, with the end of the run's output. Which types of error are a project's
  fault is one list in `src/failure-side.ts`. The addresses of the run's test databases, and the
  password they carry, are taken out of that output before it leaves the machine (`outputTail`).
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

## The poller (on the machine)

Nothing on GitHub can reach the machine, so the code reviewer finds events by asking.
`node bin/code-reviewer.mjs poll` is one pass, and a timer runs one every three minutes. For each
project the machine handles, a pass finds the pull requests that have merged since the project's
first pass and runs `landed` for each one once, so its tickets are labelled `needs-judging` and
unblocked within one interval. It also finds the reviews to start and to continue, and queues
them: a pass does not run a review (see "The queue of reviews"). A project that is not handled is
left alone.

**The pass is a decision.** `passDecision` in `src/poller.ts` is a pure function from what a pass
saw on GitHub (each project's state and its pull requests) and what the database has on record, to
the commands to run. An event is one entry in the `EVENTS` table there: how it is found on a pull
request, and the command that handles it. Each has a key, `<name>:<subject>`, such as `merged:12`.

**Each event is handled once.** The record is the `poller_events` table, whose primary key is the
project and the event's key, so a second record of the same event cannot be made.

- What a pass found goes on record together with where the pass got to, before anything is run.
  From then on the record alone says what is still to be handled.
- A pass takes an event by raising its count of attempts from the number it read. Of two passes
  that decided the same command, one finds nothing to take.
- A merge is recorded as handled only once its `landed` has succeeded. A `landed` that failed,
  or that was stopped with the service, stays on record and is tried again: on the next pass, then
  after 2, 4, 8 minutes and so on, and every six hours from the tenth attempt. It is never given
  up on, and `status` shows it as not handled. A review's event has its own rule for when it is
  handled ("The queue of reviews").
- Passes do not overlap. The timer does not start a pass while one is going, and a pass holds a
  Postgres advisory lock, so one started by hand beside it does nothing.
- A pass killed outright leaves its `landed` run recorded as `running`. The next pass records it
  as `interrupted` and the event is tried again. So a `landed` can run twice for one merge, and
  so can one that failed partway. A second run changes nothing the first already did: a ticket
  that carries that pull request's landed comment (`landingRecorded` in `src/landed.ts`) is left as
  it is, with no second comment, and a ticket the first run did not finish is finished.

**A project's first pass starts from that moment.** `poller_projects` holds, per project, GitHub's
time at its first pass and how far the last pass's reading got. A pull request that merged before
the first pass is never acted on, however often a later pass sees it.

**A passed pull request's new head** is the event `head-moved:<pr>@<commit>`. A pass finds it on
an open pull request whose review has passed, when its head is a commit that review's gate is not
on (`github_artifacts` holds every commit the gate was posted on or carried to). It runs
`carry-gate` for the pull request once. That command, not the poller, decides whether the new head
holds only reviewed code, and carries the gate if it does.

- Either answer handles the event, so the same head is not looked at again. A head that moves
  again is a new event with a new key. To have one head looked at a second time, run `carry-gate`
  by hand.
- A `carry-gate` that failed is tried again like a `landed` that failed. It asks GitHub for the
  head at that moment, so a retry after the head has moved on decides for the newer head.
- `carry-gate` runs no agents. It runs inside the pass like `landed`, has no time limit of its own
  and waits for no sweep or review.
- GitHub's listing gives no time for a head, only for the pull request's last change. A pull
  request not changed since the project's first pass is left alone. One whose head moved before
  the first pass and which is commented on after it has `carry-gate` run once for that head.

**A pass asks conditionally** (`src/poller-github.ts`). Every question a pass repeats is sent
with the ETag of its last answer, and an answer of "unchanged" (304) is not counted against the
App's rate limit. The answers and ETags are kept in `github_answers`. No credential is kept: a
pass mints its installation tokens and holds them in memory until it ends.

- The questions are: the App's installations, each installation's repositories, the head of each
  project's default branch, and each handled project's pull requests (one listing, most recently
  changed first). A project's `devkit.json` and sweep workflow are read again only when the head
  of its default branch is a different commit.
- A pass makes `1 + 2 x installations + projects + handled projects` requests when nothing has
  happened, the installations' tokens among them.
- **Whether those are free depends on what GitHub ties an ETag to, which has not been observed
  with the real App.** If an ETag is good for the installation, a pass with its new token is told
  "unchanged" throughout and an idle pass costs nothing but its tokens. If it is good only for
  the token that got it, the lists are answered in full on every pass, and that is accepted: an
  answer in full is read like any other, and for a handful of projects it comes to a few hundred
  of the installation's 5,000 requests an hour. The head of a default branch is told "unchanged"
  either way, since its ETag is the commit.
- Each pass ends with a line saying how many times GitHub was asked and how many of the answers
  were "unchanged", so the journal shows which of the two holds.

Each `landed` and each `carry-gate` is a run of its own kind in the `runs` table, with its output
file, and is reported through `reportRun` like any other: a failure opens or comments on the
failure issue for runs of its kind, and the next success of that kind closes it. A project whose pull requests could not be read is left
alone for that pass and the others are still handled; the command then exits non-zero.

## The queue of reviews (on the machine)

The per-PR review runs on the machine without Actions. A pass of the poller finds the reviews to
run and puts them on record; `node bin/code-reviewer.mjs queue` takes one turn of the queue, in
which at most one of them does any work. A review can run for five and a half hours, and a pass
must stay short and keep running so that `landed` is never held up, so a pass only decides and
queues.

**The events** are two more entries in the `EVENTS` table, both for the command
`run <owner/repo> <pr#> --once`:

- `labelled:<pr>`: an open pull request, not a draft, labelled `review-now`, with no review that
  has started. A draft is not reviewed; when it leaves draft with the label on, it is. A label has
  no time of its own, so a pull request labelled before the project's first pass is acted on only
  once something else about it changes.
- `replied:<pr>/<comment>`: a comment on the pull request of a review that waits on the owner,
  written since it began to wait. A review waits on the owner when it is waiting for answers, and
  when it has stopped: its notice on the pull request says a comment retries it. Whose comment
  counts is the rule the review itself reads answers by (`countsAsReply` in
  `src/reply-authority.ts`): the owner, a member or a collaborator, and never the code reviewer's
  own comments. Several comments written before a pass are one event, the newest, so the review is
  continued once for them. A pass reads a pull request's comments only when its review is waiting
  and it has changed since the last pass.

**One agent job at a time.** A review and a sweep run agents on the one subscription, so they
never run together on the machine. Two Postgres advisory locks say who may run (`src/machine.ts`):

- the machine's lock, held by whoever is running an agent job: the queue for the length of a
  review, the nightly run for the length of the night;
- the nightly run's lock, held by a nightly run from its start to its end.

`machineFor` in `src/queue.ts` is the rule. A review starts only when neither is held. A nightly
run that starts while a review is running waits for that review (at most its time limit) and then
goes: the night is put back, never skipped. Once a nightly run is going no review starts until it
is over, even between its sweeps, so a queue of reviews cannot put the night's sweeps back. A
second nightly run beside one that is going does not start. `landed`, `carry-gate`, the summary
and the nightly checks run no agents and take neither lock. Nor do `sweep` and `run` themselves:
a project still on Actions runs them against the same database. The locks are taken by the
`nightly` and `queue` commands, so a `sweep` or `run` started by hand is outside the rule.

**The queue is the record.** A queued review is its event in `poller_events`, not yet handled.
`queueDecision` in `src/queue.ts` says which starts next: the one found first, across projects.
Events that ask for the same command are one job, so a label and two replies on one pull request
are one run. A review found while an agent job is running stays queued and is looked at again on
the next turn.

**Handled does not mean exit 0.** `run --once` exits 0 when the review passed, when it now waits
for answers, and when it was turned away because another review holds its project's review slot.
`afterReviewRun` decides what the run leaves of the event, from how the run ended and the state
the review is in afterwards:

- passed, or waiting for answers: handled. The owner's reply is an event of its own.
- stopped in one of its stages, or at its time limit: handled. The review has said so on the pull
  request, and it is not started again until the owner comments there.
- turned away from its project's slot: not handled, and not a failure. It starts when no other
  review of the project holds the slot, which is how a finished review starts the next one queued
  behind it. It is also tried after the same doubling wait as a failure, because a holder whose
  pull request has closed never finishes and only a review claiming the slot retires it.
- failed before the review did anything, or interrupted by the service stopping or by a restart:
  tried again, after a minute, then two, four and so on up to six hours.

This replaces the workflow dispatch hand-off (`REVIEWER_DISPATCH_WORKFLOW`), which a project still
on Actions keeps.

**Recorded and reported.** Each review the queue starts is a run of kind `review` in the `runs`
table, started through `runCommand`: it has the five and a half hours an agent job has, and one
that is stopped by that limit or with the service is recorded as stopped by `abandon`, on the pull
request too, which frees its project's slot. It goes through `reportRun`, except a review that was
turned away, which did no work. A turn killed outright leaves its run recorded as `running`; the
next turn that has the machine records it as `interrupted`, runs `abandon` for it and tries the
event again.

`code-reviewer status` ends with the queue: the agent job that is running, the review that starts
next, and each one that waits with the reason. `code-reviewer reset` forgets the events that asked
for the review it deletes, so labelling the pull request again starts a new one.

## The service and its timers (on the machine)

`vm/dev-vm-setup.sh` installs the code reviewer on the machine as a service of the unprivileged
`reviewer` user. Run it from a checkout of the kit, as an admin: `sudo bash vm/dev-vm-setup.sh`. It
is safe to run again.

- **Units:** `code-reviewer-nightly.service` and `.timer` for the nightly run,
  `code-reviewer-poller.service` and `.timer` for the poller, and `code-reviewer-queue.service`
  for the queue of reviews, from `vm/systemd/`. The setup installs every `code-reviewer-*` service
  and timer in that directory.
- **When:** 02:00 local time, in the machine's time zone. To change it, run the setup with the
  time: `sudo NIGHTLY_AT=03:30 bash vm/dev-vm-setup.sh`. A night missed while the machine was off
  runs when it is next up. Moving the time to one already past today starts a run at once.
- **By hand:** `sudo systemctl start --no-block code-reviewer-nightly.service`. The log is
  `journalctl -u code-reviewer-nightly.service`.
- **The poller:** a pass starts three minutes after the last one ended. To change the interval,
  run the setup with it: `sudo POLL_EVERY=5min bash vm/dev-vm-setup.sh` (seconds, minutes or
  hours: `90s`, `5min`, `1h`). The poller's service uses the same credentials file and the same
  places as the nightly run, and has no update step: a pass runs whatever is checked out. Its
  passes are skipped until the first nightly run has installed the code reviewer's dependencies.
  A pass that has not finished in thirty minutes is stopped. By hand:
  `sudo systemctl start code-reviewer-poller.service`; the log is
  `journalctl -u code-reviewer-poller.service`.
- **The queue:** it has no timer. The poller's service starts it each time a pass ends, however
  the pass ended, so a review a pass has just found starts within that interval, and one that had
  to wait is looked at again after the next pass. A turn runs one review and lasts as long as it
  does (one that is turned away from its project's slot takes a moment, and the turn goes on to
  the next); while it is going a second cannot start. The nightly unit is ordered after it, so a
  nightly run that comes due during a review waits for that turn to end before its update step
  replaces the code the review is running from. The queue's unit is in turn not started while the
  nightly unit is active (`/run/code-reviewer-nightly` exists exactly that long). By hand:
  `sudo systemctl start --no-block code-reviewer-queue.service`; the log is
  `journalctl -u code-reviewer-queue.service`.
- **Where things are:** all under `/var/lib/code-reviewer`, which only the `reviewer` user can
  read. `kit/` is the code reviewer's own checkout, `workspaces/` the projects' checkouts
  (`REVIEWER_WORKSPACE_ROOT`) and `state/` the runs' output (`REVIEWER_STATE_DIR`).
- **Before each nightly run** the service runs `bin/update.mjs`: it moves `kit/` to the head of
  the kit's default branch, runs `npm ci` when the lockfile is not the one the installed
  dependencies came from, and applies migrations. If any of that fails the service fails and no
  sweep runs on stale code; the night shows in `status` as a nightly run that failed in
  `moving the checkout`, `installing dependencies` or `applying migrations`, when the code reviewer
  was in a state to record it.

### Credentials

The credentials reach the service only through its environment, from
`/etc/code-reviewer/credentials.env`. Root alone can read the file; systemd reads it before the
service drops to the `reviewer` user. The setup creates it when it is missing and never changes or
prints one that exists. It holds one `NAME=value` per line, with no quotes:

- `DATABASE_URL`: the code reviewer's own database. The setup fills it in.
- `REVIEWER_TEST_DATABASES_URL`: where projects' test databases are created. The setup fills it in.
- `CLAUDE_CODE_OAUTH_TOKEN`: the Claude subscription's token, from `claude setup-token`.
- `REVIEWER_APP_CLIENT_ID`: the App's client id.
- `REVIEWER_APP_PRIVATE_KEY`: the App's private key as one line of base64
  (`base64 -w0 < key.pem`). The code reviewer takes the key as the PEM or as its base64; the file
  needs the one-line form.

The setup turns the timer on only once all five have a value: fill in the last three and run it
again. Nothing is signed in to as the `reviewer` user, and nothing credential-like belongs in its
home: a project's setup, test and check commands run as that user, without these values in their
environment and with a home of their own under `workspaces/`.

### The database

The code reviewer's database is `code_reviewer`, owned by a Postgres role of the same name that
takes a password and is no Linux user's name, so being a local user opens nothing. Nobody else may
connect to it. A second role, `code_reviewer_tests`, may create databases and cannot connect to the
code reviewer's: its address is `REVIEWER_TEST_DATABASES_URL`, and a project's commands are handed
its password inside the addresses of their test databases. The setup generates both passwords,
writes them only into the credentials file, and checks that the `reviewer` user cannot open the
database without one.

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
- A passed PR whose head later moves to already-reviewed code (merging a PR stacked on it leaves such a merge commit) gets its gate carried to the new head: on Actions on the push or on any comment, on the machine by the poller, once for each new head. Only identical code qualifies, and only when the reviews cover everything since the PR's own gated commit.

## Layout

- `src/review-loop.ts` — PR state machine driver; `src/stages/*` — one module per stage (audit and synthesis are shared)
- `src/sweep/*` — the nightly sweep: `loop.ts` driver, `judge.ts` (owner decisions: `wontfix`, hand closes, ticked minors), `tickets.ts` (`needs-judging` tickets, concerns included), `answers.ts`, `publish.ts`, `render.ts` (issue/digest/status text)
- `src/projects.ts` — which projects there are and whether the machine handles each: asked of the App, never listed in the kit (ADR 0004)
- `src/nightly.ts` — the nightly run: its order of work and what it does after a failure, as decisions; `src/runs.ts` — the record of runs on the machine (run ids, output files, how a run ended) and the one place a command is run, given its time limit and told to stop
- `src/night-summary.ts` — whether a night's summary is posted, its title and text, and the discussion category it goes in, as decisions; `src/post-summary.ts` — the `summary` command, which posts it
- `src/nightly-checks.ts` — a project's nightly checks: the order they run in and what happens after one fails, as a decision; the account a failed run ends with; the `checks` command
- `src/poller.ts` — a pass of the poller as a decision: the events it acts on, what it runs and when it tries again; `src/poller-github.ts` — what a pass asks GitHub, conditionally, and the answers it keeps; `src/poller-pass.ts` — the pass itself: the record of events, the lock, and running each command
- `src/queue.ts` — the queue of reviews as decisions: who has the machine, which review starts next, and what a review's run leaves of its event; `src/queue-run.ts` — one turn of the queue; `src/machine.ts` — the two locks that keep agent jobs to one at a time; `src/reply-authority.ts` — whose comment counts as the owner's word
- `src/failure-side.ts` — which side a failed run is on, from the type of its error; `src/failure-issue.ts` — what a failure issue says and when it is opened, commented on and closed; `src/failure-report.ts` — which places a finished run is reported to, and the reporting (`reportRun`)
- `bin/update.mjs` — brings the code reviewer's own checkout up to date before a nightly run; `src/project-row.ts` — creates a project's row the first time it is met
- `../vm/` — the machine setup and the systemd units it installs
- `src/agents/run-agent.ts` — Agent SDK wrapper (structured output, session recording, resume)
- `worker/` — the Cloudflare Worker that starts each repo's sweep on time, as the App (`worker/README.md`)
- `prompts/` — auditor definitions (ISO 25010 verbatim) and pipeline role prompts; `prompts/sweep/` — the sweep's framing of scout, auditor, synthesis and the ticket judge
- `src/test-databases.ts` — the databases a project's tests are given: naming, the record of what to drop, creating and dropping
- `src/db/schema.ts` — repos, reviews, sweeps, rounds, concerns, findings, questions, policies, agent_sessions, github_artifacts, test_databases, runs
