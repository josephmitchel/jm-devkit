---
status: accepted
date: 2026-11-12
---

# House rules live in the plugin, not in a project's CLAUDE.md

The rules that hold in every session of every project (the Git rule, for one) are delivered by the plugin, which adds them to each session as it starts and to each subagent as it spawns. A project's `CLAUDE.md` holds only what is true of that project, so a reader will not find the Git rule there, and that is deliberate. A block copied into each `CLAUDE.md` would be visible in the repo, but it is the same per-project copy that drifted before the kit existed.

## Consequences

- The rules reach only sessions that have the plugin. That is every session today: Joseph runs local sessions only, with the plugin installed for his user. A cloud session, or the Claude GitHub Action without the plugin loaded, would get none of them, and that would be the moment to revisit this.
- The plugin is installed per machine and a project does not declare it in its own settings, because a committed setting does not install anything.
- The Code Reviewer's agents are unaffected either way. They run with no project or user settings and read neither `CLAUDE.md` nor the plugin.
