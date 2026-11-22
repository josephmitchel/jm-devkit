# The apps machine

The owner's notes for building and running the apps machine: the machine that runs the real copies of his apps. Agents work on the development machine and have no account, key or route onto this one. Nothing here names an app, a repository or anything about the owner's network; those exist only on the machine.

## Building the machine

Start from a fresh Ubuntu Server LTS install (amd64) with an admin account. As that account, clone the kit and run the setup script from the checkout:

```
git clone <the kit's address> jm-devkit
sudo bash jm-devkit/vm/apps-machine-setup.sh
```

It installs Node, Postgres, Tailscale, git and the tools the backups use (`age` and `rclone`), makes `/etc/apps-machine` and `/var/lib/apps-machine/backups` for root alone, and installs the `apps-machine` commands for root. It ends by running `apps-machine list`, which on a new machine prints `No app is registered.`

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
| `/etc/apps-machine/apps/<name>.json` | One registration per app: its name, repository and Serve port. |
| `/etc/apps-machine/settings/<name>.env` | An app's settings file, root's alone (mode 0600). |
| `/etc/apps-machine/keys/<name>` | The private half of an app's deploy key, root's alone. The public half is beside it, ending `.pub`. |
| `/etc/systemd/system/app-<name>.service` | An app's service. |
| `/var/lib/apps-machine/apps/<name>/` | An app's own directory, closed to every other app: `home/` is its Linux user's home, `releases/` holds its releases, and `current` links to the one its service runs. |
| `/var/lib/apps-machine/backups/` | Database dumps and backup bundles, root's alone (mode 0700). |

## The commands

Every command is run by the owner with sudo: `sudo apps-machine <command>`. Run with no command, it lists them. A command exits 0 when done, 1 when it failed and 2 when its arguments were wrong.

### list

```
sudo apps-machine list
```

Prints each app registered on the machine with its repository, its Serve port and whether it has been deployed, or `No app is registered.`

```
APP     REPOSITORY                         SERVE PORT  DEPLOYED
sample  git@github.com:example/sample.git  8443        no
```

### register

```
sudo apps-machine register <name> <repository> <serve-port>
sudo apps-machine register sample git@github.com:example/sample.git 8443
```

Gives an app everything it needs before its first deploy. Register a project only once the kit's install reports its merge rule in place: a deploy trusts the default branch and runs no checks of its own.

- `<name>` names the app's Linux user, its Postgres role and its database: a lowercase letter, then lowercase letters, digits or underscores, 31 characters at most. A name the machine or Postgres already uses for something else is refused.
- `<repository>` is the project's GitHub SSH address, `git@github.com:<owner>/<name>.git`.
- `<serve-port>` is the port the app is reached on at the machine's Tailscale address. A port another app has is refused.

Afterwards the app has:

- a Linux user of its own, with no shell, no password and no group but its own. Its directory under `/var/lib/apps-machine/apps/` lets in root and that user and nobody else;
- a Postgres role and a database, both of its name. No other role may open the database;
- a settings file that only root can read, holding its `DATABASE_URL`. The app's user cannot read the file: the service and each step of a deploy are handed its values in their environment;
- a deploy key for its repository. The command prints the public half and never the private half;
- a service, `app-<name>.service`, which starts at boot once there is a release to run. It runs the current release's start command as the app's user, restarts it when it exits, and writes to the journal.

It ends by saying what is left to do: add the public key to the repository on GitHub as a deploy key without write access, add the app's other settings to its settings file, and deploy. The Serve mapping is made by the first deploy, which is when the app's local port is known.

The settings file is `NAME=value` lines, read by systemd and by the commands alike. A value that holds a quote, a backslash or more than one line goes in quotes; a command that cannot read a line says which line, without printing it. A change to the file reaches the app the next time its service starts: at the next deploy, or with `sudo systemctl restart app-<name>.service`.

Running the command again with the same arguments changes nothing: no new key, no new password, no rewritten settings file. It prints the public key and the steps again, and it finishes a registration that stopped part-way. An app that is already registered is refused another repository or Serve port; its registration is the file in `/etc/apps-machine/apps/`.

### backup

```
sudo apps-machine backup
```

Makes the night's bundle of every registered app. A timer runs it each night; the owner can run it by hand at any time.

For each app it dumps the database, copies the settings file as it is, puts the two in one bundle with a note of the app and the date, and encrypts the bundle with `age` to the owner's public key. The bundle is `/var/lib/apps-machine/backups/nightly/<name>-<YYYY-MM-DD>.tar.age`, root's alone (mode 0600). The date is the machine's local date, and a second run on the same date replaces that date's bundle.

The private key is never on the machine, so the machine can make a bundle and cannot open one.

- Everything unencrypted is written in the run's own directory under `/var/lib/apps-machine/backups/work/`, which is removed when the run ends, including when it fails. What a run that was killed left there is removed by the next run.
- One app failing does not stop the others. The run prints what went wrong for that app, makes the other bundles, and exits 1 naming every app that has no bundle for the night.
- Seven days of bundles are kept. Once an app has its bundle for the night, its bundles dated before the seven days ending today are removed. An app whose bundle was not made keeps the ones it has.

#### The public key

Make the key pair on a device of the owner's own, never on this machine or the development machine:

```
age-keygen -o backup-key.txt
```

It prints the public key, which starts `age1`. The file holds the private half: it stays on that device, with a copy somewhere safe, because no bundle can be opened without it. Give the public key to the setup script on the apps machine:

```
sudo BACKUP_PUBLIC_KEY=age1... bash jm-devkit/vm/apps-machine-setup.sh
```

The script checks that `age` can encrypt to it, writes it to `/etc/apps-machine/backup-public-key`, and turns the timer on. A later run without the setting keeps the key; a run with another key replaces it, and bundles made before then still open only with the first private key. The file is one that `age` reads recipients from: a public key per line, and lines starting `#` are comments.

Until a public key is set the setup script does not turn the timer on, and the command refuses to run. Each says so and says how to set one.

#### The timer

`apps-machine-backup.timer` starts `apps-machine-backup.service` at 03:00 in the machine's time zone. A night missed because the machine was off runs when the machine is next up.

```
systemctl list-timers apps-machine-backup.timer
journalctl -u apps-machine-backup.service
```

For another time of night, `sudo systemctl edit apps-machine-backup.timer` and give `OnCalendar=` twice, first empty and then with the time. The setup script leaves that file alone.

#### Opening a bundle

On the device that has the private key:

```
age --decrypt --identity backup-key.txt --output sample-2026-11-21.tar sample-2026-11-21.tar.age
tar --list --file sample-2026-11-21.tar
```

A decrypted bundle is a tar archive of three files: `bundle.json` (the app and the date), `database.dump` (in `pg_dump`'s custom format, which `pg_restore` reads) and `settings.env` (the settings file as it was).

### logs

```
sudo apps-machine logs <name> [<period>]
sudo apps-machine logs sample
sudo apps-machine logs sample 6h
```

Prints the journal of the app's service, `app-<name>.service`, oldest first: the last day, or the period given, which is a whole number and `min`, `h`, `d` or `w` (`30min`, `6h`, `3d`, `2w`). That is what the app wrote to its output and systemd's own lines about starting and stopping it. Nothing else goes to standard output: no heading, no other app's lines, and nothing read from the settings file. A period in which the service wrote nothing prints nothing. An app that is not registered is refused on standard error.

To put an app's recent log on the development machine, the owner runs one line on his own device, which can reach both machines:

```
ssh apps-machine.example sudo apps-machine logs sample | ssh development-machine.example 'cat > sample.log'
```

The log passes through his device, so neither machine connects to the other and nothing on the development machine can ask for it. Name a file the agent can read. A failure is printed on his own screen and not into the file.

That line has no terminal for `sudo` to ask for a password on, so it works only where `sudo` lets the owner's account run this command without one. Adding `-t` to `ssh` is not the way round it: the prompt and a terminal's line endings would go into the file. One way is a rule for this command alone, made on the apps machine with `sudo visudo -f /etc/sudoers.d/apps-machine-logs`:

```
<account> ALL=(root) NOPASSWD: /usr/local/sbin/apps-machine logs *
```

## The code

For whoever changes the commands. They are plain Node modules with no dependencies, tested with `node --test 'apps-machine/**/*.test.mjs'`, which CI runs as its own job.

- `apps-machine.mjs` is the entry point. Each command is a module in `commands/` exporting `usage`, `summary` and `command(args, { run, paths, out, err })`, which returns when done and throws to fail (a `UsageError` from `usage.mjs` for bad arguments). Adding a command is one line in `COMMANDS`.
- `run.mjs` is the one way a command starts a program, and the only module that may: a test fails if another one imports Node's process-starting modules. Tests pass a fake `run` instead.
- `paths.mjs` holds every path on the machine under one root, which tests point at a temp dir. A command takes its paths from there, never from a literal.
- `registry.mjs` reads and writes the registrations, and is where a name, a repository and a Serve port are checked.
- `settings.mjs` reads an app's settings file, and runs a command as the app's user with those values in its environment.
- `database.mjs` makes an app's role and database, and dumps the database to a file.
- `service.mjs` writes an app's unit from `app.service.template`, stops and starts the service, and points it at a release.
- `serve.mjs` maps an app's Serve port to its local port.
- `app-user.mjs` makes an app's Linux user and the directories it may enter.
- `install.mjs` makes root's copy: this directory's modules and templates. A kit file outside this directory that a command imports is added to its `KIT_FILES`, or the copy on the machine will not have it.
- `test-helpers.mjs` has the temp machine, the fake `run`, `registered(paths, { name })`, which registers an app there as the command does, and `appsMachine(argv)`, which runs a whole command and gives back its exit code and output.
