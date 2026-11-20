# The generator

`generate.mjs` turns a project's `devkit.json` into the complete set of kit-owned files. It is the only thing that writes a kit-owned file: install, sync and the session-start nudge all call it. It needs nothing but Node, and it is deterministic: the same `devkit.json` gives byte-identical files, with no timestamps, and reordering keys in `devkit.json` changes nothing.

## What it owns

| File | From |
| --- | --- |
| `.github/workflows/nightly-sweep.yml` | The code reviewer's workflow: the `sweep` job the Worker dispatches each night, the `landed` job on every merge, and the `review-now` job for an on-demand per-PR review. Each uses `josephmitchel/jm-devkit/reviewer@main`. |

Each file starts with a comment saying it is generated and that changes go in `devkit.json`. Nothing else in a project is the generator's: `devkit.json` itself and the project's coding standards are project-owned.

## Varying the output

Only through `devkit.json`, as `../devkit.schema.json` defines it. A hand edit to a kit-owned file is drift: `--check` reports it and the next sync replaces it.

- `reviewer.services` is a GitHub Actions `services:` map. It is written onto the jobs that run the project's tests (`sweep` and `review-now`), never onto `landed`. It is retired: the workflow is the only thing that still reads it.
- `reviewer.env` and `reviewer.databases` are not written into the workflow: the code reviewer applies them to the project's commands itself.
- `nightly.checks` is not written into the workflow either: only a code reviewer that runs on the owner's machine runs a project's nightly checks.
- `sweep` is optional and retired, and nothing is generated from it. A project still on GitHub Actions keeps its `sweep.hour` for install's search for a free hour.

A variation `devkit.json` cannot express is a change to the schema and to this generator, made in the kit, never in a project.

## Running it

```sh
node plugin/generator/generate.mjs <projectDir>          # write every kit-owned file
node plugin/generator/generate.mjs <projectDir> --check  # write nothing; list what is behind
```

| Exit | Meaning |
| --- | --- |
| 0 | Written, or with `--check`, every kit-owned file is level. |
| 1 | `--check` only: the files printed on stdout, one path per line, are missing or differ. |
| 2 | Nothing generated: no `devkit.json`, one that is not valid (each field at fault on stderr), or bad arguments. |

`generate(config)` is the same thing as a pure function, a parsed `devkit.json` in and `{ path: contents }` out; it throws `DevkitConfigError` (with `errors`, one per field) on an invalid config. The validation is `../devkit-config.mjs`, which the code reviewer uses too, so a config one accepts the other accepts.
