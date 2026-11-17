---
status: accepted
date: 2026-11-12
---

# The plugin forks upstream's skills

The plugin carries its own copy of every one of Matt Pocock's skills and edits their text, so the upstream plugin is no longer installed. This reverses the decision of 2026-11-02 to leave the skills unedited and tune around them with files in each project ("fork later only if friction turns out to be inside the skill files"). The friction turned up in the tuning files instead: each project held its own copy of the tracker rules, the label scheme and the design process, the copies drifted within ten days, and one of them existed only because a skill's text could not be changed. Owning the text is the only arrangement where a process rule is changed once, in the kit, and reaches every project when the plugin updates.

## Considered options

- **Depend on the upstream plugin and own only the surrounding files.** Upstream improvements keep arriving for free, but a plugin cannot override another plugin's skill, so every tuned rule stays a copy in every project.
- **Fork only the skills in use.** Less to maintain, but rejected because the unused skills are ones Joseph expects to grow into.

## Consequences

- Upstream changes arrive only when they are pulled in on purpose. To keep that pull a readable diff, the fork keeps upstream's skill names and folder layout, keeps kit changes as small edits inside the skills, and records the upstream commit it was last brought level with (first fork: `49dd158`, plugin version 1.3.1).
- `setup-matt-pocock-skills` is the one skill not carried: the kit's install replaces it.
- Upstream is MIT licensed. The copyright notice and the credit in the `pr` skill stay.
