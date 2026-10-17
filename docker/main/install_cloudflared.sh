#!/bin/bash

set -euxo pipefail

# Runs the remote access tunnel. Keep the version at or above 2025.6.1, the
# oldest release that accepts every flag frigate/remote_access starts it with.
cloudflared_version="2026.10.0"

# sha256 digests of the release binaries, as published on the GitHub
# release; update when bumping cloudflared_version.
declare -A cloudflared_checksums=(
    ["amd64"]="d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db"
    ["arm64"]="e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08"
)

dest_dir="/rootfs/usr/local/cloudflared/bin"
mkdir -p "${dest_dir}"

wget -qO "${dest_dir}/cloudflared" \
    "https://github.com/cloudflare/cloudflared/releases/download/${cloudflared_version}/cloudflared-linux-${TARGETARCH}"
echo "${cloudflared_checksums[${TARGETARCH}]}  ${dest_dir}/cloudflared" | sha256sum -c -
chmod 755 "${dest_dir}/cloudflared"
