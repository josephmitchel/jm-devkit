# Domain docs

How the skills consume a project's domain documentation when exploring its code. Which layout a project uses is read from the project itself, never configured: look at its root.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the root, if it exists: the project has more than one context, and the map points at one `GLOSSARY.md` per context and says how they relate. Read each one relevant to the topic.
- Otherwise **`GLOSSARY.md`** at the root: the project's one glossary.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In a multi-context project, also check each context's own `docs/adr/` (where the map puts the context) for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context project (most projects):

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context project (presence of `GLOSSARY-MAP.md` at the root):

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the glossary of the context it belongs to. Don't drift to synonyms the glossary explicitly avoids. Contexts can share a word with different meanings, so in a multi-context project say which context you mean when it is not obvious.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
