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

### deploy

```
sudo apps-machine deploy <name>
sudo apps-machine deploy sample
```

Puts the build of a registered app's default branch, as GitHub has it at that moment, in service. It takes the app's name and nothing else: there is no way to give it a branch, a commit or a directory, and the decision behind that is `docs/adr/0005`. It runs no checks of its own; it trusts the default branch.

Its steps, in this order every time. A step that fails ends the command with exit 1 and `error: the deploy stopped at <step>: <why>`, and no later step runs.

| Step | What it does |
| --- | --- |
| `dump` | Dumps the app's database to `/var/lib/apps-machine/backups/deploys/<name>/<time>.dump`, root's alone, and prints the path. |
| `fetch` | Clones the default branch with the app's deploy key into a checkout of root's, and reads the commit. |
| `config` | Reads the project config from that commit, not from the checkout's files, and checks its `deploy` section. A project with no project config, no `deploy` section or an invalid one is refused here, with what is wrong. |
| `release` | Makes the checkout the app's newest release and hands it to the app's user. |
| `setup`, `build` | Run the section's commands in the release, as the app's user, with the app's settings in their environment. |
| `stop` | Stops the app's service. Nothing before this step touches the running app. |
| `migrate` | Runs the section's `migrate`, the same way, if it has one. |
| `point`, `start` | Points the service at the new release and its `start` command, and starts it. |
| `health` | Asks the section's `healthPath` on its `port` at `127.0.0.1` until it answers with success. |
| `loopback` | Checks that the port is listened on at loopback and at no other address. |
| `serve` | Maps the app's Serve port to the section's `port`. |
| `prune` | Removes all but the three newest releases. |

It ends with `<name> is running <commit>.`

A release is a directory in `/var/lib/apps-machine/apps/<name>/releases/`, named for when its deploy began (UTC) and its commit: `20261121T143005Z-<commit>`. Beside it, `<that name>.json` is root's record of the `deploy` section it was deployed with. The release is a shallow clone, so a project's commands can ask git which commit they are building. Once it is the app's, root runs no git in it.

The dump has the time of its deploy's release in its name. It is in `pg_dump`'s custom format, for `pg_restore`. No command removes these dumps: clear old ones by hand.

The health check gives the app 90 seconds from its start. It asks again every second, gives each ask 30 seconds to be answered, and takes only a 2xx status as success: a redirect is not. The service restarts an app that exits, five seconds later, so an app that fails at start is tried again within the limit.

The loopback check is why an app's `start` command must listen on `127.0.0.1`: an app open on another address can be reached around Tailscale Serve, which is what knows who is asking. For the same reason a `deploy` section's `port` cannot be a Serve port of any app on the machine, where Tailscale itself listens, and such a section is refused at `config`.

The fetch accepts only the SSH host keys GitHub publishes, which the kit carries in `github-host-keys.mjs`, so the first fetch asks nothing and trusts nobody. If GitHub changes a key, a fetch fails until the kit has the new one and the setup script has been run again.

#### Rehearsing with the sample app

The kit is a project with an app of its own to deploy: `sample-app/`, which the `deploy` section of the kit's `devkit.json` runs. It counts its visits in a table that its one migration makes, and needs no packages. To rehearse on a machine, register the kit's own repository and deploy it:

```
sudo apps-machine register sample git@github.com:<owner>/<the kit's repository>.git 8443
sudo apps-machine deploy sample
curl http://127.0.0.1:4310/
```

The last line answers `The sample app at commit <commit>. Visits: 1.` Any commit merged to the kit's default branch gives the next deploy something new to switch to.

To make its health check fail on purpose, add `SAMPLE_HEALTH=fail` to its settings file and deploy: `/healthz` then answers 503 while `/` still answers and names its commit, so the deploy stops at `health`. Take the line out afterwards and restart the service.

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

### restore

```
sudo apps-machine restore <name> <file> [--settings]
sudo apps-machine restore sample sample-2026-11-20.tar
sudo apps-machine restore sample sample-2026-11-20.tar --settings
sudo apps-machine restore sample /var/lib/apps-machine/backups/deploys/sample/20261121T143005Z.dump
```

Puts an app's database back as it was. `<file>` is a decrypted bundle, or a database dump: the one a deploy took before it started, or the one an earlier restore took.

In this order it:

1. checks the file and the app, and refuses before anything is touched (below);
2. dumps the database as it is now and prints where;
3. stops the app's service;
4. drops the database, makes it again for the app's role alone, and reads the dump into it. Nothing of the database as it was survives: a table a later migration added is gone, which is what going back means;
5. with `--settings`, replaces the app's settings file with the bundle's. Without it the settings file is left as it is;
6. starts the service and asks the app's health path until it answers, as a deploy does.

A decrypted bundle is removed from the machine when the command ends, whether the restore worked, failed or was refused. A dump is left where it is: it is root's alone already, and it is still the way back.

#### Bringing a bundle to the machine

The machine cannot decrypt a bundle, so that happens on the device that holds the private key. Take the encrypted bundle from the storage onto that device (the last seven nights are also on the machine, in `/var/lib/apps-machine/backups/nightly/`), then:

```
age --decrypt --identity backup-key.txt --output sample-2026-11-20.tar sample-2026-11-20.tar.age
scp sample-2026-11-20.tar apps-machine.example:
ssh -t apps-machine.example sudo apps-machine restore sample sample-2026-11-20.tar
rm sample-2026-11-20.tar
```

The decrypted bundle holds the database and the production keys in the clear. The command removes the copy on the machine; the last line removes the one on the device.

#### What it refuses

Each of these ends with exit 1 before the service is stopped, with the database and the settings file as they were:

- an app that is not registered;
- a file that is neither a bundle nor a dump `pg_restore` can read, which is left where it is. A bundle that is still encrypted is told apart and the message says so;
- a bundle of another app, a bundle missing one of its three files, or one made in a format these commands do not read;
- a bundle whose dump `pg_restore` cannot read: one cut short, or made by a newer Postgres than the machine's;
- `--settings` with a dump, which holds no settings file;
- a database that cannot be dumped first.

#### Going back on a restore

The dump taken at the start is `/var/lib/apps-machine/backups/restores/<name>/<time>.dump`, root's alone, named for the time in UTC. The command prints it with the line that puts it back:

```
sudo apps-machine restore sample /var/lib/apps-machine/backups/restores/sample/20261121T143005Z.dump
```

With `--settings`, the settings file that was replaced is kept beside it as `<time>.env`; putting that back is `sudo install -m 600 <that file> /etc/apps-machine/settings/<name>.env`. Nothing removes these files, the seven-day rule included: remove them by hand once the restore is known to be right.

#### When it fails part-way

From the stop on, a failure leaves the service stopped: a restore whose database is half read, or whose app does not answer, is not left running on real data. The command says the service is stopped, names the step (`stop`, `database`, `settings`, `start` or `health`), and prints the dump taken at the start and the line that puts it back. It exits 1.

#### After a failed deploy

A deploy dumps the database before it changes anything and prints the dump's path. When a deploy's migration has left the database in a state the previous release cannot use, restoring that dump puts the data back to match the code the deploy went back to.

#### The settings file, and a machine built again

`--settings` is for when the settings themselves are lost or wrong: a machine built again, or a key in the file that the restored data was encrypted with. The bundle's file replaces the app's byte for byte, root's alone (mode 0600).

On a machine built again, `register` gave the app's role a new password, and the settings put back name the old one. So the command gives the role the password in the `DATABASE_URL` it has just put back. When that line is not one `register` wrote, it leaves the password alone and warns, without printing the value.

Building an app again from nothing is: the setup script, `register`, `restore --settings` with the last bundle, the new deploy key added on GitHub, then `deploy`. An app that has never been deployed has nothing to start: the restore says so, and the first deploy starts it on the restored data.

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
- `releases.mjs` fetches the default branch, names and lists an app's releases, records the `deploy` section each was deployed with, and prunes them. `github-host-keys.mjs` holds the host keys a fetch accepts.
- `health.mjs` asks an app's health path until it answers or the time limit passes, and `loopback.mjs` checks what a port is listened on at.
- `commands/deploy.mjs` is a list of named steps, `STEPS`, each a function of the world and the deploy so far. `deployPrograms` in the test helpers stands in for the programs a deploy runs.
