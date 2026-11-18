# House rules

These hold in every project, whichever skill is running. They come from the devkit plugin; a project's `CLAUDE.md` adds only what is true of that project.

## Git

Agents own the git work for what they build. Put each piece of work on its own branch from the default branch, commit as it lands with a message that says what changed and why, push, and open the pull request with `gh pr create` once it is done and checked. Stage only your own files by path: changes already uncommitted in the checkout are someone else's, so carry them along untouched and never stash, reset, restore, `checkout --` or clean them. Never force-push or rewrite pushed history. Merging is the user's unless they ask.

## Comments

Avoid writing long comments in the code: anything worth knowing should be evident from the code itself. These repositories are authored and maintained by agents, so there is no need to optimise for human readers.

## Code intelligence

Prefer the language server over Grep, Glob and Read for code navigation:

- `goToDefinition` / `goToImplementation` to jump to source
- `findReferences` to see all usages across the codebase
- `workspaceSymbol` to find where something is defined
- `documentSymbol` to list all symbols in a file
- `hover` for type information without reading the file
- `incomingCalls` / `outgoingCalls` for the call hierarchy

Before renaming or changing a function signature, use `findReferences` to find every call site first. Use Grep and Glob only for text searches (comments, strings, config values) where the language server does not help.

After writing or editing code, check the language server's diagnostics before moving on and fix type errors or missing imports at once. A diagnostic in a file you did not edit may be stale: confirm it with the project's typecheck before acting on it.

## Closing tickets

A pull request body ends its summary with `Addresses #N` for every ticket behind the work (specs, tickets, code reviewer concerns), never `Closes`, `Fixes` or `Resolves`: the nightly judge closes them.
