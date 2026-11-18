# /implement-spec additions

The skill's flow as written: an integration branch, a worktree and branch per ticket, a merger subagent, a draft PR. This file adds how every project runs it. A project's own `docs/agents/implement-spec.md`, if it has one, adds what is true only of that project: its worktree setup command, its test commands, the checks it runs at close-out, the ports or services a run must leave alone, and any rule its worktrees enforce.

## How the run goes

1. **The integration branch** comes off the default branch. The draft PR opens after the first merge into it, its body the `/pr` template with `Addresses #N` for the spec and every ticket, never `Closes`: the merge hands them to the nightly judge, which closes them (`issue-tracker.md`, "Closing work through PRs").
2. **Push twice:** once after the first merge, so the draft PR can open, and once in the close-out. Every push to the PR starts CI again, so the merges in between stay local.
3. **Each implementer** works in its own worktree (`isolation: "worktree"`), runs the project's worktree setup there first if it has one, and gets its ticket number and a shared brief file (saved in the scratchpad), not a retold spec. A worktree can start on the default branch: the brief says to branch from the local integration branch.
4. **Overlapping files get an owner.** Before dispatch, name every file two frontier tickets will both touch (the glossary, the README, a shared layout or entry point) and give each part to one ticket in the brief, so the merger meets as few conflicts as possible. Name shared concepts the same way: the module that defines a rule, a read or a helper the frontier will need, and which ticket writes it. The rest reuse it.
5. **Every merge is reviewed.** The merger subagent reads the ticket's diff against the integration branch tip before merging, looking for **duplication** with what has landed or with a sibling's report:
   - a helper, constant or type a merged ticket already exports;
   - a rule written a second time, in two languages or in two reads, without a parity test;
   - a read the same request already makes.

   Findings go back to that ticket's implementer (SendMessage), and the merge waits for the fix. This catches parallel tickets' overlap while the siblings still run, instead of in one serial fix pass at the end.

6. **Close-out, in this order,** after the last merge:
   1. `/code-review` on the integration branch against the default branch; one implementer fixes its findings on that branch.
   2. Push.
   3. While CI runs, the orchestrator runs the project's own close-out checks, if its doc names any. A finding costs one more push; CI cancels the superseded run.
   4. Once CI's full test suites pass, mark the draft PR ready. Merging it is the user's.

## The brief carries

- the hard rules: the `tdd` skill, commit only in your own worktree and branch, never force-push, and the project's own hard rules;
- the test scope: the ticket's own test files during the `tdd` loop; before reporting, after merging the integration tip, lint, typecheck and those tests plus any test file the ticket touched. The full suites run once, in CI on the close-out push;
- where the values live: the spec, and any signed-off design it points to;
- the sibling tickets running at the same time, and the file and concept owners from step 4;
- the report shape: branch and commits, test results, anything left for the close-out, and anything a sibling must know.
