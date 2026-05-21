#!/usr/bin/env bash
# Nodikt 一键启动脚本
#   - 首次跑：检查环境 + npm install + 复制配置模板 + build + 启动
#   - 二次跑：直接启动（跳过已完成的步骤）
#
# 用法：
#   bash start.sh           # 启动（自动检测是否需要 install/build）
#   bash start.sh stop      # 停止后台进程
#   bash start.sh status    # 查看运行中的 PID/端口/日志
#   bash start.sh logs      # 实时跟随日志
#   bash start.sh restart   # 停 + 启
#   bash start.sh reinstall # 强制重新 install + build

set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(pwd)"
RUN_DIR="$REPO_ROOT/.run"
mkdir -p "$RUN_DIR"

# 加载 .env（如存在），让 SERVER_PORT / WEB_PORT 等被 shell 和后续子进程看到。
# 首次运行 .env 还没生成时跳过，走默认值。
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PORT_SERVER="${SERVER_PORT:-3001}"
PORT_WEB="${WEB_PORT:-12400}"
# 显式导出，确保 npm start / npm run dev:web 等子进程读得到（vite.config.ts 用）
export SERVER_PORT="$PORT_SERVER"
export WEB_PORT="$PORT_WEB"

C_GREEN=$'\033[0;32m'
C_YELLOW=$'\033[0;33m'
C_RED=$'\033[0;31m'
C_DIM=$'\033[0;90m'
C_RESET=$'\033[0m'
say()  { printf "%s%s%s\n" "$C_GREEN" "$1" "$C_RESET"; }
warn() { printf "%s%s%s\n" "$C_YELLOW" "$1" "$C_RESET"; }
err()  { printf "%s%s%s\n" "$C_RED" "$1" "$C_RESET" >&2; }
dim()  { printf "%s%s%s\n" "$C_DIM" "$1" "$C_RESET"; }

# 端口 → PID 列表（去重换行分隔）。轮流试 lsof / fuser / ss / netstat，谁先成功用谁的输出。
# 容器环境经常缺 lsof，必须兜底，否则端口检测会"静默成功"放出 EADDRINUSE。
port_pids() {
  local port="$1" pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  fi
  if [[ -z "$pids" ]] && command -v fuser >/dev/null 2>&1; then
    # fuser 把 PID 写到 stdout（旧版本可能写 stderr），结果含前导空格 / 制表符
    pids=$(fuser "${port}"/tcp 2>/dev/null | tr -s '[:space:]' '\n' | grep -E '^[0-9]+$' || true)
  fi
  if [[ -z "$pids" ]] && command -v ss >/dev/null 2>&1; then
    pids=$(ss -tlnpH 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $NF}' \
      | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)
  fi
  if [[ -z "$pids" ]] && command -v netstat >/dev/null 2>&1; then
    pids=$(netstat -tlnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $NF}' \
      | cut -d/ -f1 | grep -E '^[0-9]+$' | sort -u || true)
  fi
  printf "%s" "$pids"
}

stop_running() {
  local stopped=0
  for name in server web; do
    local pid_file="$RUN_DIR/$name.pid"
    if [[ -f "$pid_file" ]]; then
      local pid
      pid="$(cat "$pid_file" 2>/dev/null || echo "")"
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        say "停止 $name (PID $pid)"
        kill "$pid" 2>/dev/null || true
        sleep 0.5
        kill -9 "$pid" 2>/dev/null || true
        stopped=1
      fi
      rm -f "$pid_file"
    fi
  done
  for port in "$PORT_SERVER" "$PORT_WEB"; do
    local pids
    pids="$(port_pids "$port")"
    if [[ -n "$pids" ]]; then
      warn "端口 $port 仍有进程占用：$pids → 清理"
      echo "$pids" | xargs -r kill 2>/dev/null || true
      sleep 0.5
      echo "$pids" | xargs -r kill -9 2>/dev/null || true
      stopped=1
    fi
  done
  if [[ $stopped -eq 0 ]]; then
    dim "(没有运行中的 Nodikt 进程)"
  fi
}

show_status() {
  for name in server web; do
    local pid_file="$RUN_DIR/$name.pid"
    if [[ -f "$pid_file" ]]; then
      local pid
      pid="$(cat "$pid_file" 2>/dev/null || echo "")"
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        say "$name: PID $pid 运行中 (log: $RUN_DIR/$name.log)"
      else
        warn "$name: PID 文件存在但进程已退出 ($pid_file)"
      fi
    else
      dim "$name: 未启动"
    fi
  done
  echo
  dim "端口占用："
  for port in "$PORT_SERVER" "$PORT_WEB"; do
    local pids
    pids="$(port_pids "$port")"
    if [[ -n "$pids" ]]; then
      printf "  :%-5s → %s\n" "$port" "$pids"
    else
      dim "  :$port → 空闲"
    fi
  done
}

tail_logs() {
  local files=()
  [[ -f "$RUN_DIR/server.log" ]] && files+=("$RUN_DIR/server.log")
  [[ -f "$RUN_DIR/web.log" ]]    && files+=("$RUN_DIR/web.log")
  if [[ ${#files[@]} -eq 0 ]]; then
    warn "还没有日志文件 — 先启动一次再 logs"
    exit 1
  fi
  exec tail -F "${files[@]}"
}

# ----------------------------------------------------------------
# 子命令
# ----------------------------------------------------------------
case "${1:-up}" in
  stop)    stop_running; exit 0 ;;
  status)  show_status; exit 0 ;;
  logs)    tail_logs ;;
  restart) stop_running; sleep 1; set -- up ;;
  reinstall)
    say "强制重新安装：删除 node_modules 与 server/dist"
    rm -rf node_modules server/dist server/dist-test web/dist
    set -- up
    ;;
  up|"") ;;
  *) err "未知子命令：$1"; echo "用法: bash start.sh [stop|status|logs|restart|reinstall]"; exit 2 ;;
esac

# ----------------------------------------------------------------
# 启动主流程
# ----------------------------------------------------------------

# 1) Node 20+
if ! command -v node >/dev/null 2>&1; then
  err "Node.js 未安装。需要 >= 20。https://nodejs.org 或 nvm install 20.20.1"
  exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  err "Node.js 版本太低：$(node -v) — 需要 >= 20"
  exit 1
fi
dim "✓ Node $(node -v)"

# 2) Claude Code CLI 检测（可选 — 用户可在 .env 里指定路径）
if ! command -v claude >/dev/null 2>&1; then
  warn "未在 PATH 找到 claude CLI"
  warn "  → 如果你打算让 Nodikt 调用 Claude Code，请先安装："
  warn "      npm install -g @anthropic-ai/claude-code"
  warn "    或在 .env 里设置 CLAUDE_CODE_INSTALL_ROOT 指向已有安装路径"
  warn "  → 安装完后第一次需要 \`claude login\`（或让 CLAUDE_CODE_RUNTIME_HOME 指向已登录的 HOME）"
else
  dim "✓ claude $(claude --version 2>/dev/null | head -1 || echo '(version unknown)')"
fi

# 3) npm install — 仅当 node_modules 不存在或 lockfile 比 node_modules 新
need_install=0
if [[ ! -d node_modules ]]; then
  need_install=1
elif [[ -f package-lock.json ]] && [[ package-lock.json -nt node_modules ]]; then
  need_install=1
fi
if [[ $need_install -eq 1 ]]; then
  say "安装依赖 (npm install) ..."
  npm install
else
  dim "✓ node_modules 已存在且最新，跳过 npm install"
fi

# 4) 复制配置模板（仅当目标文件不存在）
if [[ ! -f .env ]]; then
  cp .env.example .env
  warn ".env 已创建 — 按需修改 CLAUDE_CODE_RUNTIME_HOME / CLAUDE_CODE_PERMISSION_MODE 等"
fi
if [[ ! -f server/data/settings.json ]]; then
  if [[ -f server/data/settings.example.json ]]; then
    cp server/data/settings.example.json server/data/settings.json
    warn "server/data/settings.json 已创建 — 务必填以下字段后再启动："
    warn "  1) models.{primary,planner,verifier,ops_backup}.api_key  ← 你的 LLM key"
    warn "  2) workspace_root  ← 本机 server/workspace 的绝对路径（或任意你想要的目录）"
    warn ""
    warn "编辑完后再次 bash start.sh 即可。这次先退出。"
    exit 0
  else
    err "缺少 server/data/settings.example.json — 仓库不完整？"
    exit 1
  fi
fi

# 5) build — 当 dist 不存在或源文件比 dist 新时重新编译
need_build=0
if [[ ! -f server/dist/index.js ]]; then
  need_build=1
elif [[ -n "$(find server/src -newer server/dist/index.js -type f 2>/dev/null | head -1)" ]]; then
  need_build=1
fi
if [[ $need_build -eq 1 ]]; then
  say "编译 server (npm run build -w server) ..."
  npm run build -w server
else
  dim "✓ server/dist 已是最新，跳过 build"
fi

# 6) 端口检查
for port in "$PORT_SERVER" "$PORT_WEB"; do
  pids="$(port_pids "$port")"
  if [[ -n "$pids" ]]; then
    warn "端口 $port 已被占用 (PID: $pids) — 先 bash start.sh stop 或 restart"
    exit 1
  fi
done

# 7) 启动 server，等 health 通过再起 web
say "启动 server (:$PORT_SERVER) ..."
( cd "$REPO_ROOT" && nohup npm start -w server > "$RUN_DIR/server.log" 2>&1 & echo $! > "$RUN_DIR/server.pid" )
SERVER_PID="$(cat "$RUN_DIR/server.pid")"

for i in {1..30}; do
  if curl -fsS "http://localhost:$PORT_SERVER/api/demands" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    err "server 进程已退出 — 查看日志：$RUN_DIR/server.log"
    tail -20 "$RUN_DIR/server.log" >&2 || true
    exit 1
  fi
  sleep 1
done

say "启动 web (:$PORT_WEB) ..."
( cd "$REPO_ROOT" && nohup npm run dev:web > "$RUN_DIR/web.log" 2>&1 & echo $! > "$RUN_DIR/web.pid" )
WEB_PID="$(cat "$RUN_DIR/web.pid")"

echo
say "Nodikt 启动完成"
echo "  Server: http://localhost:$PORT_SERVER  (PID $SERVER_PID, log $RUN_DIR/server.log)"
echo "  Web:    http://localhost:$PORT_WEB  (PID $WEB_PID, log $RUN_DIR/web.log)"
echo
dim "查看日志：bash start.sh logs"
dim "停止：    bash start.sh stop"
dim "重启：    bash start.sh restart"
