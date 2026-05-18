#!/usr/bin/env bash
# dev-web.sh — Terminal 3：前端 vite dev server
# 端口由 .env 的 WEB_PORT 决定（默认 12400），/api 与 /ws 自动代理到 SERVER_PORT（默认 3001）。
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

echo "[dev-web] starting vite on http://localhost:${WEB_PORT:-12400} (Ctrl+C 退出)"
exec npm run dev:web
