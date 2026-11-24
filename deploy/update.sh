#!/usr/bin/env bash
set -euo pipefail

# Update code only; preserve /opt/sancine/data/app.db, /etc/sancine.env,
# and the existing named tunnel.

BUNDLE_URL="${BUNDLE_URL:-__BUNDLE_URL__}"
APP_DIR="/opt/sancine"
TMP_DIR="/tmp/sancine-update"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行。" >&2
  exit 1
fi
if [ -z "$BUNDLE_URL" ]; then
  echo "BUNDLE_URL 没有设置。" >&2
  exit 1
fi

curl -fsSL "$BUNDLE_URL" -o /tmp/sancine-update.tar.gz
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
tar -xzf /tmp/sancine-update.tar.gz -C "$TMP_DIR"
rm -f /tmp/sancine-update.tar.gz
if [ ! -f "$TMP_DIR/server/app.mjs" ] || [ ! -f "$TMP_DIR/dist/index.html" ]; then
  echo "更新包不完整。" >&2
  exit 1
fi

mkdir -p "$APP_DIR/data/backups"
systemctl stop sancine.service || true
if [ -f "$APP_DIR/data/app.db" ]; then
  cp -p "$APP_DIR/data/app.db" "$APP_DIR/data/backups/app-before-update-$(date +%Y%m%d-%H%M%S).db"
fi
mkdir -p "$APP_DIR/dist" "$APP_DIR/server" "$APP_DIR/schema"
cp -R "$TMP_DIR/dist/." "$APP_DIR/dist/"
cp -R "$TMP_DIR/server/." "$APP_DIR/server/"
cp -R "$TMP_DIR/schema/." "$APP_DIR/schema/"
cp "$TMP_DIR/package.json" "$APP_DIR/package.json" 2>/dev/null || true
chown -R sancine:sancine "$APP_DIR"
systemctl start sancine.service

for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
    echo
    echo "更新完成，应用已启动。"
    echo "https://sanchine.xyz"
    exit 0
  fi
  sleep 1
done

echo "应用没有按时启动，请检查：" >&2
systemctl status sancine.service --no-pager || true
journalctl -u sancine.service -n 40 --no-pager || true
exit 1
