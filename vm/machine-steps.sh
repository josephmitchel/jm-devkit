# The steps both machines' setup scripts take: dev-vm-setup.sh and apps-machine-setup.sh source
# this file from beside themselves. It does nothing when sourced but define them.

NODE_MAJOR=24
NODE_MIN=24.15.0
PG_MAJOR=16
keyrings=/etc/apt/keyrings

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

require_sudo_on_ubuntu() {
  [ "$(id -u)" -eq 0 ] || fail "run with sudo"
  if [ -r /etc/os-release ]; then . /etc/os-release; fi
  [ "${ID:-}" = ubuntu ] || fail "this script expects Ubuntu"
  [ "$(dpkg --print-architecture)" = amd64 ] || fail "this script expects amd64"
}

prepare_apt() {
  cd /
  export DEBIAN_FRONTEND=noninteractive
  install -d -m 0755 "$keyrings"
}

# Each adds a package source. The caller runs apt-get update once it has added all of its own.
add_node_source() {
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$keyrings/nodesource.asc"
  echo "deb [arch=amd64 signed-by=$keyrings/nodesource.asc] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  chmod 0644 "$keyrings/nodesource.asc"
}
add_postgres_source() {
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$keyrings/pgdg.asc"
  echo "deb [arch=amd64 signed-by=$keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt $VERSION_CODENAME-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  chmod 0644 "$keyrings/pgdg.asc"
}

check_node_version() {
  node_version=$(node -p 'process.versions.node')
  dpkg --compare-versions "$node_version" ge "$NODE_MIN" || fail "node $node_version is older than $NODE_MIN"
}

install_tailscale() {
  if ! command -v tailscale >/dev/null; then
    curl -fsSL https://tailscale.com/install.sh | sh
    echo "Tailscale is installed but not joined: run 'sudo tailscale up --ssh'."
  fi
}

# Sets changed=yes when the unit was not already there as it is in the kit.
install_unit() { # <source> <destination>
  cmp -s "$1" "$2" && return 0
  install -D -m 0644 -o root -g root "$1" "$2"
  changed=yes
}
