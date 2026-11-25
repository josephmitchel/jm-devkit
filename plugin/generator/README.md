# The generator

`generate.mjs` turns a project's `devkit.json` into the complete set of kit-owned files, and removes the kit-owned files the kit has retired. It is the only thing that writes or removes a kit-owned file: install, sync and the session-start nudge all call it. It needs nothing but Node, and it is deterministic: the same `devkit.json` gives the same result, byte for byte, with no timestamps, and reordering keys in `devkit.json` changes nothing.

## What it owns

It writes no file today. The process module's only kit-owned file was the code reviewer's sweep workflow, and that is retired.

Nothing else in a project is the generator's: `devkit.json` itself and the project's coding standards are project-owned.

## Retired files

A retired file is a kit-owned file the kit no longer writes. The generator still knows its path: a project that still has it is behind, and writing removes it, whatever the file holds.

| Retired file | What removing it does |
| --- | --- |
| `.github/workflows/nightly-sweep.yml` | Lets the code reviewer on the development machine handle the project. The workflow was the three jobs that ran the code reviewer on GitHub Actions (`sweep`, `landed` and `review-now`), through an action the kit no longer has, so a copy left in a project cannot run. |

The code reviewer on the development machine leaves alone a project that still has the sweep workflow, so a project is never reviewed from two places. The path is exported as `SWEEP_WORKFLOW`, which is how the code reviewer tells such a project from one it handles. Every project has moved, so the next sync of a project that somehow still has one removes it.

## Varying the output

Only through `devkit.json`, as `../devkit.schema.json` defines it. A hand edit to a kit-owned file is drift: `--check` reports it and the next sync replaces it.

No field of `devkit.json` changes what is written today. `reviewer.env`, `reviewer.databases` and `nightly.checks` are read by the code reviewer itself, on the development machine. `sweep` and `reviewer.services` went with the workflow they described: a `devkit.json` that still has either is invalid, and the error says to remove it.

A variation `devkit.json` cannot express is a change to the schema and to this generator, made in the kit, never in a project.

## Running it

```sh
node plugin/generator/generate.mjs <projectDir>          # write every kit-owned file, remove every retired one
node plugin/generator/generate.mjs <projectDir> --check  # write and remove nothing; list what is behind
```

| Exit | Meaning |
| --- | --- |
| 0 | Written and removed, or with `--check`, the project is level: every kit-owned file is as generated and no retired file is left. |
| 1 | `--check` only: the files printed on stdout, one path per line, are behind. Each is missing, differs, or is retired and still there. |
| 2 | Nothing generated: no `devkit.json`, one that is not valid (each field at fault on stderr), or bad arguments. Nothing is written or removed. |

Writing prints `wrote <path>` for each file it writes and `removed <path>` for each retired file it removes; a level project prints nothing. With `--check`, stderr also has one line per retired file, `<path> is retired: <what removing it does>`.

`generate(config)` is the same thing as a pure function, a parsed `devkit.json` in and `{ path: contents }` out, with no entry for a retired file; it throws `DevkitConfigError` (with `errors`, one per field) on an invalid config. `RETIRED` maps each retired path to what removing it does, and `retiredFiles(projectDir)` gives the ones a project still has. The validation is `../devkit-config.mjs`, which the code reviewer uses too, so a config one accepts the other accepts.
