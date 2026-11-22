---
name: install
description: Bring the current project under the kit's process module in one step. Works out what the project already has, shows one plan, and after one confirmation delivers it all as a pull request. Safe to run again; on a project already level with the kit it changes nothing.
disable-model-invocation: true
---

# Install

Install brings the project in the current directory under the kit's **process module**: tickets, the label scheme, the code reviewer's per-PR review on demand and its nightly sweep. The project may be new, or already hold some of the pieces, or older copies of them. Install offers only the process module and writes no product code.

The code reviewer runs on the development machine and finds its projects through its GitHub App: a project with the App installed, a `devkit.json` on its default branch and no code reviewer workflow there is swept that night. So install sets nothing up on GitHub Actions: it writes no workflow, sets no repository secret and gives the project no sweep slot.

The flow has four steps, and the third is a hard stop:

1. Work out the project's state, changing nothing.
2. Ask the owner only what cannot be inferred.
3. Print **one plan** and wait. Nothing is written, removed or created before the owner confirms it.
4. Do the whole plan, delivering the files as a pull request from a branch.

The scripts below are the parts that must not be left to judgement. Run each as `node "${CLAUDE_PLUGIN_ROOT}/<path>" ...`; the ones that change anything have a dry run, and step 1 uses only that.

| Script | What it does | Exit |
| --- | --- | --- |
| `install/kit-commit.mjs` | Prints the kit commit the installed plugin was built from: the last segment of `${CLAUDE_PLUGIN_ROOT}`, a 12-hex SHA prefix (or HEAD, for a plugin loaded from a checkout). | 0, or 2 cannot tell |
| `install/app.mjs installed <repo>` | Asks GitHub, as the code reviewer's App, whether the App is installed on the repo. Prints `installed` or `not installed`. | 0 installed, 1 not, 2 GitHub refused, 3 the App's credentials are not where this session can read them |
| `install/discussions.mjs <repo>` | Asks GitHub, as the owner's `gh` login, whether the project has discussions turned on and the code reviewer's discussion category. Prints `ready`, or exactly what the owner must create. | 0 ready, 1 not, 2 gh failed |
| `generator/generate.mjs <dir> [--check]` | Writes the kit-owned files from `<dir>/devkit.json` and removes the retired ones, printing `wrote <path>` or `removed <path>`; with `--check`, lists the ones behind, and says on stderr which of them are retired. | 0 level, 1 behind, 2 no or invalid `devkit.json` |
| `install/settings.mjs <dir> [--dry-run]` | Removes the permission rules in `.claude/settings.json` that make an agent ask before a plain `git commit` or `git push`. | 0, or 2 not JSON |
| `install/label.mjs <repo> [--dry-run]` | Creates `review-now` if the repo lacks it. Prints `create review-now`. | 0, 1 gh failed |

`<repo>` is `owner/name`. `app.mjs` reads the App's client id and private key from `~/.config/jm-devkit/` (`secrets.env` and `reviewer-app-private-key.pem`, both readable only by the owner; `DEVKIT_CONFIG_DIR` points it elsewhere). Never read, print, `source` or copy a secret value yourself: only the script touches them.

## 1. Work out the state

1. From the project root: `REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)`, the default branch (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`), and the kit commit (`kit-commit.mjs`).
2. If an install pull request is already open (`gh pr list --state open --json headRefName,url` shows a branch starting `devkit-install`), say so with its link and stop: there is one at a time.
3. `git fetch origin`, then add a **detached scratch worktree** of `origin/<default>` in your scratchpad. Read everything below there, not in the owner's checkout: the plan is against the default branch, and uncommitted work in the checkout is not yours to read into it or carry.
4. Gather, each into the plan's groups (step 3):
   - **The App**: `app.mjs installed $REPO`. Exit 2 blocks the plan (below). Exit 3 does not: it is a check that could not be made, and goes under "Left for you".
   - **`devkit.json`**: see "Writing devkit.json". Write the proposed file into the scratch worktree; that is a scratch copy, not the project.
   - **Discussions**: `discussions.mjs $REPO`. On exit 1, what it prints goes under "Left for you" as it is. On exit 2, put what it printed on stderr there instead, as a check that could not be made.
   - **Kit-owned files**: `generate.mjs <worktree> --check` with the proposed `devkit.json` in place. Each path it prints is a write, except one that stderr calls retired, which is a removal. See "A project still on GitHub Actions".
   - **`CODING_STANDARDS.md`**: a write only if it is missing. It is project-owned: never edit one that exists.
   - **Copies of what the plugin supplies**: see "What the plugin now supplies".
   - **Permission prompts**: `settings.mjs <worktree> --dry-run`.
   - **Labels**: `label.mjs $REPO --dry-run`.

The plan is **blocked** by anything that stops it being carried out: an invalid `devkit.json`, or GitHub refusing the App's credentials. Show the script's message in the plan as it is (it names the file and what is wrong, never a value), and stop after the plan: the owner fixes it and runs install again.

The App's credentials being out of this session's reach does not block. On the development machine they are kept on purpose where no agent can read them, and nothing install writes needs them: only the check does.

## 2. Ask only what cannot be inferred

Gather every open question into one message, each with the answer you recommend, before the plan. Usually there are none. Never ask for a secret.

## Writing devkit.json

`devkit.json` is project-owned and validated against `${CLAUDE_PLUGIN_ROOT}/devkit.schema.json`; read the schema's descriptions for what each field means.

- **An existing valid `devkit.json` keeps the owner's values.** Install changes only `kit`. That includes `sweep.hour` and `reviewer.services` in a project that has them: both are retired, still accepted, and read by nothing on the development machine. An invalid `devkit.json` blocks the plan: show the generator's errors.
- **A new one** has, in this order: `$schema` (`https://raw.githubusercontent.com/josephmitchel/jm-devkit/main/plugin/devkit.schema.json`), `modules: ["process"]`, `kit`, `reviewer`, then `nightly` if the project has nightly checks, two-space indented with a final newline. It has no `sweep` and no `reviewer.services`. It has no `deploy` either: the owner adds that section, last, when the apps machine is to deploy the project.
- **`reviewer`**: infer it, in this order of trust:
  1. The project's own CI workflows: the steps that install dependencies are `setup` (joined with `&&`, `cd <dir> &&` for a subdirectory), and each step that runs a test suite or a typecheck is one entry in `tests` (`name`, `command`). Leave out lint and format. The environment its test steps set becomes `env`; a value that is a `${{ secrets.… }}` expression cannot be committed, so ask about it. A test job's `services:` map is not copied: see `reviewer.databases`.
  2. The package manifests and lockfiles, for a language CI does not cover: `package-lock.json` gives `npm ci` and the `test` script, `pnpm-lock.yaml` gives `pnpm install --frozen-lockfile`, `uv.lock` gives `uv sync` and `uv run pytest`, `go.mod` gives `go test ./...`, `Cargo.toml` gives `cargo test`, and so on.
  3. Ask, only for what neither shows.

  Every command runs with `sh -c` from the root of a fresh checkout, and `setup` must be safe to run twice. If the project has a doc about how its test suites are laid out, point `harnessNotes` at it; never write one.
- **`reviewer.databases`**: the tests' databases. On the development machine there are no service containers: the code reviewer creates one empty Postgres database for each environment variable named here and puts its address in that variable. So when a CI test job has a Postgres under `services:`, list the variables its test steps read a database address from, and leave those variables out of `env`. A service of any other kind (a cache, a queue) has no field: ask the owner how the tests should get it.
- **`nightly.checks`**: commands too slow for every pull request, run once a night after the project's sweep, each `{ "name", "command" }`. Write only what the project's CI already runs on a schedule, or what the owner asks for. A check that runs on pull requests today stays there unless the owner says it is moving.
- **`kit`**: the kit commit, written whenever the plan writes anything else. A plan with nothing else in it leaves `kit` as it is: the field is for the record, and a stale value alone does not make a project behind the kit.

## What the plugin now supplies

A project set up before the kit holds copies of what the plugin now supplies. Remove them. Docs that are only the project's own are untouched.

- **The agent docs** `docs/agents/issue-tracker.md`, `docs/agents/ticket-labels.md` (or the older `triage-labels.md`), `docs/agents/domain.md` and `docs/agents/implement-spec.md`. Read each beside the plugin's doc on the same topic, `${CLAUDE_PLUGIN_ROOT}/docs/issue-tracker.md`, `ticket-labels.md` (for both label files), `domain.md` and `implement-spec.md`. What the plugin's doc covers goes, older wordings of the same rule included: the copies drifted, so match by rule, not by text. What is true only of this project stays, as that project-owned doc, now read after the plugin's (a worktree setup command, the project's own close-out checks, ports a run must leave alone). If nothing is left, remove the file.
- **The `## Agent skills` block** in `CLAUDE.md` or `AGENTS.md`: remove its generic subsections (issue tracker, triage or ticket labels, domain docs, and any that only points at a removed doc) and keep the project's own, a Design section say. Remove the heading if nothing is left under it.
- **The house rules**, wherever they appear in `CLAUDE.md` or `AGENTS.md`: the Git rule always, and any other rule in `${CLAUDE_PLUGIN_ROOT}/house-rules.md` the file repeats. The plugin puts them in every session (ADR 0003). Leave the rest of the file exactly as it is.
- **Permission prompts** that contradict the Git house rule: what `settings.mjs` lists.
- **Hand-copied code reviewer workflows**: a workflow that is not kit-owned (a kit-owned file's first line is `# Generated by the devkit generator`) whose job `uses:` the code reviewer's action (`josephmitchel/code-reviewer@…` or `josephmitchel/jm-devkit/reviewer@…`), the old per-PR `code-review.yml` say. Nothing replaces it: the code reviewer on the development machine does that work. Removing it is a move: see "A project still on GitHub Actions".
- **References** in the project's own docs to a file install removes: repoint them at the plugin (`/devkit:<skill>` or "the plugin's tracker rules") or drop them.

## A project still on GitHub Actions

A project whose default branch has a code reviewer workflow has its code reviewer on GitHub Actions today, and removing the workflow is a **move**: merging the pull request hands the project to the code reviewer on the development machine. The workflow is the retired kit-owned `.github/workflows/nightly-sweep.yml`, which the generator's check lists, or a hand-copied one.

When the plan removes one, read `${CLAUDE_PLUGIN_ROOT}/skills/kit/sync/moving-to-the-machine.md` and follow it: the plan's line for the workflow says that merging moves the project, the pull request's title and opening section are the ones it gives, and the steps it leaves the owner go under "Left for you".

If the owner answers the plan by saying the project should stay on GitHub Actions for now, take the workflow out of the plan and leave it exactly as it is. In step 4, after the generator has run, put a workflow it removed back with `git -C <worktree> checkout -- <path>`; `--check` then lists that path alone.

## 3. The plan

Print one plan in this shape, leaving out empty groups, then stop and wait for the owner. One yes covers all of it. If the owner changes something, print the revised plan and wait again.

```
Install plan for <owner/name>, kit <commit>

Write
  devkit.json                          new: setup `npm ci`; tests unit `npm test`; databases TEST_DATABASE_URL (from .github/workflows/ci.yml)
  CODING_STANDARDS.md                  missing: the kit's starter (project-owned)
Remove or edit
  .github/workflows/code-review.yml    remove: hand-copied code reviewer workflow. Merging this pull request moves the code reviewer from GitHub Actions to the development machine
  docs/agents/triage-labels.md         remove: the plugin's label scheme replaces it
  docs/agents/implement-spec.md        edit: keep only the worktree setup and the ports to leave alone
  CLAUDE.md                            edit: remove "## Agent skills" > Issue tracker, Triage labels, Domain docs, and the Git rule; keep "### Design"
  .claude/settings.json                edit: remove permissions.ask "Bash(git commit:*)"
Labels
  review-now                           create
Delivered as
  a pull request from devkit-install-<commit> into main
Left for you
  Install the code reviewer's GitHub App on <owner/name>:
  https://github.com/settings/installations
  <what discussions.mjs printed, as it is>
  After merging: remove the four repository secrets, and take <owner/name> out of the Worker's list
Blocked
  <a script's message, verbatim>
```

"Left for you" holds each step that is the owner's, and appears whenever there is one:

- **The App**, when `app.mjs installed` says `not installed`. A `gh` login cannot add a repository to an App's installation (GitHub answers 403: only a token authorised by a GitHub App can).
- **The App, unconfirmed**, when `app.mjs installed` exits 3. Say that the App's credentials are not where this session can read them, so whether the App is installed on the project was not checked, and that `code-reviewer projects`, which the owner runs on the development machine, lists the project if it is. Do not print the install link as though the App were missing.
- **Discussions**, when `discussions.mjs` does not print `ready`. The code reviewer posts each night's summary as a discussion in the project, and a discussion category can only be created in the project's settings on GitHub: GitHub's API has no call for it. The check is what the owner's `gh` login sees. Whether the App has been granted read and write access to Discussions is a separate thing, set once on the App.
- **The steps after a move**, when the plan removes a code reviewer workflow.

**An empty plan**: when there is nothing to write, remove or create, say `<owner/name> is level with the kit (<commit>): nothing to do.`, add the "Left for you" lines that apply, remove the scratch worktree and stop. No branch, no commit, no pull request.

## 4. Do it

Only after the owner confirms the plan, and only the plan:

1. In the scratch worktree, `git switch -c devkit-install-<commit>`.
2. Write `devkit.json`, then run `generate.mjs <worktree>` to write the kit-owned files and remove the retired ones: never write, edit or remove a kit-owned file by hand. Copy `${CLAUDE_PLUGIN_ROOT}/install/coding-standards.md` to `CODING_STANDARDS.md` if the plan says so.
3. Make the removals and edits, and run `settings.mjs <worktree>`.
4. Check: `generate.mjs <worktree> --check` exits 0 and `settings.mjs <worktree> --dry-run` prints nothing.
5. Commit with a message that says what changed and why, push, and open the pull request with `gh pr create`. The body is the plan, each item with its reason, and the steps left for the owner.
6. `label.mjs $REPO`. This changes the repository at once, not on merge.
7. Remove the scratch worktree, and report: the pull request's link, the label, and the steps left for the owner.

Running install again once the pull request is merged, the App is installed and the discussion category exists shows an empty plan with nothing left for the owner.
