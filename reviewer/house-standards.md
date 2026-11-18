# House standards

Read at review, not while implementing. The code reviewer holds every project to these, alongside the project's own `CODING_STANDARDS.md`. Each rule here is a judgement call no check can make and holds in every project; a rule only one project needs belongs in that project's own file, and anything mechanical belongs in its linters, type checker or CI instead.

## Invariant comments move with the code

A comment that states an invariant is part of the surface a diff changes. When a change breaks the invariant, the comment changes in the same diff, and a reviewer reads the invariant comments in every touched file against the diff, not only the lines it edits.

_Origin: every project under the kit held this rule in its own standards before the kit had house standards, after a stale invariant comment stood for weeks past its first counterexample (2026-10-30)._
