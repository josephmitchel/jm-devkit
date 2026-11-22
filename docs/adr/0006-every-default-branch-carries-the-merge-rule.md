---
status: accepted
date: 2026-11-22
---

# Every project's default branch carries the merge rule, and nobody may bypass it

A project under the kit has one rule on its default branch on GitHub, the **merge rule**: the branch cannot be deleted or force-pushed, a change reaches it only through a pull request, every job of the project's CI workflow must have passed on that pull request, and no account or app may bypass any of this, the owner's included. GitHub holds it as one repository ruleset on the default branch, active, with no bypass actors, and the rule is for projects on github.com: a required check counts only when GitHub Actions there reported it. Its exact form is `MERGE_RULE` in `plugin/install/merge-rule.mjs`, the only place the kit holds it. Install puts the rule in place and sync checks it again, both by running that script.

The rule is what makes "it is on the default branch" mean "it came through a pull request and passed CI". The apps machine's deploy rests on that (ADR 0005): it takes a project's default branch as it is and runs no checks of its own, and it holds no GitHub credential that could read the rule. Before this record the owner added the rule to each project by hand, so a new project had it only if he remembered, and nothing noticed a project that had lost it or whose CI had gained a job the rule did not require.

## What install and sync may do to a rule

- **They only add.** Where a project has no such ruleset the script creates it, and where the ruleset lacks one of CI's checks it adds that check. It never removes a ruleset, a rule or a required check, never changes who may bypass a ruleset or whether it is active, and leaves alone whatever is stricter than the rule. A rule that is inactive, bypassable or short of a restriction is reported, naming which, for the owner to put right. The kit's own mistakes are then bounded: none of them can open a default branch.
- **They write only to a ruleset for the default branch alone.** A ruleset that also covers other branches can be the merge rule, and is judged as one, but a check added to it would be required on every branch it covers. So one that falls short is reported and left as it is.
- **Adding needs admin rights on the repository.** An account without them is given the one command that does it, for an account that has them to run. The command that adds checks sends the ruleset whole, as it was read, so it is given only when the missing checks are all the ruleset lacks: run late, it could otherwise undo the owner's own correction.
- **An account without admin rights is not shown who may bypass a ruleset.** For it the rule is `in place` only as far as it can see, and the script says so, with the command by which an account that has them confirms nobody can.
- **The required checks follow the CI workflow**, which is `.github/workflows/ci.yml` on the default branch. A job reports a check named for its id, or for its `name:` when that is a plain string. A required check that never reports leaves every pull request waiting for good, so a check is required only when the workflow's text settles its name. A matrix job, a job that calls another workflow, a job whose name holds an expression, and every job of a workflow that does not run on every pull request into the default branch are reported and not required.

## Considered options

- **Leave it an instruction to agents.** The Git house rule already says to work through pull requests. An instruction is not a boundary, and the deploy needs one: an agent that pushed to a default branch by mistake would have put unchecked code where the apps machine takes it from.
- **Let the owner bypass.** A way round for an urgent fix, but the default branch would then mean "passed CI, unless someone was in a hurry", and nothing downstream could tell which.
- **Put a weaker rule right automatically.** Install could make a ruleset active or empty its bypass list. Code that edits those settings is code that can set them wrong, and a ruleset that is inactive or bypassable was made so by someone, for a reason the kit cannot see.
- **Require a guess at a check's name.** Requiring `test (22)` for a matrix job is right until the matrix changes, and from then on no pull request in the project can merge.

## Consequences

- Nobody can push a fix straight to a default branch. Every change waits for a pull request and its CI.
- A project is registered on the apps machine only once install reports its merge rule `in place` without qualification, which takes an account that is shown who may bypass the rule. Weakening the rule on a project that is deployed there weakens the first decision of ADR 0005 with it.
- A job added to the CI workflow becomes required at the next install or sync run by an account with admin rights. A pull request opened before the job existed must take in the default branch before it can merge.
- Renaming or removing a CI job, or making it a matrix, leaves the rule requiring a check that nothing reports, and no pull request can merge until the owner takes that check out of the ruleset by hand: the kit never removes one. It says so only when the whole workflow has stopped running on every pull request or is gone, because a required check it does not recognise may be another workflow's.
- A project with no `.github/workflows/ci.yml`, or one that does not run on every pull request, cannot have the rule in place: the kit says so on every install and sync.
- Who may merge is not part of the rule. That stays an instruction to agents.
