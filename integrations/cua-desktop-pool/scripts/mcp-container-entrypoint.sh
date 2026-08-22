#!/bin/sh
set -eu

image="${CUA_POOL_IMAGE:-cua-desktop-pool-xfce:local}"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "Building missing CUA desktop image: $image" >&2
  docker build --tag "$image" --file /app/docker/Dockerfile /app
fi

exec cua-desktop-pool-mcp
