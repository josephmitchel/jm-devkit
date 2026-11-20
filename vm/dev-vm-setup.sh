#!/usr/bin/env bash
# Builds the dev VM from a fresh Ubuntu Server LTS install: toolchains, Postgres,
# and the two unprivileged users (one for agents, one for the code reviewer).
# Safe to run again. Run it from the admin account: sudo bash dev-vm-setup.sh
set -euo pipefail

NODE_MAJOR=24
NODE_MIN=24.15.0
GO_VERSION=1.26.5
GO_SHA256=5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053
PG_MAJOR=16
PLAYWRIGHT_VERSION=1.63.0
AGENT_USER=agent
REVIEWER_USER=reviewer

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run with sudo"
[ "$(dpkg --print-architecture)" = amd64 ] || fail "this script expects amd64"
. /etc/os-release
[ "$ID" = ubuntu ] || fail "this script expects Ubuntu"

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

step "Postgres roles"
as_postgres() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 -tAc "$1"; }
# Each role signs in over the local socket as the Linux user of the same name.
[ "$(as_postgres "SELECT 1 FROM pg_roles WHERE rolname = '$AGENT_USER'")" = 1 ] \
  || as_postgres "CREATE ROLE $AGENT_USER LOGIN CREATEDB"
[ "$(as_postgres "SELECT 1 FROM pg_roles WHERE rolname = '$REVIEWER_USER'")" = 1 ] \
  || as_postgres "CREATE ROLE $REVIEWER_USER LOGIN"
[ "$(as_postgres "SELECT 1 FROM pg_database WHERE datname = '$REVIEWER_USER'")" = 1 ] \
  || as_postgres "CREATE DATABASE $REVIEWER_USER OWNER $REVIEWER_USER"
# Keeps the agents' role out of the reviewer's database.
as_postgres "REVOKE CONNECT ON DATABASE $REVIEWER_USER FROM PUBLIC"

step "Chromium's system libraries (for the canvas tooling)"
# The browser itself is fetched per checkout: npx playwright-core install chromium
npx --yes "playwright-core@$PLAYWRIGHT_VERSION" install-deps chromium \
  || echo "warning: could not install Chromium's libraries; the canvas tooling will not run until this is fixed"

step "Claude Code for each user"
for user in "$AGENT_USER" "$REVIEWER_USER"; do
  [ -x "/home/$user/.local/bin/claude" ] \
    || runuser -l "$user" -c 'curl -fsSL https://claude.ai/install.sh | bash'
done

cat <<EOF

Done. Left to do by hand, once per user ($AGENT_USER, $REVIEWER_USER):
  - sign in to Claude Code: run 'claude' and follow /login
  - give the user its GitHub identity (gh auth, or the reviewer's App key)
Database addresses use the local socket, for example:
  postgresql:///vices_demo?host=/var/run/postgresql
EOF
