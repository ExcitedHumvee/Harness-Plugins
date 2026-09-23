#!/usr/bin/env bash
# Stop the faster-whisper sidecar (macOS / Linux).
#
# The plugin never stops the sidecar on its own — reloading the DSH profile
# re-composes plugins, and a model that reloads on every patch would be worse
# than an idle process — so this is the explicit way to reclaim the memory.
set -euo pipefail

PORT="${DSH_STT_PORT:-8124}"

if ! command -v lsof >/dev/null 2>&1; then
  echo "lsof is not available; find the sidecar process and kill it manually:" >&2
  echo "  pgrep -af stt_server.py" >&2
  exit 1
fi

PIDS="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN || true)"
if [ -z "$PIDS" ]; then
  echo "Nothing is listening on port $PORT."
  exit 0
fi

# shellcheck disable=SC2086
kill $PIDS
echo "Sidecar stopped (pid: $PIDS)."
