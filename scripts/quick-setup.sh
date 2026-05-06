#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST="${JELLYTUBE_HOST:-0.0.0.0}"
PORT="${JELLYTUBE_PORT:-4173}"
RUNTIME_DIR="${JELLYTUBE_RUNTIME_DIR:-$ROOT_DIR/.jellytube}"
PID_FILE="${JELLYTUBE_PID_FILE:-$RUNTIME_DIR/jellytube.pid}"
LOG_FILE="${JELLYTUBE_LOG_FILE:-$RUNTIME_DIR/jellytube.log}"

mkdir -p "$RUNTIME_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required." >&2
  exit 1
fi

if ! node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 20 ? 0 : 1);'; then
  echo "Node.js 20 or newer is required. Found $(node --version)." >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
    echo "JellyTube is already running with PID $existing_pid."
    echo "URL: http://${HOST/#0.0.0.0/localhost}:$PORT"
    echo "Log: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

echo "Installing dependencies..."
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

echo "Building JellyTube..."
npm run build

touch "$LOG_FILE"
echo "Starting JellyTube detached..."
start_command=(
  env
  "JELLYTUBE_HOST=$HOST"
  "JELLYTUBE_PORT=$PORT"
  node
  scripts/serve-dist.mjs
)

if command -v setsid >/dev/null 2>&1; then
  nohup setsid "${start_command[@]}" >>"$LOG_FILE" 2>&1 </dev/null &
else
  nohup "${start_command[@]}" >>"$LOG_FILE" 2>&1 </dev/null &
fi

pid="$!"
echo "$pid" > "$PID_FILE"

sleep 1
if ! kill -0 "$pid" >/dev/null 2>&1; then
  echo "JellyTube failed to start. Recent log output:" >&2
  tail -40 "$LOG_FILE" >&2 || true
  rm -f "$PID_FILE"
  exit 1
fi

echo "JellyTube is running."
echo "URL: http://${HOST/#0.0.0.0/localhost}:$PORT"
echo "PID: $pid"
echo "Log: $LOG_FILE"
echo "Stop: kill \$(cat \"$PID_FILE\")"
