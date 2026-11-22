---
name: sync
description: Bring the project's kit-owned files level with the installed kit, and open a pull request with the change. Removes a kit-owned file the kit has retired; removing the sweep workflow moves the project's code reviewer to the development machine. Checks the merge rule on the project's default branch.
disable-model-invocation: true
---

Sync brings this project's kit-owned files level with the kit the plugin was installed from. It runs only because the user asked; never start it on your own, and never suggest running it on a schedule.

The generator is the only thing that writes or removes a kit-owned file: `${CLAUDE_PLUGIN_ROOT}/generator/generate.mjs` (its README beside it gives the exit codes). It removes a **retired** file: a kit-owned file the kit no longer writes. Sync writes and removes the files the generator lists, sets the `kit` field of `devkit.json`, and changes nothing else in the project. Every other file in the project is project-owned or not the kit's at all, including the rest of `devkit.json`: leave them alone even when they look out of date. If a kit-owned file cannot be made what the user wants by the generator, the change belongs in `devkit.json` or in the kit, not in the file.

Shell state does not carry between commands, so write out each path in full.

## 1. Check

Find the project root with `git rev-parse --show-toplevel`. If it has no `devkit.json`, tell the user the project is not under the kit and to run `/devkit:install`, and stop.

Check the **merge rule**, the rule every project's default branch carries on GitHub (ADR 0006 in the kit): run `node "${CLAUDE_PLUGIN_ROOT}/install/merge-rule.mjs" <owner/name>`, with `<owner/name>` from `gh repo view --json nameWithOwner -q .nameWithOwner`. Only that script changes a rule, and it only adds: when the `gh` login has admin rights on the repository it creates the rule where the default branch has none, and adds each CI check that a rule for the default branch alone does not require. Keep what it prints. The message that ends this sync, at whichever stop below, gives the user every line of it as it is:

- A line starting `in place`, `create merge rule` or `add required checks` says how the rule stands or what the script just did. `in place, as far as this account can see` is how the rule stands for a `gh` login without admin rights, and asks nothing of the user here.
- A line starting `printf` is the one command that does what the line before it says: keep it whole, on a line of its own under that line, for the user to run.
- Any other line is left for the user.
- On exit 1, give the user what it printed on stderr as well: the rule could not be checked, or GitHub refused the change.

Then run `node "${CLAUDE_PLUGIN_ROOT}/generator/generate.mjs" <root> --check`:

- **Exit 0**: tell the user the project is level with the kit. Stop: no branch, no commit, no pull request.
- **Exit 2**: `devkit.json` is not valid. Show the user the errors from stderr and stop. `devkit.json` is the user's file; do not fix it for them unasked.
- **Exit 1**: the paths on stdout are behind. A path that stderr calls retired (`<path> is retired: <what removing it does>`) will be removed; the others will be written. Go on.

## 2. Work on a branch from the default branch

Follow the Git house rule. Work in a worktree of your own, so the user's checkout, its branch and anything uncommitted in it are left as they are:

- Read the kit commit: the last path segment of `${CLAUDE_PLUGIN_ROOT}` (`basename "${CLAUDE_PLUGIN_ROOT}"`). An installed plugin's directory is named for the 12-character prefix of the kit commit it came from. If that segment does not match `^[0-9a-f]{7,40}$`, the plugin is loaded from a checkout of the kit: use `git -C "${CLAUDE_PLUGIN_ROOT}" rev-parse --short=12 HEAD` instead. If neither gives a commit, go on without one and say so in the pull request.
- `git -C <root> fetch origin`, and find the default branch with `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.
- If `gh pr list --head devkit-sync-<kit> --state open` finds a pull request already, give the user its link and stop.
- `git -C <root> worktree add <tmp> -b devkit-sync-<kit> origin/<default>`, with `<tmp>` a new empty directory from `mktemp -d`. Name the branch `devkit-sync` when there is no kit commit.

## 3. Regenerate and show the difference

Run `node "${CLAUDE_PLUGIN_ROOT}/generator/generate.mjs" <tmp>`. It writes only the kit-owned files that differ, printing `wrote <path>` for each, and removes each retired file the branch still has, printing `removed <path>`. If it prints nothing (the default branch is already level, a sync merged since the user's checkout was made, say), remove the worktree and its branch, tell the user the default branch is level, and stop. If it exits 2, the default branch's `devkit.json` is not valid: show the errors, remove the worktree and its branch, and stop.

Show the user `git -C <tmp> status --short` and the diff of the written files, in full for a file that changed and as a list for a file that is new or removed, with a sentence on what the change amounts to.

**If the generator printed `removed .github/workflows/nightly-sweep.yml`, this sync is a move**: merging its pull request takes the project's code reviewer off GitHub Actions and hands the project to the code reviewer on the development machine. Read `${CLAUDE_PLUGIN_ROOT}/skills/kit/sync/moving-to-the-machine.md` now, before going on. It has what to gather, what to tell the user before a pull request exists, and the title and opening section the pull request must carry.

## 4. Record the kit commit

Set the top-level `kit` field of `<tmp>/devkit.json` to the kit commit with an edit to that one value, keeping every other byte of the file as it was. If there is no `kit` field, add one as a top-level key after `modules`. The value is for the record only: whether a project is behind is decided by regenerating, never by this field. With no kit commit, leave the field as it is.

Run the check again in `<tmp>`. It must exit 0; if it does not, show the user why and stop without committing.

## 5. Open the pull request

- Stage the written and removed paths and `devkit.json` by path (`git add <path>` stages a removal too), nothing else, and commit with a message such as `Sync kit-owned files with the kit at <kit>`.
- `git -C <tmp> push -u origin devkit-sync-<kit>`, then `gh pr create` from `<tmp>` with the base set to the default branch. The body says which kit-owned files were written or removed and why, in a sentence each, and names the kit commit as a link to `https://github.com/josephmitchel/jm-devkit/commit/<kit>`. A move's title and opening section come from `moving-to-the-machine.md`.
- Remove the worktree with `git -C <root> worktree remove <tmp>` (the branch stays: it is the pull request's).

Give the user the pull request's link and what the merge rule script printed. Merging is theirs.
