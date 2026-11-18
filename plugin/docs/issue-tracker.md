# Issue tracker: GitHub

A project's issues and specs live as GitHub issues in the repository of the checkout. Use the `gh` CLI for all operations.

These are the rules every project follows. A project's own `docs/agents/issue-tracker.md`, if it has one, adds only what is true of that project (a milestone per phase, say); it does not change the rules here.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies. Give every ticket you file a kind and a status from the label scheme (`ticket-labels.md`); a wayfinder map and its tickets carry only their `wayfinder:` labels.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (database id, as in **Blocking** below). Without sub-issues, put `Part of #<parent>` at the top of the child body.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocking-db-id>`, where `<blocking-db-id>` is the blocking issue's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blocking issues only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every ticket blocking it is closed or its edge was lifted: a merged PR turns each "blocked by" on the tickets it addresses into "relates to" before the judge runs (**Closing work through PRs**; those mutations take GraphQL node ids, not database ids).
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Closing work through PRs

Every ticket closes by one rule. A **ticket** is any issue a PR can address; an issue the nightly
code reviewer opened is a ticket labelled `concern`. Work does **not** close through its PR:
the code reviewer closes tickets, after a judge has checked the landed code against the ticket and
the project's standards.

- The PR body carries one `Addresses #N` line per ticket behind it (the spec, each slice, each
  code reviewer concern it fixes). Never `Closes #N` / `Fixes #N` / `Resolves #N`: GitHub would
  close the ticket on merge. (The merge automation reopens a ticket closed that way and labels it
  anyway, but do not rely on it.)
- Once the PR is **merged**, two things happen to every ticket it addresses, automatically (the
  `landed` job in `.github/workflows/nightly-sweep.yml` runs on the merge): the ticket's status
  becomes `needs-judging` (replacing `ready-for-agent` or whatever it carried), and its blocking
  edges are lifted — each "blocked by" edge on the tickets it blocks becomes "relates to", so they
  can start today rather than after the judge runs. Check the
  ticket's thread for the "PR #N landed" comment; if it is missing (the workflow failed, or the PR
  body named the ticket some other way), do both by hand:
  ```
  gh issue edit <N> --add-label needs-judging --remove-label ready-for-agent,needs-work
  # the tickets #N blocks, and the node ids the mutations need; rerun with
  # after:"<endCursor>" while hasNextPage is true
  gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){
    issue(number:$n){ id blocking(first:100){ totalCount pageInfo { hasNextPage endCursor }
      nodes { id number } } } } }' \
    -f o=<owner> -f r=<repo> -F n=<N> --jq '.data.repository.issue | "\(.id)", .blocking.pageInfo, (.blocking.nodes[] | "\(.number) \(.id)")'
  # for each dependent: add the relation first, then remove the blocking edge, so a
  # failure part-way leaves the edge in place for a rerun to find
  gh api graphql -f query='mutation($dep:ID!,$blocking:ID!){
    addRelatesTo(input:{issueId:$dep, relatedIssueId:$blocking}){ clientMutationId } }' \
    -f dep=<dependent node id> -f blocking=<node id of #N>
  gh api graphql -f query='mutation($dep:ID!,$blocking:ID!){
    removeBlockedBy(input:{issueId:$dep, blockingIssueId:$blocking}){ clientMutationId } }' \
    -f dep=<dependent node id> -f blocking=<node id of #N>
  ```
  The `landed` job lifts native dependencies only. A dependent that names #N in a `Blocked by:`
  line at the top of its body (the fallback under **Blocking** above) is lifted by hand: move #N
  from that line to a `Relates to:` line.
- The judge runs overnight. It either closes the ticket as completed with a comment saying what it
  checked, or replaces the status with `needs-work` and a comment listing what is missing, file by
  file, in order. A `needs-work` ticket is picked up like any other open ticket; the follow-up PR
  says `Addresses #N` again and the merge relabels it `needs-judging`. A `needs-work` verdict does
  not re-block the tickets that were lifted: they build on what is on main either way.
- **Dismissing** a ticket is the `wontfix` label, added by the owner with an optional comment. The
  nightly sweep closes it as not planned, removes every other status label,
  lifts its blocking edges (commenting on each dependent that the ticket blocking it was dismissed)
  and saves the comment as a project policy, so the code reviewer never raises the point again. No
  comment, no policy. Agents never add `wontfix` on their own.
- **Closing by hand** is final for every ticket and is never judged. It stays the way to close a
  ticket with no code behind it — a decision, research, a spec parent whose slices are all closed.
  Closing a code reviewer concern by hand neither asks for its judge nor dismisses it.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(A project that treats external PRs as feature requests says `yes` in its own `docs/agents/issue-tracker.md`; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see **Make an issue a sub-issue of a parent**). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: as in **Blocking** above.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocking issue (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
