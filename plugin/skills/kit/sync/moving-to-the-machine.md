# A pull request that moves a project to the machine

A project whose default branch has a code reviewer workflow is still on GitHub Actions: the workflow runs its nightly sweep, its `landed` job and its `review-now` review there, and the code reviewer on the owner's machine leaves the project alone. A pull request that removes the workflow is a **move**: merging it is the moment the machine takes the project over. Until the merge nothing changes.

The workflow is the retired kit-owned `.github/workflows/nightly-sweep.yml` (the generator prints `removed` for it), or, in a project from before the kit, a hand-copied workflow whose job `uses:` the code reviewer's action.

A move is the owner's decision, made by merging. So the pull request says it is a move in its title and at the top of its body, and lists what the owner does around the merge. Follow every section below.

## 1. Gather, changing nothing

- **Services**: the keys of `reviewer.services` in the branch's `devkit.json`, if it has any.
- **Discussions**: run `node "${CLAUDE_PLUGIN_ROOT}/install/discussions.mjs" <owner/name>`. It prints `ready` (exit 0), or what the owner must create (exit 1), or on stderr why it could not ask (exit 2).

## 2. Tell the user now

In sync, before opening the pull request, tell the user in one sentence that merging it moves `<owner/name>`'s code reviewer from GitHub Actions to the owner's machine. If they did not mean to move the project, stop here: remove the worktree and its branch, and open nothing.

In install, the plan's line for the workflow says the same thing, and the owner's yes to the plan is the answer.

## 3. The title

`Move the code reviewer to the owner's machine (kit <kit>)`, whatever else the pull request changes.

## 4. The body

Start the body with this section, filled in, ahead of anything else it says. Leave out a "Before merging" item whose condition, listed after the section, is not met.

```markdown
## Merging this moves the project to the machine

This pull request deletes `<workflow path>`, the workflow that runs the code reviewer on GitHub Actions. The kit has retired it. **Merging is the move**: from then on the code reviewer on the owner's machine handles this project. Its nightly run sweeps the project, and its poller acts within minutes on a merged pull request, a `review-now` label, your answer to a waiting review, and a passed pull request whose head moves. Until this is merged the project stays on GitHub Actions, exactly as it is.

### Before merging

- [ ] **Test databases.** `devkit.json` has `reviewer.services` (`<service ids>`). It described containers for an Actions job, and nothing reads it on the machine. If the tests need a database, add `reviewer.databases` to `devkit.json`: the names of the environment variables that must each hold a database's address. The machine creates an empty Postgres database for each before setup. Push that change to this branch.
- [ ] **Nightly checks.** If a check is leaving pull requests to run once a night instead, add it to `devkit.json` as `nightly.checks`, a list of `{ "name", "command" }`, and push that change to this branch. The machine runs each after the project's sweep.
- [ ] **Discussions.** <the message `discussions.mjs` printed, as it is>

### After merging

A pull request cannot do these, and the move is not finished until they are done:

- [ ] Remove the project's four repository secrets. Only the workflow used them.
  ```
  gh secret delete DATABASE_URL -R <owner/name>
  gh secret delete CLAUDE_CODE_OAUTH_TOKEN -R <owner/name>
  gh secret delete REVIEWER_APP_CLIENT_ID -R <owner/name>
  gh secret delete REVIEWER_APP_PRIVATE_KEY -R <owner/name>
  ```
- [ ] Take the project out of the Worker's list: remove its line from `reviewer/worker/src/repos.ts` in the kit and deploy the Worker again (`reviewer/worker/README.md` in the kit). Until then the Worker's nightly dispatch for this project fails, because the workflow it starts is gone.
```

The conditions:

- **Test databases**: `devkit.json` has `reviewer.services`.
- **Nightly checks**: always.
- **Discussions**: `discussions.mjs` exited 1. If it exited 2, write instead that the project's discussions could not be checked, with what it printed on stderr, and that the machine posts each night's summary in a discussion category named for the code reviewer.

`devkit.json` is the owner's file. The pull request tells the owner what to add; make none of these edits yourself unless the owner asks.

## 5. When you report

Give the user the pull request's link, say again that merging it is the move, and list the "Before merging" and "After merging" items that are theirs.
