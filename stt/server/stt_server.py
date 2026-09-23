#!/usr/bin/env python3
"""
Local faster-whisper STT sidecar for the DSH STT plugin.

Why a sidecar: faster-whisper is a CTranslate2/PyAV Python stack, and the DSH Web
GUI is a browser app that cannot run it. This process owns the model, keeps it
resident, and exposes two plain HTTP endpoints on loopback. The browser half of
the plugin (`lib/client.js`) records the microphone and calls them directly — the
audio never leaves the machine, and no cloud API is involved.

    GET  /health      -> {"status": "loading"|"ready"|"error", ...}
    POST /transcribe  -> raw audio bytes (webm/ogg/wav/mp4/...) -> JSON transcript
    GET  /            -> a small page for recording and transcribing in a browser tab

The POST body is the recorded audio exactly as the browser produced it; the
container type comes from `X-DSH-STT-Mime` (falling back to `Content-Type`), and
the per-request knobs from `X-DSH-STT-*` headers:

    X-DSH-STT-Mime      audio/webm;codecs=opus   container of the body
    X-DSH-STT-Language  auto                     ISO code, or "auto" to detect
    X-DSH-STT-Task      transcribe               transcribe | translate (to English)
    X-DSH-STT-Beam      5                        beam size
    X-DSH-STT-Vad       1                        strip silence with the VAD filter
    X-DSH-STT-Prompt    (empty)                  initial prompt (names, jargon)

Endpoints carry permissive CORS headers because the caller is the DSH page on
`http://127.0.0.1:3080`, a different origin from this server. The server binds
127.0.0.1 only, so it is not reachable from the network.

Configuration is by environment variable; every one has a working default:

    DSH_STT_HOST        127.0.0.1     bind address
    DSH_STT_PORT        8124          bind port
    DSH_STT_MODEL       base          any faster-whisper name: tiny, base, small,
                                      medium, large-v3, large-v3-turbo, distil-*.
                                      Measured on a 15 W laptop CPU: tiny ~1.1 s,
                                      base ~1.9 s, small ~6 s per utterance, all
                                      three transcribing the test clip correctly,
                                      so the default trades a little accuracy for
                                      a lot of latency.
    DSH_STT_DEVICE      auto          auto | cpu | cuda
    DSH_STT_COMPUTE_TYPE (auto)       auto | int8 | int8_float16 | float16 | float32
    DSH_STT_LANGUAGE    (empty)       default language; empty means auto-detect
    DSH_STT_TASK        transcribe    default task
    DSH_STT_BEAM_SIZE   5             default beam size
    DSH_STT_VAD         1             default VAD filter setting
    DSH_STT_PROMPT      (empty)       default initial prompt
    DSH_STT_CACHE       <plugin>/.models   where the weights live
    DSH_STT_OFFLINE     auto          auto = use the local weights, download only
                                      if they are missing; 1 = never touch the
                                      network; 0 = allow hub lookups every start
    DSH_STT_MAX_BYTES   26214400      reject larger uploads (25 MB)
    DSH_STT_WARMUP      1             decode a tone at startup so the first real
                                      request is not the slow one

Usage:  .venv/Scripts/python.exe server/stt_server.py
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The cache lives inside the checkout on most machines, where the Hugging Face
# hub cannot create symlinks without a Windows privilege a normal shell lacks. It
# still works; the warning is noise, and it would otherwise land in server.log on
# every load.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

HOST = os.environ.get("DSH_STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("DSH_STT_PORT", "8124"))
MODEL_NAME = os.environ.get("DSH_STT_MODEL", "base").strip() or "base"
DEVICE_PREF = os.environ.get("DSH_STT_DEVICE", "auto").strip().lower() or "auto"
COMPUTE_PREF = os.environ.get("DSH_STT_COMPUTE_TYPE", "").strip().lower()
LANGUAGE_DEFAULT = os.environ.get("DSH_STT_LANGUAGE", "").strip()
TASK_DEFAULT = os.environ.get("DSH_STT_TASK", "transcribe").strip().lower() or "transcribe"
BEAM_DEFAULT = int(os.environ.get("DSH_STT_BEAM_SIZE", "5"))
VAD_DEFAULT = os.environ.get("DSH_STT_VAD", "1").strip() != "0"
PROMPT_DEFAULT = os.environ.get("DSH_STT_PROMPT", "")
OFFLINE = os.environ.get("DSH_STT_OFFLINE", "auto").strip().lower() or "auto"
MAX_BYTES = int(os.environ.get("DSH_STT_MAX_BYTES", str(25 * 1024 * 1024)))
WARMUP = os.environ.get("DSH_STT_WARMUP", "1").strip() != "0"
PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.environ.get("DSH_STT_CACHE", "").strip() or os.path.join(PLUGIN_ROOT, ".models")

# Container extension per MIME type, so PyAV can sniff the stream by suffix when
# the browser sends something it cannot identify from the bytes alone.
EXTENSIONS = {
    "audio/webm": ".webm",
    "video/webm": ".webm",
    "audio/ogg": ".ogg",
    "application/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/wave": ".wav",
    "audio/x-wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".mp4",
    "audio/m4a": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
    "audio/aac": ".aac",
}

# Whisper language codes are two or three letters; anything else is a client bug.
LANGUAGE_RE = re.compile(r"^[a-z]{2,3}$")

_LOCK = threading.Lock()
_STATE: dict = {
    "status": "starting",
    "detail": "",
    "model": None,
    "device": DEVICE_PREF,
    "computeType": COMPUTE_PREF or "auto",
    "kind": MODEL_NAME,
    "offline": OFFLINE,
    "loadSeconds": None,
    "modelSeconds": None,
    "transcriptions": 0,
    "audioSeconds": 0.0,
    "transcribeSeconds": 0.0,
    "lastLanguage": None,
}


def log(message: str) -> None:
    """Timestamped line to stdout, flushed so a redirected log stays live."""
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def resolve_device() -> str:
    """Pick an inference device without importing torch: CTranslate2 knows."""
    if DEVICE_PREF in ("cpu", "cuda"):
        return DEVICE_PREF
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception:  # probing must never be fatal: CPU always works
        pass
    return "cpu"


def resolve_compute_type(device: str) -> str:
    """int8 on CPU and float16 on CUDA, unless the environment says otherwise."""
    if COMPUTE_PREF:
        return COMPUTE_PREF
    return "float16" if device == "cuda" else "int8"


def load_model() -> None:
    """Load the weights into `_STATE`, in a background thread."""
    started = time.time()
    try:
        from faster_whisper import WhisperModel

        device = resolve_device()
        compute_type = resolve_compute_type(device)
        os.makedirs(CACHE_DIR, exist_ok=True)
        _STATE["device"] = device
        _STATE["computeType"] = compute_type
        _STATE["offline"] = OFFLINE

        # Offline-first: the weights are already on disk after setup, so the
        # default path touches no network at all. "auto" only reaches for the hub
        # when the local copy is missing; "1" refuses to reach for it at all.
        strict = OFFLINE in ("1", "true", "yes", "on")
        log(f"loading faster-whisper '{MODEL_NAME}' on {device} ({compute_type}), cache: {CACHE_DIR}")

        def build(local_only: bool):
            return WhisperModel(
                MODEL_NAME,
                device=device,
                compute_type=compute_type,
                download_root=CACHE_DIR,
                local_files_only=local_only,
            )

        try:
            model = build(local_only=True)
        except Exception as missing:  # weights are not cached yet
            if strict:
                raise
            log(f"no local weights yet ({type(missing).__name__}); downloading {MODEL_NAME} once")
            model = build(local_only=False)

        _STATE["model"] = model
        _STATE["status"] = "ready"
        _STATE["loadSeconds"] = round(time.time() - started, 1)
        log(f"model ready in {_STATE['loadSeconds']}s (device={device}, compute={compute_type})")

        if WARMUP:
            warmup()
    except Exception as error:  # surface the failure through /health
        _STATE["status"] = "error"
        _STATE["detail"] = f"{type(error).__name__}: {error}"
        log(f"model load failed: {_STATE['detail']}")


def tone_wav(seconds: float = 1.0, rate: int = 16000, frequency: float = 440.0) -> str:
    """Write a short sine wave to a temp file and return its path.

    A warmup has to decode real audio to be worth anything, and a generated tone
    needs no sample file shipped in the repository.
    """
    import array
    import math
    import wave

    samples = array.array("h")
    for index in range(int(seconds * rate)):
        samples.append(int(12000 * math.sin(2 * math.pi * frequency * index / rate)))
    handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    handle.close()
    with wave.open(handle.name, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(samples.tobytes())
    return handle.name


def warmup() -> None:
    """Decode a tone so the first real request is not also the first slow one."""
    path = None
    try:
        started = time.time()
        path = tone_wav()
        with _LOCK:
            segments, _info = _STATE["model"].transcribe(path, beam_size=1, vad_filter=False)
            list(segments)  # a generator: the decode happens as it is consumed
        log(f"warmup decode took {round(time.time() - started, 1)}s")
    except Exception as error:
        log(f"warmup failed (ignored): {type(error).__name__}: {error}")
    finally:
        if path is not None and os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass


def transcribe(path: str, options: dict) -> dict:
    """Run one transcription and return plain JSON-able values."""
    model = _STATE["model"]
    started = time.time()

    kwargs = {
        "language": options["language"],
        "task": options["task"],
        "beam_size": options["beam_size"],
        "vad_filter": options["vad"],
        "vad_parameters": {"min_silence_duration_ms": 500, "speech_pad_ms": 200},
        "condition_on_previous_text": False,  # a dictated clip is not a paragraph chain
    }
    if options["prompt"]:
        kwargs["initial_prompt"] = options["prompt"]

    with _LOCK:
        segments, info = model.transcribe(path, **kwargs)
        pieces = []
        for segment in segments:
            text = str(segment.text).strip()
            if text:
                pieces.append({"start": round(segment.start, 2), "end": round(segment.end, 2), "text": text})

    elapsed = round(time.time() - started, 2)
    audio_seconds = round(float(getattr(info, "duration", 0.0) or 0.0), 2)
    return {
        "text": " ".join(piece["text"] for piece in pieces).strip(),
        "language": getattr(info, "language", None),
        "languageProbability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 3),
        "duration": audio_seconds,
        "durationAfterVad": round(float(getattr(info, "duration_after_vad", 0.0) or 0.0), 2),
        "elapsed": elapsed,
        "realtimeFactor": round(audio_seconds / elapsed, 2) if elapsed > 0 else None,
        "segments": pieces,
    }


def parse_header_number(value: str | None, fallback: int, low: int, high: int) -> int:
    """Read an integer request knob, clamped; a bad value falls back silently."""
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return fallback
    return min(high, max(low, parsed))


class Handler(BaseHTTPRequestHandler):
    """Minimal JSON HTTP surface with CORS for the DSH page."""

    server_version = "dsh-stt/1.0"
    # The default HTTP/1.0 behaviour (close after each response) is deliberate:
    # a rejected oversized upload must not leave an unread body on a kept-alive
    # connection, and one transcription per connection costs nothing here.

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - stdlib signature
        """Route the stdlib access log through our timestamped logger."""
        log(f"{self.address_string()} {fmt % args}")

    # ── helpers ──────────────────────────────────────────────────────────────
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type, x-dsh-stt-mime, x-dsh-stt-language, x-dsh-stt-task, x-dsh-stt-beam, x-dsh-stt-vad, x-dsh-stt-prompt")
        self.send_header("Access-Control-Max-Age", "600")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the browser aborted; nothing left to answer

    def _html(self, body: bytes) -> None:
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _health(self) -> dict:
        return {
            "status": _STATE["status"],
            "detail": _STATE["detail"],
            "model": f"faster-whisper {_STATE['kind']}",
            "kind": _STATE["kind"],
            "device": _STATE["device"],
            "computeType": _STATE["computeType"],
            "offline": _STATE["offline"],
            "cache": CACHE_DIR,
            "language": LANGUAGE_DEFAULT or "auto",
            "task": TASK_DEFAULT,
            "beamSize": BEAM_DEFAULT,
            "vad": VAD_DEFAULT,
            "loadSeconds": _STATE["loadSeconds"],
            "transcriptions": _STATE["transcriptions"],
            "audioSeconds": round(_STATE["audioSeconds"], 1),
            "transcribeSeconds": round(_STATE["transcribeSeconds"], 1),
            "lastLanguage": _STATE["lastLanguage"],
        }

    # ── routes ───────────────────────────────────────────────────────────────
    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib signature
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - stdlib signature
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._json(200 if _STATE["status"] != "error" else 503, self._health())
            return
        if path in ("/", "/index.html"):
            self._html(INDEX_HTML.replace("__STATUS__", json.dumps(self._health())).encode("utf-8"))
            return
        self._json(404, {"error": "not found", "paths": ["/", "/health", "/transcribe"]})

    def do_POST(self) -> None:  # noqa: N802 - stdlib signature
        if self.path.split("?", 1)[0] != "/transcribe":
            self._json(404, {"error": "not found", "paths": ["/", "/health", "/transcribe"]})
            return

        if _STATE["status"] != "ready":
            self._json(503, self._health())
            return

        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        if length <= 0:
            self._json(400, {"error": "expected recorded audio in the request body"})
            return
        if length > MAX_BYTES:
            self._json(413, {"error": f"body is {length} bytes; the limit is {MAX_BYTES}"})
            return

        try:
            body = self.rfile.read(length)
        except (ConnectionResetError, BrokenPipeError):
            return

        mime = (self.headers.get("X-DSH-STT-Mime") or self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if mime in ("application/json", "text/plain", ""):
            parsed = parse_json_body(body)
            if parsed is None:
                self._json(400, {"error": f"unrecognised body: send raw audio with X-DSH-STT-Mime, not {mime or 'an empty content type'}"})
                return
            body, mime = parsed

        language = (self.headers.get("X-DSH-STT-Language") or LANGUAGE_DEFAULT or "").strip().lower()
        if language in ("", "auto", "detect"):
            language = None
        elif LANGUAGE_RE.match(language) is None:
            self._json(400, {"error": f"unsupported language tag: {language}"})
            return

        task = (self.headers.get("X-DSH-STT-Task") or TASK_DEFAULT).strip().lower()
        if task not in ("transcribe", "translate"):
            self._json(400, {"error": f"unsupported task: {task}"})
            return

        options = {
            "language": language,
            "task": task,
            "beam_size": parse_header_number(self.headers.get("X-DSH-STT-Beam"), BEAM_DEFAULT, 1, 10),
            "vad": (self.headers.get("X-DSH-STT-Vad") or ("1" if VAD_DEFAULT else "0")).strip() != "0",
            "prompt": (self.headers.get("X-DSH-STT-Prompt") or PROMPT_DEFAULT).strip(),
        }

        path = write_temp_audio(body, mime)
        if path is None:
            self._json(500, {"error": "could not buffer the upload on disk"})
            return

        try:
            result = transcribe(path, options)
        except Exception as error:  # a failed clip must not kill the server
            log(f"transcription failed: {type(error).__name__}: {error}")
            self._json(500, {"error": f"{type(error).__name__}: {error}"})
            return
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

        _STATE["transcriptions"] += 1
        _STATE["audioSeconds"] += result["duration"]
        _STATE["transcribeSeconds"] += result["elapsed"]
        _STATE["lastLanguage"] = result["language"]
        log(
            f"transcribed {result['duration']}s of audio in {result['elapsed']}s "
            f"(x{result['realtimeFactor']} realtime, lang={result['language']}, {len(result['text'])} chars)"
        )
        result["engine"] = _STATE["kind"]
        result["device"] = _STATE["device"]
        result["computeType"] = _STATE["computeType"]
        self._json(200, result)


def parse_json_body(body: bytes) -> tuple[bytes, str] | None:
    """Decode the optional JSON form `{"audioBase64": …, "mime": …}`."""
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    encoded = payload.get("audioBase64") or payload.get("audio")
    if not isinstance(encoded, str) or encoded.strip() == "":
        return None
    try:
        audio = base64.b64decode(encoded, validate=False)
    except Exception:
        return None
    mime = str(payload.get("mime") or payload.get("mimeType") or "audio/webm").split(";")[0].strip().lower()
    return audio, mime


def write_temp_audio(body: bytes, mime: str) -> str | None:
    """Buffer an upload in a temp file with a suffix PyAV can key off."""
    suffix = EXTENSIONS.get(mime, ".webm")
    try:
        handle = tempfile.NamedTemporaryFile(suffix=suffix, prefix="dsh-stt-", delete=False)
        with handle:
            handle.write(body)
        return handle.name
    except OSError as error:
        log(f"could not write the upload: {error}")
        return None


INDEX_HTML = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DSH STT sidecar</title>
    <style>
      body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 44rem; color: #111; }
      button { font: inherit; padding: .4rem 1rem; }
      .row { display: flex; gap: .5rem; align-items: center; margin: 1rem 0; }
      textarea { width: 100%; height: 8rem; font: inherit; }
      pre { background: #f4f4f5; padding: .75rem; border-radius: 6px; overflow: auto; }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: #bbb; display: inline-block; }
      .dot.live { background: #d33; }
    </style>
  </head>
  <body>
    <h1>DSH STT sidecar</h1>
    <pre id="health">__STATUS__</pre>
    <div class="row">
      <button id="go">Record</button>
      <span class="dot" id="dot"></span>
      <span id="state">idle</span>
    </div>
    <textarea id="text" placeholder="The transcript appears here."></textarea>
    <script>
      const health = document.getElementById("health");
      const dot = document.getElementById("dot");
      const state = document.getElementById("state");
      const text = document.getElementById("text");
      const go = document.getElementById("go");
      const refresh = async () => {
        try { health.textContent = JSON.stringify(await (await fetch("/health")).json(), null, 2); }
        catch (error) { health.textContent = String(error); }
      };
      refresh();
      setInterval(refresh, 5000);

      let recorder = null;
      let chunks = [];
      go.addEventListener("click", async () => {
        if (recorder !== null) { recorder.stop(); return; }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
          .find((type) => MediaRecorder.isTypeSupported(type)) || "";
        chunks = [];
        recorder = new MediaRecorder(stream, mime === "" ? undefined : { mimeType: mime });
        recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
        recorder.onstop = async () => {
          stream.getTracks().forEach((track) => track.stop());
          recorder = null;
          dot.className = "dot";
          go.textContent = "Record";
          state.textContent = "transcribing…";
          const type = chunks[0]?.type || mime || "audio/webm";
          const response = await fetch("/transcribe", {
            method: "POST",
            headers: { "content-type": type, "x-dsh-stt-mime": type },
            body: new Blob(chunks, { type }),
          });
          const payload = await response.json();
          state.textContent = response.ok
            ? `done in ${payload.elapsed}s (${payload.language}, x${payload.realtimeFactor} realtime)`
            : `error: ${payload.error || response.status}`;
          if (response.ok) text.value = payload.text;
          refresh();
        };
        recorder.start(250);
        dot.className = "dot live";
        go.textContent = "Stop";
        state.textContent = "recording…";
      });
    </script>
  </body>
</html>
"""


def main() -> int:
    log(f"dsh-stt sidecar: model={MODEL_NAME} device={DEVICE_PREF} offline={OFFLINE} cache={CACHE_DIR}")
    threading.Thread(target=load_model, name="model-load", daemon=True).start()

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f"listening on http://{HOST}:{PORT} (health: /health)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("stopping")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
