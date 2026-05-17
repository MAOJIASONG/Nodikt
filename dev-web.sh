#!/usr/bin/env bash
# dev-web.sh — Terminal 3：前端 vite dev server
# 端口 5173，/api 与 /ws 自动代理到 http://localhost:3001。
# 注意：要先启动 Terminal 2 的 node，否则前端调 /api/* 会一直挂在 proxy 上。

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ -f .env ]]; then
  echo "[dev-web] loading .env"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

echo "[dev-web] starting vite on http://localhost:5173 (Ctrl+C 退出)"
exec npm run dev:web
