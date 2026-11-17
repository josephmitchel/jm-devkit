---
status: accepted
date: 2026-11-12
---

# Projects track the kit's main branch, with no pins

Every project uses the kit's actions and reusable workflows at `@main`, and the plugin declares no version, so each push to the kit's `main` is the new version everywhere. Nothing is tagged and no project pins a release. The kit exists so that changing the way of working is one push; pinned versions would turn every change back into one pull request per project, which is the drift the kit was built to end.

## Consequences

- A bad push reaches every project's next run. The safety net is the kit's own CI on pull requests, and the kit being a project of itself, so it is swept like any other.
- A session that is already running keeps the old plugin until its plugins are reloaded.
- The npm packages are the exception. A package is pinned by each project's lockfile, so a change to the canvas engine or the web config reaches a project through a sync pull request, not at once.
