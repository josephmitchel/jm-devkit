#!/usr/bin/env bash
# Builds the apps machine from a fresh Ubuntu Server LTS install: Node, Postgres, Tailscale, git,
# the tools the backups need, and the kit's apps-machine commands for root.
# It installs no agent tooling, and makes no user for agents and none for the code reviewer.
# Safe to run again. Run it from the admin account, from a checkout of the kit:
#   sudo bash vm/apps-machine-setup.sh
# The nightly backup's timer is turned on once the owner's age public key is set. Give it once:
#   sudo BACKUP_PUBLIC_KEY=age1... bash vm/apps-machine-setup.sh
# The owner's notes for the machine are in apps-machine/README.md.
set -euo pipefail

VM_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# The admin's checkout this script is in.
CHECKOUT=$(dirname "$VM_DIR")

# The steps this script shares with the development machine's, and the Node and Postgres versions.
[ -f "$VM_DIR/machine-steps.sh" ] \
  || { echo "error: no machine-steps.sh in $VM_DIR: run this script from a checkout of the kit, not from a copy of the file" >&2; exit 1; }
. "$VM_DIR/machine-steps.sh"

# The commands are copied from the admin's checkout into a directory of root's, and root runs them
# from the copy: never from the checkout, and never from anywhere another user can write.
COMMANDS_DIR=/usr/local/lib/apps-machine
COMMAND=/usr/local/sbin/apps-machine
# apps-machine/paths.mjs names the same directories, and a test there fails if the two differ.
# Root's alone: registrations, settings files and deploy keys.
CONFIG_DIR=/etc/apps-machine
# Each app's own directory is under here, so every user can pass through it.
STATE_DIR=/var/lib/apps-machine
# Root's alone: database dumps and backup bundles.
BACKUP_DIR=/var/lib/apps-machine/backups
# The owner's public key, which every backup bundle is encrypted to. The private half is never here.
BACKUP_KEY_FILE=/etc/apps-machine/backup-public-key
# The setting that writes it. A later run without it keeps the key the machine has.
BACKUP_PUBLIC_KEY=${BACKUP_PUBLIC_KEY:-}

require_sudo_on_ubuntu
[ -f "$CHECKOUT/apps-machine/install.mjs" ] \
  || fail "no commands in $CHECKOUT/apps-machine: run this script from a checkout of the kit, not from a copy of the file"
# What dev-vm-setup.sh leaves behind. Agents work on that machine, and none may reach this one.
[ ! -e /etc/code-reviewer ] \
  || fail "this is the development machine (it has /etc/code-reviewer): the apps machine is a machine of its own"

prepare_apt

step "Base packages"
apt-get update
apt-get install -y ca-certificates curl git openssh-client

step "Package sources: Node $NODE_MAJOR, Postgres $PG_MAJOR"
add_node_source
add_postgres_source
apt-get update
apt-get install -y nodejs "postgresql-$PG_MAJOR"

check_node_version

step "Backup tools: age and rclone"
apt-get install -y age rclone

step "Tailscale"
install_tailscale

step "The machine's directories"
install -d -m 0700 -o root -g root "$CONFIG_DIR"
install -d -m 0755 -o root -g root "$STATE_DIR"
install -d -m 0700 -o root -g root "$BACKUP_DIR"

step "The apps-machine commands"
node "$CHECKOUT/apps-machine/install.mjs" "$COMMANDS_DIR"
ln -sfn "$COMMANDS_DIR/apps-machine/apps-machine.mjs" "$COMMAND"

step "The nightly backup"
if [ -n "$BACKUP_PUBLIC_KEY" ]; then
  printf '%s\n' "$BACKUP_PUBLIC_KEY" > "$BACKUP_KEY_FILE.new"
  # age is the judge of a key: it encrypts nothing to it, as the backup will encrypt a bundle.
  if ! age --encrypt --recipients-file "$BACKUP_KEY_FILE.new" --output /dev/null < /dev/null; then
    rm -f "$BACKUP_KEY_FILE.new"
    fail "BACKUP_PUBLIC_KEY is not a public key age can encrypt to. It starts age1; the line starting AGE-SECRET-KEY- is the private half, which stays off this machine"
  fi
  chmod 0644 "$BACKUP_KEY_FILE.new"
  mv "$BACKUP_KEY_FILE.new" "$BACKUP_KEY_FILE"
  echo "Wrote the public key to $BACKUP_KEY_FILE."
fi
changed=no
for unit in apps-machine-backup.service apps-machine-backup.timer; do
  install_unit "$VM_DIR/systemd/$unit" "/etc/systemd/system/$unit"
done
[ "$changed" = no ] || systemctl daemon-reload
# The timer is on only while there is a public key: a run without one can only refuse.
# The same test as publicKeyIsSet in apps-machine/bundle.mjs: a line that is not a comment.
if [ -f "$BACKUP_KEY_FILE" ] && grep -Eq '^[^#[:space:]]' "$BACKUP_KEY_FILE"; then
  backup_timer=on
  systemctl enable --now apps-machine-backup.timer
  # Only when something changed: restarting a timer whose time has already passed today starts a run.
  [ "$changed" = no ] || systemctl restart apps-machine-backup.timer
  systemctl list-timers apps-machine-backup.timer --no-pager || true
else
  backup_timer=off
  systemctl disable --now apps-machine-backup.timer
  echo "No public key is set for the backups, so the timer is not turned on."
fi

step "Check: the commands run, and the apps registered here"
hash -r
command -v apps-machine >/dev/null || fail "$COMMAND is not on root's path, which is $PATH"
apps-machine list

cat <<EOF

Done. Left to do by hand:
  - Join Tailscale, if this machine has not: sudo tailscale up --ssh
After a change to the kit, update the checkout and run this script again: it installs the
commands as the checkout has them.
EOF
if [ "$backup_timer" = on ]; then
  cat <<EOF

The nightly backup's timer is on; it starts at the local time listed above.
  By hand:  sudo apps-machine backup
  Its log:  journalctl -u apps-machine-backup.service
EOF
else
  cat <<EOF

The nightly backup's timer is NOT on: $BACKUP_KEY_FILE holds no public key, and without one
no bundle can be encrypted. Make a key pair with age-keygen on a device of your own, keep the
private half there, and run this script again with the public half, which turns the timer on:
  sudo BACKUP_PUBLIC_KEY=age1... bash vm/apps-machine-setup.sh
EOF
fi
