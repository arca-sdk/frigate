#!/bin/bash

set -euxo pipefail

# Runs the Tailscale remote access route inside the container.
tailscale_version="1.104.1"

# sha256 digests of the static release tarballs, as published next to them
# on pkgs.tailscale.com; update when bumping tailscale_version.
declare -A tailscale_checksums=(
    ["amd64"]="108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528"
    ["arm64"]="f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806"
)

dest_dir="/rootfs/usr/local/tailscale/bin"
mkdir -p "${dest_dir}"

archive="tailscale_${tailscale_version}_${TARGETARCH}.tgz"
wget -qO "/tmp/${archive}" "https://pkgs.tailscale.com/stable/${archive}"
echo "${tailscale_checksums[${TARGETARCH}]}  /tmp/${archive}" | sha256sum -c -
tar -xzf "/tmp/${archive}" -C "${dest_dir}" --strip-components=1 \
    "tailscale_${tailscale_version}_${TARGETARCH}/tailscale" \
    "tailscale_${tailscale_version}_${TARGETARCH}/tailscaled"
chmod 755 "${dest_dir}/tailscale" "${dest_dir}/tailscaled"
rm "/tmp/${archive}"
