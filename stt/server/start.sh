#!/usr/bin/env bash
# Start the faster-whisper sidecar for the DSH STT plugin (macOS / Linux).
#
# Detached by default, logging to stt/server/server.log. The plugin starts the
# sidecar automatically when DSH loads it; this script is for starting it by hand
# or for watching the log.
#
# Usage:
#   bash stt/server/start.sh              # background, logs to server.log
#   bash stt/server/start.sh --foreground # keep the log on this terminal
#   bash stt/server/start.sh --model base --language en
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SERVER_DIR")"
PY="$ROOT/.venv/bin/python"
SCRIPT="$SERVER_DIR/stt_server.py"
LOG="$SERVER_DIR/server.log"
PORT="${DSH_STT_PORT:-8124}"
FOREGROUND=0
MODEL=""
LANGUAGE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --foreground|-f) FOREGROUND=1 ;;
    --model) shift; MODEL="${1:-}" ;;
    --language) shift; LANGUAGE="${1:-}" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -x "$PY" ] || { echo "The sidecar virtualenv is missing. Run: bash $SERVER_DIR/setup.sh" >&2; exit 1; }

# Any answer on /health means it is already up — including 503 while loading.
if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 \
   || curl -sS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "Sidecar already listening on 127.0.0.1:$PORT"
  curl -sS "http://127.0.0.1:$PORT/health" || true
  echo
  exit 0
fi

export DSH_STT_PORT="$PORT"
[ -z "$MODEL" ] || export DSH_STT_MODEL="$MODEL"
[ -z "$LANGUAGE" ] || export DSH_STT_LANGUAGE="$LANGUAGE"

if [ "$FOREGROUND" = "1" ]; then
  echo "Starting sidecar on 127.0.0.1:$PORT (Ctrl+C to stop)"
  exec "$PY" "$SCRIPT"
fi

cd "$ROOT"
nohup "$PY" "$SCRIPT" >>"$LOG" 2>&1 &
echo "Started sidecar (pid $!) on http://127.0.0.1:$PORT"
echo "Log: $LOG"
echo "The model reports ready at http://127.0.0.1:$PORT/health once the weights are loaded."
