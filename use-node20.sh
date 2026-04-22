#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$PROJECT_ROOT/.tooling/node-current/bin"

if [[ ! -x "$NODE_BIN/node" ]]; then
  echo "Local Node 20 is not installed at $NODE_BIN" >&2
  exit 1
fi

export PATH="$NODE_BIN:$PATH"
exec "$@"
