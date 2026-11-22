# The apps machine

The owner's notes for building and running the apps machine: the machine that runs the real copies of his apps. Agents work on the development machine and have no account, key or route onto this one. Nothing here names an app, a repository or anything about the owner's network; those exist only on the machine.

## Building the machine

Start from a fresh Ubuntu Server LTS install (amd64) with an admin account. As that account, clone the kit and run the setup script from the checkout:

```
git clone <the kit's address> jm-devkit
sudo bash jm-devkit/vm/apps-machine-setup.sh
```

It installs Node, Postgres, Tailscale, git and the tools the backups use (`age` and `rclone`), makes `/etc/apps-machine` and `/var/lib/apps-machine/backups` for root alone, installs the `apps-machine` commands for root, and lets the admin account that ran it run `apps-machine logs` without a password ("The sudo rule" under `logs`). It ends by running `apps-machine list`, which on a new machine prints `No app is registered.`

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
| `/etc/apps-machine/github-host-keys` | The SSH host keys a fetch accepts from GitHub, written from the kit at each deploy. |
| `/etc/apps-machine/backup-public-key` | The owner's public key, which every backup bundle is encrypted to. The setup script writes it. |
| `/etc/apps-machine/backup-storage`, `rclone.conf` | Where the bundles are uploaded, and the `rclone` config that defines that remote and holds its credential. Written by hand, root's alone (mode 0600). |
| `/etc/apps-machine/backup-alive-address` | The address requested after a night in which nothing went wrong. Written by hand, root's alone (mode 0600). |
| `/etc/systemd/system/app-<name>.service` | An app's service. |
| `/var/lib/apps-machine/apps/<name>/` | An app's own directory, closed to every other app: `home/` is its Linux user's home, `releases/` holds its releases, and `current` links to the one its service runs. |
| `/var/lib/apps-machine/backups/` | Database dumps and backup bundles, root's alone (mode 0700). |
| `/var/lib/apps-machine/backups/nightly/` | The nights' encrypted bundles, `<name>-<date>.tar.age`. The backup removes an app's after seven days. |
| `/var/lib/apps-machine/backups/work/` | A directory per backup run or restore for what is unencrypted on the way, removed when the run ends. Empty between runs. |
| `/var/lib/apps-machine/backups/deploys/<name>/` | The dump each deploy of an app took before it changed anything, as `<time>.dump`. The backup removes them after thirty days, but for the newest. |
| `/var/lib/apps-machine/backups/restores/<name>/` | What each restore of an app replaced: the database as `<time>.dump`, and the settings file as `<time>.env` when `--settings` replaced it. The backup removes them after thirty days, but for the newest. |
| `/etc/sudoers.d/apps-machine-logs` | The rule that lets the admin account run `apps-machine logs` without a password. The setup script writes it. |

## The commands

Every command is run by the owner with sudo: `sudo apps-machine <command>`. Run with no command, it lists them. A command exits 0 when done, 1 when it failed and 2 when its arguments were wrong.

A command that is interrupted, by Ctrl-C, a session that dropped or a shutdown, is not killed where it stands. The program it was waiting for ends, the command cleans up as it does when that step fails, and it exits 1 with `interrupted by <signal>`. A second interrupt while it cleans up ends the cleaning up. A signal sent to the command's own process and nothing else (`kill <pid>`) does not stop it: interrupt it from its terminal.

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

- `<name>` names the app's Linux user, its Postgres role and its database: a lowercase letter, then lowercase letters, digits or underscores, 31 characters at most, and not starting `pg_`, which Postgres keeps for itself. A name the machine or Postgres already uses for something else is refused.
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

Its steps, in this order every time. A step that fails ends the command with exit 1 and `error: the deploy stopped at <step>: <why>`, and no later step runs. What the command leaves behind then is under "When a deploy fails".

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
| `loopback` | Checks that the app's user, and nobody else, listens on the port, and that the app's user listens at loopback and at no other address, on that port or any other. |
| `serve` | Maps the app's Serve port to the section's `port`. |
| `prune` | Removes all but the three newest releases. |

It ends with `<name> is running <commit>.`

A release is a directory in `/var/lib/apps-machine/apps/<name>/releases/`, named for when its deploy began (UTC) and its commit: `20261121T143005Z-<commit>`. Beside it, `<that name>.json` is root's record of the `deploy` section it was deployed with. The release is a shallow clone, so a project's commands can ask git which commit they are building. Once it is the app's, root runs no git in it.

The dump has the time of its deploy's release in its name. It is in `pg_dump`'s custom format, for `pg_restore`. The nightly backup removes these dumps once they are thirty days old, always leaving the newest: the rule is "What a deploy or a restore kept" under `backup`.

The health check gives the app 90 seconds from its start. It asks again every second, gives each ask 30 seconds to be answered, and takes only a 2xx status as success: a redirect is not. The service restarts an app that exits, five seconds later, so an app that fails at start is tried again within the limit.

The loopback check is why an app's `start` command must listen on `127.0.0.1`: an app open on another address can be reached around Tailscale Serve, which is what knows who is asking. It looks at every TCP port the app's Linux user listens on once the app has answered, not only the section's `port`, so a second listener the app opens elsewhere is refused too. It also refuses a `port` that another user of the machine listens on: two apps given the same `port` would otherwise have the first answer for the second. For the same reason a `deploy` section's `port` cannot be a Serve port of any app on the machine, where Tailscale itself listens, and such a section is refused at `config`.

The fetch accepts only the SSH host keys GitHub publishes, which the kit carries in `github-host-keys.mjs`, so the first fetch asks nothing and trusts nobody. If GitHub changes a key, a fetch fails until the kit has the new one and the setup script has been run again.

#### When a deploy fails

What a failed step leaves depends on where it is in the order. Everything the command says from the failure on goes to standard error, and its last line is the `error:` line naming the step.

| The step that failed | What the command leaves |
| --- | --- |
| `dump`, `fetch`, `config`, `release`, `setup`, `build` | Nothing was stopped: the service is as it was, on the release it was on. The release that was being made is removed. |
| `stop`, `migrate`, `point`, `start`, `health`, `loopback` | The previous release is put back: the service is stopped, pointed at the release and the start command it had before the deploy, and started. The failed release is removed. |
| `serve`, `prune` | The new release stays in service, because it had passed its checks. The exit is still 1, and the next deploy does again what failed. |

A first deploy has no previous release. If it fails in the second row, the service is left stopped and pointing at no release, and the command says there was nothing to go back to.

Going back puts the code back, not the data. The database is left as the deploy left it, which after a failed `migrate` can be part of the way through one. The command prints the dump it took at its start and the command that restores it, and the owner decides whether to run it:

```
sudo apps-machine restore <name> /var/lib/apps-machine/backups/deploys/<name>/<time>.dump
```

After starting the previous release, the command asks that release's health path, with the same limit, and says whether it answered. A previous release that does not answer on the database as it now is, is the case for the restore. The Serve mapping needs no going back: `serve` runs only after the checks, so the mapping still goes to the previous release's port.

If going back cannot be finished, because the service will not stop or start, the command says so and says which release the service points at. It removes the failed release unless the service still points at it.

#### When the service stops

A stop is the same whoever asks for it, the `stop` step, `sudo systemctl restart app-<name>.service` or a shutdown: systemd sends SIGTERM to the app's processes and waits for them to end. An app that answers by exiting 143, which is 128 plus the signal's number and what many servers do, has stopped cleanly: the service ends `inactive`, not `failed`, and the journal records no failure. The unit's `SuccessExitStatus=143` says so, and 143 is the only status it adds.

A crash is still a failure and is still restarted. Any other non-zero status is a failure, and whatever the status, an app that exits when nobody asked systemd to stop it is started again five seconds later. A 143 that nobody asked for is among those: it is restarted and the journal has `Scheduled restart job`, but systemd does not call it a failure, because a unit cannot say that a status is clean only during a stop.

The status systemd judges is the one the service's main process ends with, and that process is the `sh` that runs the `start` command. When `start` begins with `exec`, the app takes the shell's place and its status is the service's. Without `exec` the shell is the main process: the stop's SIGTERM ends it, which systemd takes as clean whatever the app then exits with, and when the app exits on its own the shell passes its status on.

A change to `app.service.template` reaches an app that is already registered at its next deploy, with no need to register it again: once the setup script has replaced root's copy, `point` writes the unit again because it differs from the template and has systemd read its units again, so `start` runs the app under the new unit. The `stop` of that one deploy is still judged by the old unit.

#### Rehearsing with the sample app

The kit is a project with an app of its own to deploy: `sample-app/`, which the `deploy` section of the kit's `devkit.json` runs. It counts its visits in a table that its one migration makes, and needs no packages. To rehearse on a machine, register the kit's own repository and deploy it:

```
sudo apps-machine register sample git@github.com:<owner>/<the kit's repository>.git 8443
sudo apps-machine deploy sample
curl http://127.0.0.1:4310/
```

The last line answers `The sample app at commit <commit>. Visits: 1.` Any commit merged to the kit's default branch gives the next deploy something new to switch to.

To make its health check fail on purpose, add `SAMPLE_HEALTH=fail` to its settings file and deploy: `/healthz` then answers 503 while `/` still answers and names its commit, so the deploy stops at `health` after 90 seconds and puts the previous release back. The setting is still on when that release starts, so its `/healthz` fails as well: the command waits another 90 seconds and says the previous release was started but did not answer. `curl http://127.0.0.1:4310/` then names the previous commit, and `ls /var/lib/apps-machine/apps/sample/releases/` shows the failed release gone. Take the line out afterwards and restart the service with `sudo systemctl restart app-sample.service`.

To rehearse a stop, the sample app answers SIGTERM as "When the service stops" describes: it finishes the answers it owes, takes no more and exits 143, and its `start` command begins with `exec`, so that status is the service's.

```
sudo systemctl stop app-sample.service
systemctl is-active app-sample.service
sudo apps-machine logs sample 5min
sudo systemctl start app-sample.service
```

The second line answers `inactive`, where a unit without `SuccessExitStatus=143` answers `failed`, and the log has `Stopped` with no `Failed with result 'exit-code'` before it.

### backup

```
sudo apps-machine backup
```

Makes the night's bundle of every registered app, uploads each bundle to the owner's storage, and, when nothing went wrong, makes the alive request. A timer runs it each night; the owner can run it by hand at any time.

For each app it dumps the database, copies the settings file as it is, puts the two in one bundle with a note of the app and the date, and encrypts the bundle with `age` to the owner's public key. The bundle is `/var/lib/apps-machine/backups/nightly/<name>-<YYYY-MM-DD>.tar.age`, root's alone (mode 0600). The date is the machine's local date, and a second run on the same date replaces that date's bundle.

The private key is never on the machine, so the machine can make a bundle and cannot open one.

- Everything unencrypted is written in the run's own directory under `/var/lib/apps-machine/backups/work/`, which is removed when the run ends, including when it fails. What a run that was killed left there is removed by the next run.
- One app failing does not stop the others. The run prints what went wrong for that app, makes the other bundles, and exits 1 naming every app that has no bundle for the night.
- Seven days of bundles are kept. Once an app has its bundle for the night, its bundles dated before the seven days ending today are removed. An app whose bundle was not made keeps the ones it has.
- Each bundle made is then uploaded to the storage under its own name. One that does not upload does not stop the others: the run prints what `rclone` said, and exits 1 naming every app whose bundle is not on the storage.
- A bundle that did not upload is uploaded by a later night, for as long as the machine has it: its seven days. After the night's own bundles the run lists the storage, once, and uploads every other bundle on the machine whose name the storage does not have, printing `<name>: uploaded <bundle>, which the storage did not have`. A bundle the storage has is not uploaded again, and one the storage's own rule would remove at once ("What is kept", below) is not uploaded.
- This goes by what is on the machine, not by the registrations: a bundle of an app that is no longer registered is uploaded too, and so is an earlier bundle of an app that has none tonight.
- An earlier bundle that still does not upload does not stop the others either: the run exits 1 naming the app and the bundle's date. If the storage cannot be listed, only the night's own bundles are uploaded, and the run says so and exits 1.
- What the deploys and the restores of each registered app kept is removed after thirty days ("What a deploy or a restore kept", below).
- The alive request is made last, once, and only by a night in which nothing went wrong. Its absence is the alarm.

#### The storage

Where the bundles go is set by hand in two files only root can read. Neither value is ever given on a command line, the setup script's included: `sudo` logs its command line.

```
sudo rclone config --config /etc/apps-machine/rclone.conf
sudoedit /etc/apps-machine/backup-storage
```

The first defines a remote: `rclone` asks for the kind of storage and its credential, and keeps both in that file. The second holds one line, `<remote>:<folder>`, naming that remote and the folder in it the bundles go to; lines starting `#` are comments. Then run `sudo apps-machine backup` and look for the bundles:

```
sudo rclone lsf --config /etc/apps-machine/rclone.conf <remote>:<folder>
```

The command never reads the credential. It gives `rclone` the path of the config file and the destination, and nothing else. The destination must name a remote from the config file: one that spells a remote out with its own settings, which `rclone` also accepts, is refused, because the credential would then be in a program's arguments, and every user on the machine can read those. `rclone` only obscures what it keeps in its config file, so the file's mode (0600, in a directory of root's alone) is what protects the credential.

Until both files are there the run makes the bundles, keeps them on the machine, says uploads are not set up and exits 1. The first run after that uploads the ones the machine still has. A bundle that is uploaded replaces one of the same name, and `rclone` compares checksums after the transfer where the storage has them.

Ubuntu's `rclone` is older than `rclone`'s own releases. A storage it does not know needs `rclone`'s own package in its place.

##### The credential

Give the machine a credential of its own, confined to that one folder where the storage provider allows it. It needs to list, read, write and delete there, and nothing anywhere else. What can be had depends on the kind of storage:

- Object storage whose keys can be limited to one bucket, or to a prefix in one: a bucket for the backups alone, and a key that can do those four things in it and nothing else. A key that may not create buckets needs `no_check_bucket` set on the remote.
- A machine of the owner's reached over SFTP: an account for the apps machine alone, entered by a key, and confined by the SSH server to one directory.
- A drive entered by signing in through a browser: some let an application be limited to a folder of its own or to the files it made, and that limit is the one to choose. Where signing in gives the whole drive, the credential reaches every file in the account, so use an account that holds nothing but the backups.

Two things are left exposed whatever the provider. The credential can delete, because pruning needs it to, so whoever takes over the machine can remove or overwrite the bundles on the storage: where the provider can keep removed and overwritten files for a time, set that from the owner's own account, which the machine's credential cannot change. And they can see each bundle's name, date and size. They cannot read a bundle, on the storage or on the machine: the private key is on neither.

##### What is kept

On the storage each app keeps the bundles of the thirty days ending today, and the first bundle of each of the twelve months ending with this one. A month's first bundle is the earliest it has, so a month whose first night was missed still keeps one. The rest are removed, and the run prints each removal.

As on the machine, an app's old bundles go only once tonight's is on the storage. An app that is no longer registered keeps what it has there, and nothing in the folder that is not a bundle is touched. If the storage cannot be listed or a bundle cannot be removed, the run says so and exits 1.

#### What a deploy or a restore kept

A deploy dumps the database before it changes anything, into `/var/lib/apps-machine/backups/deploys/<name>/`, and a restore keeps what it replaced in `/var/lib/apps-machine/backups/restores/<name>/`. Each night's run, after the uploads, removes from both directories of every registered app what was kept before the thirty days ending today, and prints each file it removes.

- The newest in each directory always stays, however old: an app deployed once a year still has the dump of its last deploy.
- A restore's dump and the settings file kept with it, `<time>.dump` and `<time>.env`, are one thing: they stay or go together.
- It runs for every registered app, whether or not the app has a bundle tonight and whether or not uploads are set up. These files are not copies of the night's bundle, so a night that failed has no reason to hold them.
- Only files these commands name are removed: `<time>.dump` in the first directory, and `<time>.dump` and `<time>.env` in the second, with the `<time>-2` a second restore in one second is named. Anything else there is left alone, as are the directories of an app that is no longer registered.
- A file that cannot be removed fails the run: it exits 1 with what the system said, and makes no alive request. The night's bundles are made and uploaded before this.

A file's age is the time in its name, taken as the machine's local date, as the bundles' dates are.

#### The alive request

A machine that is off or broken cannot report its own failure, so a missed night is noticed from outside: after a night in which nothing went wrong, the run requests an address once, and a service that expects that request each day tells the owner when it has not come.

```
sudoedit /etc/apps-machine/backup-alive-address
```

The file holds one line, the `https` address the service gave for this check; lines starting `#` are comments. The service must:

- give an address of its own for one check, which a plain `GET` satisfies;
- be told how often to expect the request and how long to wait past that: every day, and a few hours' grace for the length of the run and for a night caught up after the machine was off;
- tell the owner by a way that reaches him off the machine, such as mail or a notification on his phone, when the request is overdue;
- run somewhere that does not go down with the owner's machines.

The request is not made when an app has no bundle for the night, when a bundle did not upload, tonight's or an earlier night's, when uploads are not set up, when the storage could not be listed or pruned, or when something a deploy or a restore kept could not be removed. So an alert means: read `journalctl -u apps-machine-backup.service`. With no app registered there is nothing to back up, and the request is made.

With no address set the backup runs, warns that nothing is watching it and exits 0. If the request itself fails, the run exits 1 and says so.

Anyone who has the address can make the request and keep the alarm quiet, so it is kept as the credential is: in a file of root's, given to `curl` on its input and never as an argument, and printed nowhere. What `curl` says is not printed either, since its messages name the address's host; a failed request is reported by `curl`'s exit code, which `man curl` explains.

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

That line has no terminal for `sudo` to ask for a password on, so it works only where `sudo` lets the owner's account run this command without one. Adding `-t` to `ssh` is not the way round it: the prompt and a terminal's line endings would go into the file.

#### The sudo rule

The setup script installs a rule for this command alone, as `/etc/sudoers.d/apps-machine-logs`, root's and mode 0440:

```
<account> ALL=(root) NOPASSWD: /usr/local/sbin/apps-machine logs *
```

`<account>` is the admin account that ran the setup script with sudo, and no other: a run from a second account replaces the rule with one for that account. A run as root itself, with no account behind it, installs no rule, leaves one that is there as it is, and says so when it ends; so does a run from an account whose name is anything but lowercase letters, digits, `_` and `-`, which `sudo` could read as more than one account. The script has `visudo` check the rule before it is put in place, and a later run changes nothing when the file is already right.

The rule lets that account run `logs`, with any arguments, and nothing else of `apps-machine`: `sudo` lets through only a command line whose arguments begin with `logs`, and `apps-machine` runs a command only by its exact name. `logs` itself takes a registered app's name and a period, and refuses anything else before it reads the journal. Every other command still asks for the password.

To take the rule away, `sudo rm /etc/sudoers.d/apps-machine-logs`. The next run of the setup script with sudo from an admin account installs it again.

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
2. stops the app's service;
3. dumps the database as it is now and prints where. The service is stopped first so that nothing the app writes falls between the dump and the restore;
4. drops the database, makes it again for the app's role alone, and reads the dump into it. Nothing of the database as it was survives: a table a later migration added is gone, which is what going back means;
5. with `--settings`, replaces the app's settings file with the bundle's. Without it the settings file is left as it is;
6. starts the service and asks the app's health path until it answers, as a deploy does: the port and the path are the ones the running release was deployed with, and the app has 90 seconds.

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
- a bundle whose dump `pg_restore` cannot list: one that is not a dump, or one made by a newer Postgres than the machine's;
- `--settings` with a dump, which holds no settings file;
- a running release with no record of the deploy section it was deployed with, so there is nowhere to ask whether the app answers.

Wrong arguments end with exit 2 and the usage line, and remove nothing. Which argument was the bundle is then a guess, so the error names each file it was given that is still on the machine: a decrypted bundle left there is unencrypted until the owner removes it.

#### Going back on a restore

The dump taken before the database is replaced is `/var/lib/apps-machine/backups/restores/<name>/<time>.dump`, root's alone, named for the time in UTC. The command prints it with the line that puts it back:

```
sudo apps-machine restore sample /var/lib/apps-machine/backups/restores/sample/20261121T143005Z.dump
```

With `--settings`, the settings file that was replaced is kept beside it as `<time>.env`; putting that back is `sudo install -m 600 <that file> /etc/apps-machine/settings/<name>.env`. The nightly backup removes what a restore kept once it is thirty days old, a dump and its settings file together, always leaving the newest: the rule is "What a deploy or a restore kept" under `backup`.

#### When it fails part-way

The command names the step it stopped at and exits 1.

- At `stop` or `dump`, nothing was replaced: the command starts the service again and says so.
- At `database`, `settings`, `start` or `health`, it leaves the service stopped: a restore whose database is half read, or whose app does not answer, is not left running on real data. It says the service is stopped, and prints the dump it took and the line that puts it back.

#### After a failed deploy

A deploy dumps the database before it changes anything and prints the dump's path. When a deploy's migration has left the database in a state the previous release cannot use, restoring that dump puts the data back to match the code the deploy went back to.

#### The settings file, and a machine built again

`--settings` is for when the settings themselves are lost or wrong: a machine built again, or a key in the file that the restored data was encrypted with. The bundle's file replaces the app's byte for byte, root's alone (mode 0600).

On a machine built again, `register` gave the app's role a new password, and the settings put back name the old one. So the command gives the role the password in the `DATABASE_URL` it has just put back. When that line is not one `register` wrote, it leaves the password alone and warns, without printing the value.

Building an app again from nothing is: the setup script, `register`, `restore --settings` with the last bundle, the new deploy key added on GitHub, then `deploy`. An app whose service points at no release, because it has never been deployed or its first deploy failed, has nothing to start: the restore says so, and the next deploy starts it on the restored data.

## The code

For whoever changes the commands. They are plain Node modules with no dependencies, tested with `node --test 'apps-machine/**/*.test.mjs'`, which CI runs as its own job.

- `apps-machine.mjs` is the entry point. Each command is a module in `commands/` exporting `usage`, `summary` and `command(args, { run, paths, out, err, now })`, which returns when done and throws to fail (a `UsageError` from `usage.mjs` for bad arguments). Adding a command is one line in `COMMANDS`.
- `run.mjs` is the one way a command starts a program, and the only module that may: a test fails if another one imports Node's process-starting modules. Tests pass a fake `run` instead. Its `must(done, failure)` is the one wording of a program that had to exit 0 and did not. It throws `Interrupted`, once, for a program that SIGINT, SIGTERM or SIGHUP ended; the entry point keeps the process alive through those signals, so a command's `finally` and its failure handling run. Code that catches an error and goes on to the next app rethrows an `Interrupted`.
- `paths.mjs` holds every path on the machine under one root, which tests point at a temp dir. A command takes its paths from there, never from a literal.
- `files.mjs` is how root's files are written (beside the file and renamed in, with the mode set whatever the umask), how a directory is closed to everyone but root, and how the files the owner writes by hand are read: the lines that are neither blank nor `#` comments.
- `registry.mjs` reads and writes the registrations, and is where a name, a repository and a Serve port are checked.
- `settings.mjs` reads an app's settings file, and runs a command as the app's user with those values in its environment.
- `database.mjs` makes an app's role and database, dumps the database to a file, says whether a file is a dump `pg_restore` can read, and puts a dump back in place of the database.
- `service.mjs` writes an app's unit from `app.service.template`, stops and starts the service, and points it at a release. Pointing writes the unit again when it differs from the template and then runs `systemctl daemon-reload`, which is how a change to the template reaches the apps already registered.
- `serve.mjs` maps an app's Serve port to its local port.
- `app-user.mjs` makes an app's Linux user and the directories it may enter.
- `install.mjs` makes root's copy: this directory's modules and templates. A kit file outside this directory that a command imports is added to its `KIT_FILES`, or the copy on the machine will not have it.
- `test-helpers.mjs` has the temp machine, the fake `run`, `registered(paths, { name })`, which registers an app there as the command does, and `appsMachine(argv)`, which runs a whole command and gives back its exit code and output.
- `releases.mjs` fetches the default branch, names and lists an app's releases, records the `deploy` section each was deployed with, and prunes them. `github-host-keys.mjs` holds the host keys a fetch accepts.
- `health.mjs` asks an app's health path until it answers or the time limit passes, and `loopback.mjs` checks who listens on an app's port and where the app's user listens.
- `vm/verify-units.sh` puts the backup's service and timer, and an app's service as `service.mjs` writes it, through `systemd-analyze verify`. CI runs it, and it runs anywhere systemd is, without sudo.
- `commands/deploy.mjs` is a list of named steps, `STEPS`, each a function of the world and the deploy so far, with what the command does when that step fails. `deployPrograms` in the test helpers stands in for the programs a deploy runs. A test holds the two tables under "deploy" above to `STEPS`.
- `bundle.mjs` names, makes and opens a backup bundle, says whether the public key is set, and makes a run's own work directory. `retention.mjs` is the rules for what is given up, as functions of a dated list and today's date: which bundles, on the machine and on the storage, and which of what a deploy or a restore kept. `kept.mjs` names and lists what a deploy or a restore kept.
- `offsite.mjs` reads where the bundles go and the alive address, uploads, lists and removes bundles on the storage with `rclone`, and makes the alive request with `curl`.
- `commands/backup.mjs` bundles every app, uploads, prunes the bundles and what deploys and restores kept, and makes the alive request; `commands/restore.mjs` checks the file and the app, then stops, dumps, replaces and starts; `commands/logs.mjs` hands the app's journal to the terminal.
