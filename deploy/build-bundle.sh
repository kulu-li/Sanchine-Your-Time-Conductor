#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f dist/index.html ]; then
  echo "dist/index.html missing; run the build first" >&2
  exit 1
fi

OUT="${1:-/tmp/sancine-deploy}"
rm -rf "$OUT"
mkdir -p "$OUT/stage/data"

cp -R dist "$OUT/stage/dist"
cp -R server "$OUT/stage/server"
cp -R schema "$OUT/stage/schema"
cp package.json "$OUT/stage/package.json"
if [ -f data/state.json ]; then
  cp data/state.json "$OUT/stage/data/state.json"
fi

tar -czf "$OUT/sancine-bundle.tar.gz" -C "$OUT/stage" .
rm -rf "$OUT/stage"
echo "bundle: $OUT/sancine-bundle.tar.gz"
