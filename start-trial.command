#!/bin/bash
set -e
cd "$(dirname "$0")"

if [ ! -f dist/index.html ]; then
  echo "首次启动，正在构建..."
  node node_modules/typescript/bin/tsc -b
  node node_modules/vite/bin/vite.js build
  node scripts/build-sw.mjs
fi

echo ""
echo "口令：$(cat data/passcode.txt)"
echo "本机：http://localhost:8787"
echo "正在启动免费公网隧道，下面会输出 trycloudflare.com 地址..."
echo ""

node server/app.mjs &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

./bin/cloudflared tunnel --url http://localhost:8787 --no-autoupdate --protocol http2 --edge-ip-version 4
