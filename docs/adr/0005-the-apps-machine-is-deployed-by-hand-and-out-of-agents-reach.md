---
status: accepted
date: 2026-11-21
---

# The apps machine is deployed by hand, no agent can reach it, and it cannot read its own backups

The apps machine runs the real copies of the owner's apps, with their real data and production keys. The development machine cannot do that: agents work there unattended, and it holds seeded data only so that nothing an agent does can touch the real thing. Three decisions keep the apps machine out of that reach, and each one costs something.

- **Deploys are manual.** An app changes only when the owner runs the deploy command on the apps machine. The command takes the project's default branch as it is on GitHub and nothing else: no other branch, no pull request, and nothing pushed or copied from the development machine. The real copy then changes only while the owner is there to see it, and only to code that came through a pull request. Given up: a merged change is not running until the owner deploys it, a branch cannot be tried against real data before it merges, and no agent can ship a fix while the owner is away.
- **Agents have no access.** No agent has an account, a key or a route onto the apps machine, and its setup installs no agent tooling and creates no user for agents or for the code reviewer. An agent runs unattended and acts on what it reads, so a rule telling it to leave real data alone would be an instruction, not a boundary; the boundary is that there is nothing there for it to use and no way in. Given up: an agent cannot look at a running app, its log or its database, so every act on the machine costs the owner's own time, and a fault that shows only in real data reaches an agent as what the owner copies out.
- **Backups are encrypted to a key the machine does not hold.** Each night's bundle is encrypted to a public key set when the machine is built, and the private key is never on the machine. A bundle carries an app's settings file as well as its database, so it holds production keys: whoever takes over the machine or the storage account must not be able to read the bundles already made. Given up: the machine cannot decrypt a bundle, so it cannot check a backup by restoring it, a restore needs the owner's own device, and losing the private key loses every backup.

## What the first decision rests on

A deploy does not run a project's checks again. It trusts the default branch, and that is safe only because of the merge rule (#68): every project's default branch takes changes only through pull requests whose CI has passed, with no bypass for anyone. Install puts the rule in place and sync checks it. The apps machine holds nothing for GitHub but a read-only key for each repository, so it cannot check the rule for itself: a project is registered on the apps machine only once install reports the rule in place. Weakening the rule on a project that is deployed there weakens this decision with it.

## Considered options

- **Deploy when a pull request merges.** Nothing waits on the owner, but the real copy would change with nobody watching, and a migration that goes wrong would meet real data unattended.
- **Deploy from the development machine.** One command where the work already is, but it needs a route and a key from the machine agents work on to the machine they must not reach, and it makes whatever is in a checkout there a candidate for running against real data.
- **Give agents read-only access for diagnosis.** Reading is the access that matters: the real data and the production keys are what is being kept from them.
- **Keep the backup key on the machine, so it can restore itself.** A restore becomes one step, but taking over the machine then opens every backup it ever made.

## Consequences

- An agent investigates a problem on the apps machine from a copy of the app's recent log, which the owner sends to the development machine with one command run from his own device. Neither machine connects to the other.
- A backup is proven from outside the machine: one real restore, decrypted on another device, is done while building it, before the backups are relied on.
- An automatic deploy, a deploy of an unmerged branch, a deploy from the development machine, or any account, key or tool for an agent on the apps machine reverses a decision here, and is made by replacing this record, not by adding a command.
