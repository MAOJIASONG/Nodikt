#!/usr/bin/env bash
# dev-server.sh — Terminal 2：node 后端
# 跑 dist/index.js，监听 SERVER_PORT（默认 3001），加载根目录 .env。
# 注意：tsc --watch 不会触发它自动重启。改完 server 代码后回到这个终端 Ctrl+C 再次执行本脚本。

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# 显式 source 一次，给可能的下游脚本和子进程一致的环境（npm start 自身也带 --env-file-if-exists）。
if [[ -f .env ]]; then
  echo "[dev-server] loading .env"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# 确保 dist 存在（首次启动 Terminal 1 还没编译完时也能跑起来）。
if [[ ! -f server/dist/index.js ]]; then
  echo "[dev-server] dist/index.js 不存在，先做一次全量构建"
  npm run build -w server
fi

echo "[dev-server] starting node dist/index.js on SERVER_PORT=${SERVER_PORT:-3001} (Ctrl+C 退出)"
exec npm start -w server
