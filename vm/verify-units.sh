#!/usr/bin/env bash
# Puts the apps machine's units through systemd's own verification: the nightly backup's service
# and timer, and an app's service as the commands write it. Needs no sudo and installs nothing:
# the units are read in a scratch root that has this machine's own units to depend on.
#   bash vm/verify-units.sh
set -euo pipefail

VM_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
KIT=$(dirname "$VM_DIR")
UNITS=(apps-machine-backup.service apps-machine-backup.timer app-sample.service)

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/etc/systemd/system" "$root/usr/lib/systemd" "$root/usr/local/sbin" "$root/bin"
cp -r /usr/lib/systemd/system "$root/usr/lib/systemd/system"
# What the units start, which the verification wants to find and never runs.
for program in usr/local/sbin/apps-machine bin/sh; do
  printf '#!/bin/sh\n' > "$root/$program"
  chmod 0755 "$root/$program"
done
cp "$VM_DIR/systemd/apps-machine-backup.service" "$VM_DIR/systemd/apps-machine-backup.timer" "$root/etc/systemd/system/"
node --input-type=module -e '
  const [kit] = process.argv.slice(1);
  const { machinePaths } = await import(`${kit}/apps-machine/paths.mjs`);
  const { renderUnit } = await import(`${kit}/apps-machine/service.mjs`);
  process.stdout.write(renderUnit(machinePaths("/"), "sample"));
' "$KIT" > "$root/etc/systemd/system/app-sample.service"

# A unit systemd only warns about still exits 0, so anything it says about one of ours fails too.
said=$(systemd-analyze verify --man=no --root="$root" "${UNITS[@]}" 2>&1) || { printf '%s\n' "$said" >&2; exit 1; }
if printf '%s\n' "$said" | grep -E "$(IFS='|'; echo "${UNITS[*]}")" >&2; then
  exit 1
fi
echo "systemd verifies ${UNITS[*]}"
