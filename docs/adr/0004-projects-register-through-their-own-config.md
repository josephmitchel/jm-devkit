---
status: accepted
date: 2026-11-12
---

# A project registers itself: its config file, plus the GitHub App being installed on it

Everything the kit needs to know about a project lives in that project's `devkit.json`, and the set of projects is the set of repositories the code reviewer's GitHub App is installed on. The kit holds no list of projects. Before this, adding a project meant a database row written from a laptop, a line in the sweep Worker's source and a redeploy; that made install a change to two repositories and kept the kit from ever being a one-step install. Reading a file in the project on every run costs a little on each run and removes all of that.

## Consequences

- Install touches only the project. The remaining human step is installing the App on the repository.
- The code reviewer names no project. On the development machine it finds them through the App, and each night's run sweeps every one it handles (ADR 0007). Before that move, the sweep Worker never did: it kept its own list of projects, each with a cron, in its source. Sweep hours are retired, and the Worker and its list go with the kit's Actions support.
- The code reviewer's database keeps what it has learned about a project (its policies, its digest issue) but no longer holds how to set the project up or test it.
