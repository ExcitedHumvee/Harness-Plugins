#!/usr/bin/env bash
# Install the faster-whisper sidecar for the DSH STT plugin (macOS / Linux).
#
# Creates a self-contained Python 3.11 virtualenv in `stt/.venv` using a
# standalone `uv` (so no system Python is needed), installs `faster-whisper`,
# then downloads the model weights into `stt/.models` and decodes one clip.
# Everything after this runs offline.
#
# Usage:
#   bash stt/server/setup.sh
#   bash stt/server/setup.sh --skip-warmup     # install only, fetch weights later
#   bash stt/server/setup.sh --model tiny      # smallest/fastest weights
#   bash stt/server/setup.sh --model small     # better accuracy, ~3x slower here
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SERVER_DIR")"
TOOLS_DIR="$ROOT/.tools"
VENV_DIR="$ROOT/.venv"
UV="$TOOLS_DIR/uv"
PYTHON="${PYTHON:-3.11}"
MODEL="${DSH_STT_MODEL:-base}"
SKIP_WARMUP=0

for arg in "$@"; do
  case "$arg" in
    --skip-warmup) SKIP_WARMUP=1 ;;
    --model) shift; MODEL="${1:-base}" ;;
    --model=*) MODEL="${arg#--model=}" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }

# ── 1. uv ────────────────────────────────────────────────────────────────────
if [ ! -x "$UV" ]; then
  step "installing uv into $TOOLS_DIR"
  mkdir -p "$TOOLS_DIR"
  curl -fsSL https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$TOOLS_DIR" sh
  UV="$TOOLS_DIR/uv"
fi
"$UV" --version

# ── 2. virtualenv ────────────────────────────────────────────────────────────
if [ ! -x "$VENV_DIR/bin/python" ]; then
  step "creating the virtualenv at $VENV_DIR"
  "$UV" venv --python "$PYTHON" "$VENV_DIR"
fi
PY="$VENV_DIR/bin/python"
"$PY" --version

# ── 3. faster-whisper ────────────────────────────────────────────────────────
step "installing faster-whisper (CTranslate2 + PyAV are the large part)"
"$UV" pip install --python "$PY" faster-whisper
"$PY" -c "import faster_whisper, ctranslate2, av; print('faster-whisper', faster_whisper.__version__, '| ctranslate2', ctranslate2.__version__, '| av', av.__version__)"

# ── 4. weights + smoke test ──────────────────────────────────────────────────
if [ "$SKIP_WARMUP" = "0" ]; then
  step "downloading the '$MODEL' weights into stt/.models and decoding a test clip"
  "$PY" "$SERVER_DIR/warmup.py" --model "$MODEL"
fi

printf '\n\033[32mDone. Start the sidecar with:\033[0m\n  bash %s/start.sh\n' "$SERVER_DIR"
echo "The plugin also starts it automatically when DSH loads the plugin."
