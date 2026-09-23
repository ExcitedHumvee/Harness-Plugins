# dsh-stt

A microphone button in the DSH composer that turns speech into text, using
**faster-whisper** running locally on this machine.

- **Where it lives:** the composer's trailing control row
  (`conversation.input.right`), left of the model picker and the send button.
- **What it does:** click to record, click again to stop — the clip is sent to a
  local sidecar, transcribed, and the text is inserted **at the cursor** in the
  composer.
- **You can see it hearing you:** while the microphone is open a pill appears
  beside the button with a live level meter, a red dot and the elapsed time, and
  it turns red with **No audio** if nothing arrives for two seconds. Right-click
  the button and press **Test microphone** to open the mic and meter it without
  recording anything.
- **Where the transcription comes from:** a local sidecar process on
  `127.0.0.1:8124` (see `server/`). Nothing leaves the machine: no audio, no text,
  no cloud API.
- **Right-click the button** for settings: engine status, input device, the level
  meter, language, task (transcribe / translate to English), insertion mode,
  silence filter, timing, and a diagnostics block.

## If it looks like nothing is happening

Work down this list; the UI tells you which step failed.

| What you see | What it means |
|---|---|
| No pill at all after clicking | The click did not reach the button, or the browser never resolved `getUserMedia`. Check for a permission prompt still open behind the window. |
| A pill with flat bars and **No audio** after ~2 s | The microphone is delivering digital silence. It is the *input device*, not the recogniser: pick another one in the panel, or check the system input level and any hardware mute. |
| Bars moving, then "The microphone delivered silence" | Audio was arriving but the recorder produced no bytes. Pick another input device and try again. |
| Bars moving, then a red "No speech was found in that clip" | The recogniser ran and heard nothing intelligible — speak closer to the mic, or set the language in the panel instead of `auto`. |
| A red "Sidecar not reachable" | The Python sidecar is not running: `stt/server/start.ps1`. |
| Text appears in the clipboard but not the composer | The composer was mid-submit, or the editor could not be written to. The diagnostics name the path taken. |

The pill says exactly which of these happened, so a silent failure should not be
possible; the panel's **Diagnostics** block has the details (device, peak level,
captured bytes, the last HTTP result, and how the text was inserted).

## Is it offline? Really?

Yes, and the only network use is a one-time weight download at setup:

| Stage | Network |
|---|---|
| `server/setup.ps1` (once) | Downloads the Python packages and the model weights into `stt/.models` |
| Every transcription afterwards | **None.** The sidecar reads `stt/.models` with `local_files_only=True` first |
| Recording | In the browser only; the blob goes to `127.0.0.1:8124`, never to the internet |

The sidecar binds `127.0.0.1` only, so it is not reachable from the network, and
its CORS headers are permissive solely so the DSH page (a different origin) can
call it. If you want to prove it, pull the network cable and dictate — or set
`DSH_STT_OFFLINE=1`, which makes the sidecar refuse to touch the hub at all.

## Installing the sidecar

```powershell
# Windows — creates stt/.venv with a standalone uv-managed Python 3.11,
# installs faster-whisper, downloads the weights, decodes a test clip.
pwsh -File stt\server\setup.ps1
pwsh -File stt\server\setup.ps1 -Model base     # smaller/faster weights
```

```bash
# macOS / Linux
bash stt/server/setup.sh
bash stt/server/setup.sh --model base
```

Roughly 160 MB of packages plus 75-500 MB of weights (~145 MB for the default
`base`), so a few minutes. It installs its own `uv` into `stt/.tools` (a
standalone tool download, so no system Python is needed).

Afterwards the plugin normally starts the sidecar by itself: the host half probes
`/health` on load and spawns the server only if nothing answers, so a profile
reload never starts a second copy. The process is deliberately **not** killed when
the plugin unloads — reloading the model on every profile patch would be far worse
than an idle process. Stop it with `server/stop.ps1` (`stop.sh`).

## Choosing a model

`DSH_STT_MODEL` (or `setup.ps1 -Model`) takes any faster-whisper name: `tiny`,
`base` (the default), `small`, `medium`, `large-v3`, `large-v3-turbo`,
`distil-small.en`… English-only names end in `.en` and are faster, but they cannot
transcribe or translate other languages.

Medians of five runs each on this machine — **i5-8365U (4 cores / 8 threads, 15 W,
no GPU)**:

| Model | One utterance, 2.5 s clip | One utterance, 6.6 s clip | Weights | Notes |
|---|---|---|---|---|
| `tiny` | **1.13 s** | **1.25 s** | ~75 MB | Fastest; weakest on accents, jargon and quiet audio |
| `base` | **1.93 s** | **1.94 s** | ~145 MB | **The default** — all three models produced the same correct sentence on the test clip, so the default takes the latency |
| `small` | **5.95 s** | **6.29 s** | ~485 MB | Better punctuation and wording on hard audio; ~3× the latency here |

Notice that each column is nearly flat: the clip length barely matters (see below).

Switch any time by restarting the sidecar with the variable set:

```powershell
pwsh -File stt\server\stop.ps1
pwsh -File stt\server\start.ps1 -Model small
```

Weights for a model you have not used yet are fetched on first load (or run
`server/warmup.py --model small` to fetch them up front).

## Speed — the honest numbers

The cost is **per 30-second audio window, not per second of speech**: Whisper pads
every clip to a 30-second mel window and runs the encoder over the whole thing, so
a 2.5-second utterance costs about what a 20-second one costs. The medians above
are the evidence — 2.5 s and 6.6 s of speech differ by ~0.1 s within each model.

Measured here with `base` + `int8`:

| | Value |
|---|---|
| Encoder + decode per utterance | **~1.9 s**, for a 2.5 s clip or a 6.6 s one |
| Audio decode (PyAV) | 0.05 s |
| VAD (silero, onnxruntime) | 0.03-0.17 s |
| `beam_size` 5 → 1 | no measurable change (the encoder dominates) |
| Model load into RAM | ~3-5 s after a restart |

Two honest caveats:

- **These numbers move.** The first request after a start is slower, and on this
  15 W chip a busy machine pushed `small` from a 5.9 s median to 8.4 s in a single
  run. Treat the table as the quiet-machine figure, not a guarantee.
- **WebM/Opus costs a little more than WAV.** The browser's own container has to
  be demuxed and decoded; that is inside the numbers above, and it is the path
  the GUI actually takes.

A modern desktop CPU is roughly 2-4× faster. VAD is on by default because it is
free: it trims silence so the model does not invent words in it.

## Insertion: where the text goes

| Mode | Behaviour |
|---|---|
| **At the cursor** (default) | Rides the composer's own paste command, so dictation lands where you were typing |
| **Replace the draft** | Swaps the whole composer contents for the transcript |
| **Copy to clipboard** | Touches nothing; puts the transcript on the clipboard |

The plugin tries four routes in order and reports the one it used next to the
button (and in the panel's diagnostics):

1. the composer's own **paste** command, when the slot hands it over;
2. the public **draft action** (`setDraft`), appending to what is already there;
3. **the editor's DOM** — the resident composer is a Lexical `contenteditable`,
   and the plugin focuses it and drives its own input pipeline
   (`execCommand("insertText")`, verified by reading the element's text back, so a
   browser that accepts the command and does nothing cannot fake success);
4. the **clipboard**, as the honest last resort.

That third route is why the button still works even when the slot gives a plugin
no composer handle at all — the situation the **Diagnostics** line "Composer
handles" exists to expose: it prints `none — the editor fallback is used` when the
slot passed nothing. A composer that is mid-submit (`phase` is not `plain`) is
never written into; the transcript is copied instead and the pill says so.

## The meter

The meter is not decoration: a dictation button that silently records nothing is
worse than no button, so the plugin makes the input visible in three places.

| Where | What it shows |
|---|---|
| The pill beside the button, while recording | Level bars, a red dot, elapsed time, and the bytes captured so far. Turns red with **No audio** when the input stays flat |
| The panel's level row | A bar meter with a dBFS figure and a peak-hold mark |
| **Test microphone**, in the panel | Opens the mic and meters it *without* recording or transcribing — the fastest way to check a device |

Two details that matter on real machines:

- **The audio graph is primed inside the click.** Browsers start an `AudioContext`
  suspended unless it is created during a user gesture, and the permission prompt
  can outlast that gesture; a context created after the `await` would leave the
  analyser reading silence forever — a meter that never moves, on a microphone
  that is working perfectly. So the context is created and `resume()`d
  synchronously in the click handler, and re-resumed from the meter loop if the
  browser suspends it later.
- **A dead input is called out, not hidden.** After two seconds below the noise
  floor the pill reads **No audio — check the input device**, and a clip that
  arrives with no level fails with "The microphone delivered silence" rather than
  the misleading "No speech was found".

## The sidecar

`server/stt_server.py` — Python **standard library only** (no FastAPI/Flask), so it
adds no runtime dependency beyond faster-whisper itself.

| Route | Purpose |
|---|---|
| `GET /health` | `{status: starting\|ready\|error, model, device, computeType, offline, cache, …}` — `503` until the weights are loaded |
| `POST /transcribe` | Raw audio bytes (the browser's own container: WebM/Opus, Ogg/Opus, MP4…) → `{text, language, languageProbability, duration, elapsed, realtimeFactor, segments}` |
| `GET /` | A small page that records and transcribes in a browser tab, for testing without DSH |

Per-request knobs ride headers, all defaulted server-side:
`X-DSH-STT-Mime`, `X-DSH-STT-Language` (`auto` detects), `X-DSH-STT-Task`
(`transcribe`/`translate`), `X-DSH-STT-Beam`, `X-DSH-STT-Vad`, `X-DSH-STT-Prompt`.

Configuration is entirely by environment variable:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_STT_PORT` | `8124` | listen port (must match the plugin's default endpoint) |
| `DSH_STT_MODEL` | `base` | any faster-whisper model name |
| `DSH_STT_DEVICE` | `auto` | `auto` (CUDA if CTranslate2 sees a GPU), `cpu`, `cuda` |
| `DSH_STT_COMPUTE_TYPE` | `int8` CPU / `float16` CUDA | CTranslate2 compute type |
| `DSH_STT_LANGUAGE` | *(empty)* | default language; empty means auto-detect |
| `DSH_STT_TASK` | `transcribe` | `transcribe` or `translate` (to English) |
| `DSH_STT_BEAM_SIZE` | `5` | beam size |
| `DSH_STT_VAD` | `1` | strip silence before decoding |
| `DSH_STT_PROMPT` | *(empty)* | initial prompt, for names and jargon |
| `DSH_STT_CACHE` | `stt/.models` | where the weights live |
| `DSH_STT_OFFLINE` | `auto` | `auto` = use the local weights, download only if missing; `1` = never touch the hub; `0` = allow hub lookups |
| `DSH_STT_MAX_BYTES` | `26214400` | reject larger uploads (25 MB) |
| `DSH_STT_WARMUP` | `1` | decode a generated tone at startup so the first click is not the slow one |
| `HF_HUB_DISABLE_SYMLINKS_WARNING` | set to `1` by the server | the HF cache symlinks need a Windows privilege a normal shell lacks |

The weights live in `stt/.models` (git-ignored, ~75-500 MB depending on the
model — ~145 MB for the default). Keeping them beside the plugin is what makes
"offline" easy to prove and easy to undo: delete the directory to reclaim the
space.

## Settings you can change in the panel

Right-click the button. Everything is stored in `localStorage` (browser-local, not
host settings): input device, insertion mode, sidecar URL, language, task, silence
filter, the silence auto-stop timeout (default **off**), and the recording cap
(default 120 s). The panel also carries the live meter, the **Test microphone**
button, the last transcript with a **Copy** button, and a **Diagnostics** block
(composer handles received, device, peak level, captured bytes, the last HTTP
result, the insertion path, engine and weights path).

## Verifying

```sh
node --check lib/client.js               # parses
node verify-client.mjs                   # 235 behavioural checks, no browser required
node verify-server.mjs                   # engine checks; skips cleanly when it is down
node verify-server.mjs --file clip.wav --expect "hello world"   # end-to-end
node ../../verify.mjs                    # everything in the repo, including the probe
```

`verify-client.mjs` evaluates `lib/client.js` against stubs — a minimal React hook
dispatcher, a DOM-ish tree, `localStorage`, a `MediaRecorder`/`getUserMedia` pair
it drives by hand, fake timers, an analyser whose input level it sets, a
Lexical-ish `contenteditable`, and a recording `fetch`. It asserts the slot
registration, both dictionaries staying key-complete, the recording lifecycle
(constraints, container choice, timeslice), the meter's maths and its live bars,
the no-audio warning, the microphone test mode, the request headers and body, all
four insertion routes, the failure states, cancellation, and both automatic stop
paths.

Measured end to end on this machine — HTTP, the resident `base` model, a
synthesized 6.6 s English clip in the browser's own WebM/Opus container:

```
transcript: "The quick brown fox jumps over the lazy dog, and the local speech
             recognizer is running offline."
language:   en (1.0)
audio:      6.56s decoded in 1.02s (x6.43 realtime)
```

The same clip as a WAV transcribes identically, which is what makes the browser
path safe to trust. (That 1.02 s is a quiet-machine run: the median table above is
the more conservative figure to plan against.)

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Button shows a red error, panel says the sidecar is unreachable | Run `server/start.ps1`. Check `server/server.log` — a first run downloads the weights. |
| The pill says **No audio** while you speak | The input device is delivering digital silence. Pick another input in the panel, or check the system input level / hardware mute. The panel's peak figure reads about `-100 dB` in this state. |
| The meter never moves at all | Use **Test microphone**; if it is still flat, the device is the problem. If the pill instead says the browser would not provide a meter, recording still works — the transcript will tell you. |
| "Microphone permission was refused" | The browser blocked `getUserMedia` for this page. The DSH page counts as a secure context on `127.0.0.1`, so allow the mic for the origin and click again. |
| "No speech was found in that clip" | The clip was silence or unintelligible. Set the language instead of `auto`, or speak closer to the mic. |
| Nothing is inserted, the pill says it copied | The composer was mid-submit, or the editor could not be written to; the transcript is on the clipboard and in the panel. The diagnostics line "Inserted via" names the path. |
| Transcription takes seconds for a short sentence | Expected: the cost is per 30 s encoder window, not per second of audio. `base` (the default) is ~1.9 s here, `tiny` ~1.1 s, `small` ~6 s. |
| Model reloads on every profile change | It should not — the plugin checks `/health` before spawning. Set `DSH_STT_AUTOSTART=0` and manage the process yourself if you prefer. |
| `LocalEntryNotFoundError` in the log | `DSH_STT_OFFLINE=1` and the weights are not cached. Run `server/warmup.py` with the same `DSH_STT_MODEL`, or set `DSH_STT_OFFLINE=auto`. |

## Files

```
package.json            declares dsh.client (platform: web) and exports ./client
lib/index.js            host half: entry-scan binding + sidecar autostart
lib/client.js           browser half: the button, meter, recording, insertion, settings panel
verify-client.mjs       235 behavioural checks with no browser
verify-server.mjs       engine checks + optional end-to-end clip transcription
server/stt_server.py    the stdlib HTTP sidecar that owns the model
server/warmup.py        load the model, decode a tone (or a file), prove the pipeline
server/setup.ps1/.sh    create the venv, install faster-whisper, fetch the weights
server/start.ps1/.sh    start the sidecar detached (logs to server/server.log)
server/stop.ps1/.sh     stop it
```
