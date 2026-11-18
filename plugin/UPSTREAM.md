# Upstream

The skills in `skills/` are forked from Matt Pocock's skills (ADR 0001). The fork is level with:

- Repository: https://github.com/mattpocock/skills
- Commit: `49dd158d1076134a641b33efb035946536778336`
- Plugin version: 1.3.1

Upstream is MIT licensed; its notice is in `UPSTREAM-LICENSE`.

Every skill in upstream's plugin manifest is carried under the same name and folder, except `setup-matt-pocock-skills`: install (`/devkit:install`) replaces it, and the skills that sent the reader to it name install instead. Upstream's unlisted folders (in-progress, misc, deprecated) are not carried.

To see the kit's edits, diff `skills/` against upstream's `skills/` at the commit above. When upstream is pulled in again, update the commit and version here.
