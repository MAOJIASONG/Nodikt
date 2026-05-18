#!/usr/bin/env bash
# start-dev.sh — Nodikt 开发模式一键启动
#
# 行为：
#   1. 从项目根 .env 加载环境变量（若存在），导出给所有子进程
#   2. 先做一次 server 全量编译，确保 dist/index.js 存在
#   3. 后台跑 tsc --watch（server 增量编译）
#   4. 后台跑 node dist/index.js（HTTP/WS server, SERVER_PORT, 默认 :3001）
#   5. 前台跑 vite dev（web, WEB_PORT, 默认 :12400）。Ctrl+C 退出时自动 kill 两个后台进程
#
# 注意：
#   - tsc --watch 只重编译 dist，不会自动重启 node。改完 server 代码后两种做法：
#       a) Ctrl+C 整个脚本，重新运行 ./start-dev.sh
#       b) 只重启 node：  kill $(cat /tmp/nodikt-node.pid) && npm start -w server &
#   - 日志：server 的 pino 日志走 server/logs/app.log；tsc 与 node 的 stdout
#     重定向到 /tmp/nodikt-tsc.log 与 /tmp/nodikt-node.log，方便排查。
#   - 使用 `npm start -w server` 拉起 node，它带 --env-file-if-exists=../.env，
#     所以 server 进程会再次读一遍 .env（这里 source 主要是给 vite/tsc 用）。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  echo "[start-dev] loading .env"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
else
  echo "[start-dev] no .env found, using process environment only"
fi

TSC_LOG=/tmp/nodikt-tsc.log
NODE_LOG=/tmp/nodikt-node.log
TSC_PID_FILE=/tmp/nodikt-tsc.pid
NODE_PID_FILE=/tmp/nodikt-node.pid

echo "[start-dev] initial server build"
npm run build -w server

echo "[start-dev] starting tsc --watch (log: $TSC_LOG)"
npm run dev -w server > "$TSC_LOG" 2>&1 &
TSC_PID=$!
echo "$TSC_PID" > "$TSC_PID_FILE"

echo "[start-dev] starting node dist/index.js (log: $NODE_LOG)"
npm start -w server > "$NODE_LOG" 2>&1 &
NODE_PID=$!
echo "$NODE_PID" > "$NODE_PID_FILE"

cleanup() {
  echo
  echo "[start-dev] shutting down (tsc=$TSC_PID node=$NODE_PID)"
  kill "$TSC_PID" "$NODE_PID" 2>/dev/null || true
  wait "$TSC_PID" "$NODE_PID" 2>/dev/null || true
  rm -f "$TSC_PID_FILE" "$NODE_PID_FILE"
}
trap cleanup EXIT INT TERM

echo "[start-dev] tsc=$TSC_PID  node=$NODE_PID"
echo "[start-dev] starting vite dev (web :${WEB_PORT:-12400}). Ctrl+C 退出整条链路。"
echo
npm run dev:web
