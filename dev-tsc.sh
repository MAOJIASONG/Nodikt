#!/usr/bin/env bash
# dev-tsc.sh — Terminal 1：server 增量编译
# 在 server 目录跑 tsc --watch，源码变动时增量重写 dist。
# 注意：tsc 只重新编译，不重启 node。改完 server/src 后要去 Terminal 2 Ctrl+C 再 ./dev-server.sh。

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "[dev-tsc] watching server/src → server/dist (Ctrl+C 退出)"
exec npm run dev -w server
