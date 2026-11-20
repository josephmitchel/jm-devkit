#!/usr/bin/env bash
# Builds the dev VM from a fresh Ubuntu Server LTS install: toolchains, Postgres,
# the two unprivileged users (one for agents, one for the code reviewer), and the
# code reviewer as a service of its own user, started by a timer.
# Safe to run again. Run it from the admin account, from a checkout of the kit:
#   sudo bash vm/dev-vm-setup.sh
# To set the local time the nightly run starts at (02:00 unless set):
#   sudo NIGHTLY_AT=03:30 bash vm/dev-vm-setup.sh
# To set how long the poller waits between passes (3min unless set):
#   sudo POLL_EVERY=5min bash vm/dev-vm-setup.sh
set -euo pipefail

# The units come from beside this script, in the admin's checkout. Never from the code reviewer's
# own checkout: its user can write there, and a unit installed from here is run by root.
UNITS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/systemd

NODE_MAJOR=24
NODE_MIN=24.15.0
GO_VERSION=1.26.5
GO_SHA256=5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053
PG_MAJOR=16
PLAYWRIGHT_VERSION=1.63.0
AGENT_USER=agent
REVIEWER_USER=reviewer

# The code reviewer. The units in vm/systemd name the same paths.
KIT_REPO=https://github.com/josephmitchel/jm-devkit.git
REVIEWER_VAR=/var/lib/code-reviewer
KIT_DIR=$REVIEWER_VAR/kit
CREDENTIALS_FILE=/etc/code-reviewer/credentials.env
# Its two Postgres roles. Neither is the name of a Linux user, so neither can be opened over the
# local socket by being that user: each takes its password.
REVIEWER_DB=code_reviewer
REVIEWER_TESTS_ROLE=code_reviewer_tests
# What the credentials file must hold. Names only: this script never prints a value.
CREDENTIAL_NAMES=(DATABASE_URL REVIEWER_TEST_DATABASES_URL CLAUDE_CODE_OAUTH_TOKEN REVIEWER_APP_CLIENT_ID REVIEWER_APP_PRIVATE_KEY)
NIGHTLY_AT=${NIGHTLY_AT:-}
POLL_EVERY=${POLL_EVERY:-}

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run with sudo"
[ "$(dpkg --print-architecture)" = amd64 ] || fail "this script expects amd64"
. /etc/os-release
[ "$ID" = ubuntu ] || fail "this script expects Ubuntu"
[ -f "$UNITS_DIR/code-reviewer-nightly.service" ] \
  || fail "no units in $UNITS_DIR: run this script from a checkout of the kit, not from a copy of the file"
[[ -z "$NIGHTLY_AT" || "$NIGHTLY_AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] \
  || fail "NIGHTLY_AT must be a time of day as HH:MM, not '$NIGHTLY_AT'"
[[ -z "$POLL_EVERY" || "$POLL_EVERY" =~ ^[1-9][0-9]*(s|min|h)$ ]] \
  || fail "POLL_EVERY must be a length of time such as 3min, 90s or 1h, not '$POLL_EVERY'"

cd /
export DEBIAN_FRONTEND=noninteractive
keyrings=/etc/apt/keyrings
install -d -m 0755 "$keyrings"

step "Base packages"
apt-get update
apt-get install -y build-essential ca-certificates curl git jq ripgrep tmux unzip

step "Package sources: Node $NODE_MAJOR, Postgres $PG_MAJOR, GitHub CLI"
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$keyrings/nodesource.asc"
echo "deb [arch=amd64 signed-by=$keyrings/nodesource.asc] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$keyrings/pgdg.asc"
echo "deb [arch=amd64 signed-by=$keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt $VERSION_CODENAME-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "$keyrings/githubcli.gpg"
echo "deb [arch=amd64 signed-by=$keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
chmod 0644 "$keyrings"/nodesource.asc "$keyrings"/pgdg.asc "$keyrings"/githubcli.gpg
apt-get update
apt-get install -y nodejs "postgresql-$PG_MAJOR" gh

node_version=$(node -p 'process.versions.node')
dpkg --compare-versions "$node_version" ge "$NODE_MIN" || fail "node $node_version is older than $NODE_MIN"

step "Go $GO_VERSION"
if [ "$(cat /usr/local/go/VERSION 2>/dev/null | head -1)" != "go$GO_VERSION" ]; then
  tarball=$(mktemp)
  curl -fsSL "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz" -o "$tarball"
  echo "$GO_SHA256  $tarball" | sha256sum -c -
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "$tarball"
  rm -f "$tarball"
fi
ln -sf /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/

step "Tailscale"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
  echo "Tailscale is installed but not joined: run 'sudo tailscale up --ssh'."
fi

step "Users: $AGENT_USER and $REVIEWER_USER"
for user in "$AGENT_USER" "$REVIEWER_USER"; do
  id "$user" >/dev/null 2>&1 || adduser --disabled-password --gecos '' "$user"
  # Neither user may read the other's files, and neither has admin rights.
  chmod 0700 "/home/$user"
  if id -nG "$user" | tr ' ' '\n' | grep -qx sudo; then
    fail "$user is in the sudo group; remove it and run again"
  fi
done

step "Postgres role for the agents"
as_postgres() { runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -tAc "$1"; }
role_exists() { [ "$(as_postgres "SELECT 1 FROM pg_roles WHERE rolname = '$1'")" = 1 ]; }
database_exists() { [ "$(as_postgres "SELECT 1 FROM pg_database WHERE datname = '$1'")" = 1 ]; }
# Signs in over the local socket as the Linux user of the same name.
role_exists "$AGENT_USER" || as_postgres "CREATE ROLE $AGENT_USER LOGIN CREATEDB"

step "Postgres roles and database for the code reviewer"
# An earlier version of this script made a role and a database named after the reviewer user,
# which that user, and so any project command the code reviewer runs, could open with no password.
# They are removed only when the database is empty.
if database_exists "$REVIEWER_USER"; then
  relations=$(runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -tA -d "$REVIEWER_USER" -c \
    "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp)'")
  if [ "$relations" != 0 ]; then
    echo "warning: the database '$REVIEWER_USER' holds $relations table(s) or other relation(s), so it and its role are left alone."
    echo "         The $REVIEWER_USER user can open it with no password. It is not the code reviewer's database, which is '$REVIEWER_DB'."
  elif as_postgres "DROP DATABASE $REVIEWER_USER"; then
    echo "Removed the empty database '$REVIEWER_USER' that an earlier setup made."
  else
    echo "warning: could not remove the empty database '$REVIEWER_USER' (is something connected to it?); it is left as it is"
  fi
fi
if role_exists "$REVIEWER_USER" && ! database_exists "$REVIEWER_USER"; then
  # Postgres refuses to drop a role that still owns anything, so this cannot lose data.
  if as_postgres "DROP ROLE $REVIEWER_USER" 2>/dev/null; then
    echo "Removed the role '$REVIEWER_USER' that an earlier setup made."
  else
    echo "warning: the role '$REVIEWER_USER' still owns something, so it is left alone; the $REVIEWER_USER user can sign in as it with no password"
  fi
fi

role_exists "$REVIEWER_DB" || as_postgres "CREATE ROLE $REVIEWER_DB LOGIN"
# Creates the databases a project's tests ask for (reviewer.databases). A project's commands are
# handed this role's password inside those addresses, so it may do that and nothing else.
role_exists "$REVIEWER_TESTS_ROLE" || as_postgres "CREATE ROLE $REVIEWER_TESTS_ROLE LOGIN CREATEDB"
database_exists "$REVIEWER_DB" || as_postgres "CREATE DATABASE $REVIEWER_DB OWNER $REVIEWER_DB"
# Only its owner may connect: not the agents' role, and not the role for test databases.
as_postgres "REVOKE CONNECT ON DATABASE $REVIEWER_DB FROM PUBLIC"
pg_port=$(as_postgres "SHOW port")

step "The code reviewer's credentials file"
# Root's alone. systemd reads it and hands the values to the code reviewer's services through
# their environment. The reviewer user cannot read it, so neither can a project's commands.
install -d -m 0700 -o root -g root "$(dirname "$CREDENTIALS_FILE")"
new_password() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
# The statement goes in on stdin, so the password is in no process's arguments.
set_password() { printf "ALTER ROLE %s PASSWORD '%s';\n" "$1" "$2" | runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -q; }
if [ ! -e "$CREDENTIALS_FILE" ]; then
  # The two database passwords are made here and kept nowhere else, so a missing file means new ones.
  db_password=$(new_password)
  tests_password=$(new_password)
  set_password "$REVIEWER_DB" "$db_password"
  set_password "$REVIEWER_TESTS_ROLE" "$tests_password"
  (
    umask 077
    cat > "$CREDENTIALS_FILE.new" <<EOF
# The code reviewer's credentials. Only root may read this file: keep it root:root, mode 0600,
# and keep no copy where the $REVIEWER_USER user could read one.
# One NAME=value per line, the value exactly as it is: no quotes, no spaces around the "=".

# The code reviewer's own database. While projects are still moving off GitHub Actions this is
# the hosted database's address instead; keep this line, commented out, for the day of the copy.
DATABASE_URL=postgres://$REVIEWER_DB:$db_password@127.0.0.1:$pg_port/$REVIEWER_DB

# Where the databases a project's tests ask for are created.
REVIEWER_TEST_DATABASES_URL=postgres://$REVIEWER_TESTS_ROLE:$tests_password@127.0.0.1:$pg_port/postgres

# The Claude subscription's long-lived token, from: claude setup-token
CLAUDE_CODE_OAUTH_TOKEN=

# The code reviewer's GitHub App: its client id, and its private key as ONE line of base64,
# from: base64 -w0 < the-downloaded-key.pem
REVIEWER_APP_CLIENT_ID=
REVIEWER_APP_PRIVATE_KEY=
EOF
    mv "$CREDENTIALS_FILE.new" "$CREDENTIALS_FILE"
  )
  echo "Created $CREDENTIALS_FILE, with new passwords for the two database roles."

  # With the passwords in hand, show that each role opens what it should and nothing more.
  can_open() { PGPASSWORD=$2 psql -X -h 127.0.0.1 -p "$pg_port" -U "$1" -d "$3" -w -tAc 'SELECT 1' >/dev/null 2>&1; }
  can_open "$REVIEWER_DB" "$db_password" "$REVIEWER_DB" \
    || fail "the role $REVIEWER_DB cannot open its database over 127.0.0.1 with its password: check listen_addresses and pg_hba.conf"
  can_open "$REVIEWER_TESTS_ROLE" "$tests_password" postgres \
    || fail "the role $REVIEWER_TESTS_ROLE cannot sign in over 127.0.0.1 with its password: check pg_hba.conf"
  ! can_open "$REVIEWER_TESTS_ROLE" "$tests_password" "$REVIEWER_DB" \
    || fail "the role $REVIEWER_TESTS_ROLE can open the code reviewer's database, and must not"
  unset db_password tests_password
else
  chown root:root "$CREDENTIALS_FILE"
  chmod 0600 "$CREDENTIALS_FILE"
  echo "$CREDENTIALS_FILE exists: its contents are left as they are, and no database password was changed."
  for role in "$REVIEWER_DB" "$REVIEWER_TESTS_ROLE"; do
    if [ "$(as_postgres "SELECT rolpassword IS NULL FROM pg_authid WHERE rolname = '$role'")" = t ]; then
      echo "warning: the role '$role' has no password yet, so nothing can sign in as it. Set one with"
      echo "           sudo -u postgres psql -c '\\password $role'"
      echo "         and put it in that role's address in $CREDENTIALS_FILE."
    fi
  done
fi

# Without a password nobody on this machine gets in: not under the reviewer user's own name, and
# not by naming one of the code reviewer's roles, over the socket or over TCP.
for role in "$REVIEWER_USER" "$REVIEWER_DB" "$REVIEWER_TESTS_ROLE"; do
  for host in /var/run/postgresql 127.0.0.1; do
    if runuser -u "$REVIEWER_USER" -- env -u PGPASSWORD PGPASSFILE=/dev/null \
      psql -X -h "$host" -p "$pg_port" -U "$role" -d "$REVIEWER_DB" -w -tAc 'SELECT 1' >/dev/null 2>&1; then
      fail "the $REVIEWER_USER user opened the database '$REVIEWER_DB' as '$role' through $host with no password: check pg_hba.conf and pg_ident.conf"
    fi
  done
done
echo "Checked: the $REVIEWER_USER user cannot open the database '$REVIEWER_DB' without a password."

step "Chromium's system libraries (for the canvas tooling)"
# The browser itself is fetched per checkout: npx playwright-core install chromium
npx --yes "playwright-core@$PLAYWRIGHT_VERSION" install-deps chromium \
  || echo "warning: could not install Chromium's libraries; the canvas tooling will not run until this is fixed"

step "Claude Code for each user"
for user in "$AGENT_USER" "$REVIEWER_USER"; do
  [ -x "/home/$user/.local/bin/claude" ] \
    || runuser -l "$user" -c 'curl -fsSL https://claude.ai/install.sh | bash'
done

step "The code reviewer's checkout"
# Its own copy of the kit, which it moves to the kit's default branch before each nightly run.
as_reviewer() { runuser -u "$REVIEWER_USER" -- env -i HOME="/home/$REVIEWER_USER" PATH=/usr/local/bin:/usr/bin:/bin "$@"; }
install -d -m 0700 -o "$REVIEWER_USER" -g "$REVIEWER_USER" "$REVIEWER_VAR"
[ -d "$KIT_DIR/.git" ] || as_reviewer git clone "$KIT_REPO" "$KIT_DIR"
# How its git signs in to GitHub: a helper that mints a short-lived token as the App, from the
# credentials in the service's environment. Nothing is stored.
as_reviewer git config --global credential.helper "!node '$KIT_DIR/reviewer/bin/git-credential.mjs'"

step "The code reviewer's services and timers"
changed=no
install_unit() { # <source> <destination>
  cmp -s "$1" "$2" && return 0
  install -D -m 0644 -o root -g root "$1" "$2"
  changed=yes
}
# Every service and timer in vm/systemd is installed, so a second pair drops in beside the first.
for unit in "$UNITS_DIR"/code-reviewer-*.service "$UNITS_DIR"/code-reviewer-*.timer; do
  install_unit "$unit" "/etc/systemd/system/$(basename "$unit")"
done
if [ -n "$NIGHTLY_AT" ]; then
  # The setting: a drop-in over the timer's own time. A later run without NIGHTLY_AT keeps it.
  drop_in=$(mktemp)
  printf '# Written by dev-vm-setup.sh from NIGHTLY_AT.\n[Timer]\nOnCalendar=\nOnCalendar=*-*-* %s:00\n' "$NIGHTLY_AT" > "$drop_in"
  install_unit "$drop_in" /etc/systemd/system/code-reviewer-nightly.timer.d/time.conf
  rm -f "$drop_in"
fi
if [ -n "$POLL_EVERY" ]; then
  # The same for the poller: a drop-in over the timer's own interval.
  drop_in=$(mktemp)
  printf '# Written by dev-vm-setup.sh from POLL_EVERY.\n[Timer]\nOnUnitInactiveSec=\nOnUnitInactiveSec=%s\n' "$POLL_EVERY" > "$drop_in"
  install_unit "$drop_in" /etc/systemd/system/code-reviewer-poller.timer.d/interval.conf
  rm -f "$drop_in"
fi
systemctl daemon-reload

# The timers are turned on only once every credential has a value: a run without them can only fail.
missing=()
for name in "${CREDENTIAL_NAMES[@]}"; do
  grep -Eq "^$name=.+" "$CREDENTIALS_FILE" || missing+=("$name")
done
if [ ${#missing[@]} -eq 0 ]; then
  for timer in "$UNITS_DIR"/code-reviewer-*.timer; do
    timer=$(basename "$timer")
    systemctl enable --now "$timer"
    # Only when something changed: restarting a timer whose time has already passed today starts a run.
    [ "$changed" = no ] || systemctl restart "$timer"
  done
  systemctl list-timers 'code-reviewer-*' --no-pager || true
fi

step "Check: no credential in the $REVIEWER_USER user's home"
for file in .claude/.credentials.json .config/gh/hosts.yml .git-credentials .netrc .pgpass; do
  [ ! -e "/home/$REVIEWER_USER/$file" ] \
    || echo "warning: /home/$REVIEWER_USER/$file exists. The code reviewer's credentials belong only in $CREDENTIALS_FILE: remove it."
done

cat <<EOF

Done. Left to do by hand:
  - $AGENT_USER: sign in to Claude Code (run 'claude' and follow /login) and to GitHub (gh auth login).
    Its database addresses use the local socket, for example:
      postgresql:///vices_demo?host=/var/run/postgresql
  - $REVIEWER_USER: do NOT sign in to anything as this user. Its credentials reach the code
    reviewer's services only from $CREDENTIALS_FILE, which root alone can read.
EOF
if [ ${#missing[@]} -eq 0 ]; then
  cat <<EOF

The code reviewer's timers are on; the nightly run starts at the local time listed above.
  By hand:  sudo systemctl start --no-block code-reviewer-nightly.service
  Its log:  journalctl -u code-reviewer-nightly.service
The poller's passes start once the first nightly run has installed the code reviewer's
dependencies; until then each is skipped.
  By hand:  sudo systemctl start code-reviewer-poller.service
  Its log:  journalctl -u code-reviewer-poller.service
EOF
else
  cat <<EOF

The code reviewer's timers are NOT on yet. $CREDENTIALS_FILE has no value for:
  ${missing[*]}
Fill them in (sudoedit $CREDENTIALS_FILE; the file says where each comes from), then run this
script again, which turns the timers on.
EOF
fi
