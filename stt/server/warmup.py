#!/usr/bin/env python3
"""
Download the faster-whisper weights and prove the pipeline works, without running
the HTTP server.

`setup.ps1` / `setup.sh` call this at the end of an install, so the first mic
click in the GUI is not also the first weight download. It is also the quickest
way to check the sidecar's dependencies after an upgrade:

    .venv/Scripts/python.exe server/warmup.py
    .venv/Scripts/python.exe server/warmup.py --file clip.webm --language en
    .venv/Scripts/python.exe server/warmup.py --model base --device cpu

With no `--file` it decodes a generated 1 kHz tone: silence carries no words, but
it exercises exactly the code path a real request takes (container demux, VAD,
mel, encode, decode), which is what a smoke test is for.
"""

from __future__ import annotations

import argparse
import os
import sys
import time

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Same reason as the server: the cache is inside the checkout, where the hub's
# symlink optimisation is unavailable and its warning is pure noise.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


def tone(path: str, seconds: float = 1.0, rate: int = 16000) -> None:
    """Write a short sine wave, so the warmup needs no sample file in the repo."""
    import array
    import math
    import wave

    samples = array.array("h")
    for index in range(int(seconds * rate)):
        samples.append(int(12000 * math.sin(2 * math.pi * 1000 * index / rate)))
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(samples.tobytes())


def main() -> int:
    parser = argparse.ArgumentParser(description="Load faster-whisper and transcribe one clip.")
    parser.add_argument("--model", default=os.environ.get("DSH_STT_MODEL", "base"))
    parser.add_argument("--device", default=os.environ.get("DSH_STT_DEVICE", "cpu"))
    parser.add_argument("--compute-type", default=os.environ.get("DSH_STT_COMPUTE_TYPE", "int8"))
    parser.add_argument("--cache", default=os.environ.get("DSH_STT_CACHE", os.path.join(PLUGIN_ROOT, ".models")))
    parser.add_argument("--file", default=None, help="transcribe this audio file instead of a generated tone")
    parser.add_argument("--language", default=None, help="ISO code; default detects")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    os.makedirs(args.cache, exist_ok=True)
    started = time.time()
    print(f"loading faster-whisper '{args.model}' on {args.device} ({args.compute_type}), cache: {args.cache}", flush=True)
    print("  the first run downloads the weights into that cache", flush=True)
    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            download_root=args.cache,
            local_files_only=True,
        )
        local = True
    except Exception as error:
        print(f"  no usable local copy ({type(error).__name__}); fetching from the hub once", flush=True)
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            download_root=args.cache,
            local_files_only=False,
        )
        local = False
    print(f"  loaded in {round(time.time() - started, 1)}s ({'local' if local else 'downloaded'})", flush=True)

    clip = args.file
    temporary = None
    if clip is None:
        import tempfile

        handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        handle.close()
        temporary = handle.name
        tone(temporary)
        clip = temporary

    try:
        started = time.time()
        segments, info = model.transcribe(
            clip,
            language=args.language,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        elapsed = time.time() - started
        duration = float(getattr(info, "duration", 0.0) or 0.0)
        factor = duration / elapsed if elapsed > 0 else 0.0
        print(f"  decoded {round(duration, 2)}s in {round(elapsed, 2)}s (x{round(factor, 2)} realtime)", flush=True)
        print(f"  detected language: {info.language} ({round(float(info.language_probability), 2)})", flush=True)
        print(f"  transcript: {text!r}", flush=True)
        if args.file is not None and text == "":
            print("  warning: a real clip produced no text — check the language and the model size", flush=True)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.remove(temporary)

    print("ok", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
