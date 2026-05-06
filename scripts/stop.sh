#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${JELLYTUBE_RUNTIME_DIR:-$ROOT_DIR/.jellytube}"
PID_FILE="${JELLYTUBE_PID_FILE:-$RUNTIME_DIR/jellytube.pid}"

if [[ ! -f "$PID_FILE" ]]; then
  echo "JellyTube is not running; no PID file found."
  exit 0
fi

pid="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
  rm -f "$PID_FILE"
  echo "Removed stale PID file."
  exit 0
fi

kill "$pid"
for _ in {1..20}; do
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    rm -f "$PID_FILE"
    echo "JellyTube stopped."
    exit 0
  fi
  sleep 0.2
done

echo "JellyTube did not stop within 4 seconds; PID $pid is still running." >&2
exit 1
