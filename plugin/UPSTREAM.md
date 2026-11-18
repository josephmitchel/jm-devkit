# Upstream

The skills in `skills/` are forked from Matt Pocock's skills (ADR 0001). The fork is level with:

- Repository: https://github.com/mattpocock/skills
- Commit: `49dd158d1076134a641b33efb035946536778336`
- Plugin version: 1.3.1

Upstream is MIT licensed; its notice is in `UPSTREAM-LICENSE`.

Every skill in upstream's plugin manifest is carried under the same name and folder, except `setup-matt-pocock-skills`: install (`/devkit:install`) replaces it, and the skills that sent the reader to it name install instead. Upstream's unlisted folders (in-progress, misc, deprecated) are not carried.

Skills the kit edited, and why:

- `ask-matt`: names `/devkit:install` in place of the setup skill.
- `to-tickets`, `to-spec`: read the tracker rules and label scheme from `docs/` in the plugin; apply the kind `spec` and the status `ready-for-agent`; read the domain docs guidance.
- `triage` (with `AGENT-BRIEF.md`): its roles are the label scheme's kinds and statuses, `enhancement` is `spec`; reads the tracker rules, label scheme and domain docs guidance from the plugin.
- `implement-spec`: reads the tracker rules and its additions from the plugin; the draft PR addresses its tickets rather than closing them.
- `code-review`, `implement`, `wayfinder`: read the tracker rules from the plugin (`wayfinder` also calls `ready-for-agent` a status).
- `improve-codebase-architecture`, `diagnosing-bugs`, `tdd`: read the domain docs guidance from the plugin.

Each of them also reads the project's `docs/agents/` doc on the same topic, if it has one, for what is true only of that project.

To see the kit's edits, diff `skills/` against upstream's `skills/` at the commit above. When upstream is pulled in again, update the commit and version here.
