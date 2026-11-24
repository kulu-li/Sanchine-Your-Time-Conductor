#!/bin/bash
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 node。请先安装 Node.js，或在 DeepSeek Harness 里启动。"
  read -r -n 1 -p "按任意键退出..."
  exit 1
fi

echo "三线 · 时间网格 v1"
echo "本机：http://localhost:5173/"
IP=$(ipconfig getifaddr en0 2>/dev/null || true)
if [ -n "$IP" ]; then
  echo "局域网：http://$IP:5173/"
fi
echo "按 Ctrl+C 停止"
echo

node node_modules/vite/bin/vite.js --host 0.0.0.0 --port 5173
