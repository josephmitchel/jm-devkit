---
status: accepted
date: 2026-11-25
---

# The code reviewer runs on the development machine and finds GitHub's events by polling

The code reviewer used to run on GitHub Actions. GitHub's own schedule started the nightly sweep hours late, so a Cloudflare Worker had to dispatch it. Its state lived in a hosted database. Every project carried a kit-owned sweep workflow, four repository secrets and a sweep hour of its own, so that the sweeps did not compete for the one subscription. The owner has an always-on Linux machine where development already happens. The code reviewer now runs there as an ordinary service, as its own unprivileged user, started by systemd timers.

- **One nightly run sweeps every project.** A timer starts it at a time set on the machine, and it catches up after downtime. It takes the projects in name order: each one's sweep, then its summary, then its nightly checks. A failure costs only that project. There are no sweep hours, no Worker and no per-project workflow or secrets. Adding a project is still install plus the App (ADR 0004).
- **Events are found by asking, not by being told.** The machine has no address GitHub can reach. So a second timer runs a pass every three minutes and asks for what has changed: merged pull requests, a `review-now` label, an owner's answer, a moved head. It records each event it handles in the database, so each one runs once across restarts and overlapping passes. Passes use conditional requests, so a quiet pass costs almost none of the App's rate limit. Given up: a merge, a label or an answer is acted on up to one interval later than on Actions.
- **One agent job at a time on the machine.** Reviews and sweeps share one subscription and one machine, held by a lock in the database. A review that cannot start yet is queued, not dropped. `landed` and `carry-gate` run no agents and do not wait.
- **Failures are filed where the fault is.** A failure on the project's side (its config, its setup, its checks, its discussions) opens an issue in the project, with the end of the output. Anything else opens one in the kit's repository. That issue names no project and quotes no output, because the kit is public and a project may not be. The next success of the same kind closes it.
- **The machine updates itself each night.** Before the nightly run, the code reviewer's checkout moves to the kit's default branch and applies migrations, which keeps ADR 0002. Given up: until then, a merged change to the code reviewer, or a new project config field, is not yet known to the machine (#109).

## What it rests on

The code reviewer's credentials (the database address, the Claude token and the App's key) reach the service from a file only root can read. They do not live in its user's home, and a project's commands run without them in their environment. Agents developing on the same machine run as a different user, with no access to the code reviewer's files or database. A project's own commands still run as the code reviewer's user, as they shared a runner with it on Actions. So a command written to look for the credentials in a running process could find them (#99). A separate user for project commands would close that, and is left for its own decision.

## Considered options

- **Stay on Actions with the Worker.** Nothing to run at home. But it keeps the Worker, the hosted database, the per-project workflow, the four secrets and the sweep slots: every part that made adding a project more than install.
- **Webhooks through a tunnel or a relay.** Events would arrive at once. But it gives the development machine a way in from the internet, or adds a hosted relay to keep alive. That is the kind of service this move removes.
- **A hosted server for the code reviewer.** On time, and reachable by webhooks. But it is a second machine to pay for and keep up, holding the same credentials, for a load one always-on machine already carries.

## Consequences

- The machine's uptime is best effort. A missed night runs when the machine is next up, and a sweep always covers everything since the previous one.
- Each night's summary is a dated discussion in the project. A quiet night posts nothing. For a public project the discussions are public, as its issues already are.
- Only a project's CI stays on GitHub Actions. The kit's Actions support (the action, the Worker, the dispatch hand-off and the workflow template) goes once every project has moved and the database is on the machine.
- Moving the code reviewer back to a hosted runner, or letting GitHub reach the machine, reverses a decision here, and is made by replacing this record.
