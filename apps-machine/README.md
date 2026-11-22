# The apps machine

The owner's notes for building and running the apps machine: the machine that runs the real copies of his apps. Agents work on the development machine and have no account, key or route onto this one. Nothing here names an app, a repository or anything about the owner's network; those exist only on the machine.

## Building the machine

Start from a fresh Ubuntu Server LTS install (amd64) with an admin account. As that account, clone the kit and run the setup script from the checkout:

```
git clone <the kit's address> jm-devkit
sudo bash jm-devkit/vm/apps-machine-setup.sh
```

It installs Node, Postgres, Tailscale, git and the tools the backups use (`age` and `rclone`), makes `/etc/apps-machine` for root alone, and installs the `apps-machine` commands for root. It ends by running `apps-machine list`, which on a new machine prints `No app is registered.`

It installs no agent tooling and makes no user for agents and none for the code reviewer. It refuses to run without sudo, on anything but Ubuntu, from a copy of the script outside a checkout of the kit, and on the development machine.

Left to do by hand afterwards: join Tailscale with `sudo tailscale up --ssh`. The network's access rules and tags are set up outside the kit.

### Running it again

The script is safe to run again, and a second run changes nothing. To bring a change in the kit to the machine, update the checkout and run it again:

```
git -C jm-devkit pull
sudo bash jm-devkit/vm/apps-machine-setup.sh
```

The Node and Postgres versions, and the other steps this script shares with the development machine's, are in `vm/machine-steps.sh`.

### Where things are

| Path | What |
| --- | --- |
| `/usr/local/sbin/apps-machine` | The command, on root's path: a link into the copy below. |
| `/usr/local/lib/apps-machine/` | Root's copy of the commands and of the kit's project-config reader. The setup script replaces it from the checkout; nothing else writes there, and root never runs the commands from the checkout. |
| `/etc/apps-machine/` | The machine's settings, root's alone (mode 0700). |
| `/etc/apps-machine/apps/<name>.json` | One registration per app. |

## The commands

Every command is run by the owner with sudo: `sudo apps-machine <command>`. Run with no command, it lists them. A command exits 0 when done, 1 when it failed and 2 when its arguments were wrong.

### list

```
sudo apps-machine list
```

Prints the name of each app registered on the machine, one to a line, or `No app is registered.`

## The code

For whoever changes the commands. They are plain Node modules with no dependencies, tested with `node --test 'apps-machine/**/*.test.mjs'`, which CI runs as its own job.

- `apps-machine.mjs` is the entry point. Each command is a module in `commands/` exporting `usage`, `summary` and `command(args, { run, paths, out, err })`, which returns when done and throws to fail (a `UsageError` from `usage.mjs` for bad arguments). Adding a command is one line in `COMMANDS`.
- `run.mjs` is the one way a command starts a program, and the only module that may: a test fails if another one imports Node's process-starting modules. Tests pass a fake `run` instead.
- `paths.mjs` holds every path on the machine under one root, which tests point at a temp dir. A command takes its paths from there, never from a literal.
- `registry.mjs` reads the registrations.
- `install.mjs` makes root's copy. A kit file outside this directory that a command imports is added to its `KIT_FILES`, or the copy on the machine will not have it.
- `test-helpers.mjs` has the temp machine, the fake `run`, and `appsMachine(argv)`, which runs a whole command and gives back its exit code and output.
