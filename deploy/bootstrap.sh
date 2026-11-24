#!/usr/bin/env bash
set -euo pipefail

# 三线 HK/Cloudflare Tunnel bootstrap.
# Run from the Tencent Cloud web terminal:
#   curl -fsSL <deploy-url>/bootstrap.sh | sudo bash
#
# This script never reads or changes data/app.db if it already exists.

BUNDLE_URL="${BUNDLE_URL:-__BUNDLE_URL__}"
APP_DIR="/opt/sancine"
ENV_FILE="/etc/sancine.env"
NODE_DIR="/usr/local/lib/nodejs"
NODE_MAJOR="26"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行。" >&2
  exit 1
fi
if [ -z "$BUNDLE_URL" ]; then
  echo "BUNDLE_URL 没有设置。" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl xz-utils tar sqlite3 openssl

# Node 26 (node:sqlite is required by the server).
if ! command -v node >/dev/null 2>&1 || ! node -e "import('node:sqlite').then(()=>process.exit(0),()=>process.exit(1))" >/dev/null 2>&1; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) NODE_ARCH="linux-x64" ;;
    aarch64|arm64) NODE_ARCH="linux-arm64" ;;
    *) echo "不支持的架构：$ARCH" >&2; exit 1 ;;
  esac
  INDEX="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/")"
  NODE_FILE="$(printf '%s' "$INDEX" | grep -oE "node-v[0-9.]+-${NODE_ARCH}\.tar\.xz" | sed -n '1p' | tr -d '\r')"
  if [ -z "$NODE_FILE" ]; then
    echo "找不到 Node ${NODE_MAJOR} 的 ${NODE_ARCH} 包。" >&2
    exit 1
  fi
  echo "下载 Node: ${NODE_FILE}"
  curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${NODE_FILE}" -o /tmp/node.tar.xz
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xJf /tmp/node.tar.xz -C "$NODE_DIR" --strip-components=1
  ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node
  ln -sf "$NODE_DIR/bin/npm" /usr/local/bin/npm
  ln -sf "$NODE_DIR/bin/npx" /usr/local/bin/npx
  rm -f /tmp/node.tar.xz
fi

if ! node -e "import('node:sqlite').then(()=>process.exit(0),()=>process.exit(1))" >/dev/null 2>&1; then
  echo "Node 没有 node:sqlite，需要 Node >= 22.5。" >&2
  node -v
  exit 1
fi

# App user.
if ! id -u sancine >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin sancine
fi

# Download and extract the app bundle. data/state.json is used only by the
# first-run setup; an existing data/app.db is never overwritten.
curl -fsSL "$BUNDLE_URL" -o /tmp/sancine-bundle.tar.gz
mkdir -p "$APP_DIR"
tar -xzf /tmp/sancine-bundle.tar.gz -C "$APP_DIR"
rm -f /tmp/sancine-bundle.tar.gz
mkdir -p "$APP_DIR/data"
chown -R sancine:sancine "$APP_DIR"

# One-time setup token.
if [ ! -f "$ENV_FILE" ]; then
  SETUP_TOKEN="$(openssl rand -hex 16)"
  cat > "$ENV_FILE" <<ENV
PORT=8787
HOST=127.0.0.1
GANTT_DATA_DIR=$APP_DIR/data
GANTT_SETUP_TOKEN=$SETUP_TOKEN
COOKIE_SECURE=1
NODE_ENV=production
ENV
  chmod 600 "$ENV_FILE"
fi
SETUP_TOKEN="$(grep '^GANTT_SETUP_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"

# Cloudflared (quick tunnel; outbound only, no inbound 80/443 needed).
if ! command -v cloudflared >/dev/null 2>&1; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) CF_ARCH="amd64" ;;
    aarch64|arm64) CF_ARCH="arm64" ;;
    *) echo "不支持的架构：$ARCH" >&2; exit 1 ;;
  esac
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
fi

cat > /etc/systemd/system/sancine.service <<SERVICE
[Unit]
Description=三线 Gantt server
After=network.target

[Service]
Type=simple
User=sancine
Group=sancine
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/node $APP_DIR/server/app.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/data

[Install]
WantedBy=multi-user.target
SERVICE

cat > /etc/systemd/system/sancine-tunnel.service <<SERVICE
[Unit]
Description=三线 Cloudflare quick tunnel
After=network.target sancine.service

[Service]
Type=simple
User=sancine
Group=sancine
ExecStart=/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate --protocol http2 --edge-ip-version 4
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
SERVICE

# Daily SQLite backup.
cat > /usr/local/bin/sancine-backup <<'BACKUP'
#!/bin/sh
set -eu
[ -f /opt/sancine/data/app.db ] || exit 0
DIR=/opt/sancine/data/backups
mkdir -p "$DIR"
sqlite3 /opt/sancine/data/app.db ".backup '$DIR/app-$(date +%F).db'"
find "$DIR" -type f -name 'app-*.db' -mtime +14 -delete
BACKUP
chmod 755 /usr/local/bin/sancine-backup
echo '17 3 * * * root /usr/local/bin/sancine-backup' > /etc/cron.d/sancine-backup

systemctl daemon-reload
systemctl enable --now sancine.service
systemctl enable --now sancine-tunnel.service
systemctl restart sancine.service
systemctl restart sancine-tunnel.service

# Wait for the app.
for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Wait for the quick tunnel URL.
URL=""
for _ in $(seq 1 60); do
  URL="$(journalctl -u sancine-tunnel --no-pager -n 300 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
  if [ -n "$URL" ]; then
    break
  fi
  sleep 1
done

echo
echo "=============================================="
echo " 三线已部署"
echo " 公网地址：${URL:-未获取到，请运行: journalctl -u sancine-tunnel -n 100 --no-pager}"
echo " Setup token：$SETUP_TOKEN"
echo "=============================================="
echo
echo "第一次打开公网地址，用 Setup token 创建管理员；"
echo "现有 data/state.json 会自动导入你的 workspace。"
echo
if [ -z "$URL" ]; then
  echo "隧道日志："
  journalctl -u sancine-tunnel -n 40 --no-pager || true
fi
