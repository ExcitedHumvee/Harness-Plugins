# DSH Harness Plugins

Drop-in plugins for the **DeepSeek Harness (DSH) Web GUI**: they mount straight
from a git checkout by `file:` URL, with no package install and no build step.

This repository is written to be handed to an AI agent. Point it at this repo and
say "install these plugins"; the agent should read [`AGENTS.md`](./AGENTS.md),
which carries the exact commands, the decision rules, and the failure modes.

| Plugin | What it does |
|---|---|
| [`sound-alerts/`](./sound-alerts/README.md) | Notification sounds: one cue when a final response completes, another when the agent is waiting on your input, with a header control for customizing both |
| [`stt/`](./stt/README.md) | A microphone button in the composer that dictates into it with **faster-whisper** running locally (offline, inserts at the cursor, ~145 MB of weights) |
| [`rebrand/`](./rebrand/README.md) | Removes the DeepSeek wordmark and logo from the shipped web frontend and renames the app to **Harness** |

They are independent: install any one, or all three. `sound-alerts` and `stt` are
Cordis client plugins mounted by `file:` URL; `rebrand` patches the installed
frontend in place and is not wired into the profile at all.

## Requirements

- DSH installed and running as the Web GUI (`dsh web`), which installs
  `@deepseek-ai/dsh-web-frontend` into `$DSH_HOME`.
- Node.js 20+ (developed against 24).
- The `web` profile — the default. Another profile works too: pass
  `--profile=<name>`.
- **For `stt` only:** Python 3.11 and ~145 MB of model weights for the default
  `base` model (75-500 MB for the other sizes). No system Python is needed —
  `stt/server/setup.ps1` fetches a standalone interpreter with `uv`. Everything
  after setup runs offline.

## Install

Clone this repository somewhere permanent — the profile row records the
checkout's **absolute path**, so moving or deleting the clone later un-wires the
plugin.

```sh
git clone <this-repo-url> dsh-harness-plugins
cd dsh-harness-plugins

node install.mjs                                    # wire sound-alerts + stt into the profile
node rebrand/apply-rebrand.mjs                      # patch the web frontend to the Harness brand
pwsh -File stt/server/setup.ps1                     # install the faster-whisper sidecar (stt only)

node verify.mjs                                     # confirm code, rebrand, sidecar and wiring
```

Then **reload the GUI page** (Ctrl+Shift+R). The `web` profile uses
`patchReload: live`, so no server restart is needed.

Every command is idempotent, all of them have a `--check` mode that writes
nothing, and all of them back up anything they change (`install.mjs` writes
`cordis.patch.yml.bak-<timestamp>`; the rebrand writes pre-patch copies into
`rebrand/backups/`).

## Uninstall

```sh
node install.mjs --uninstall      # remove the plugin rows from the profile
```

For the rebrand, restore the pre-patch files from `rebrand/backups/` — see
[`rebrand/README.md`](./rebrand/README.md#rolling-back).

## What is in here

```
README.md                     this file
AGENTS.md                     install playbook for an AI agent (and for humans who want the details)
install.mjs                   wires every client plugin in this checkout into the DSH profile
verify.mjs                    runs all five checks: syntax, plugin behaviour, the STT engine, rebrand, wiring
sound-alerts/
  package.json                declares dsh.client (platform: web) and exports ./client
  lib/index.js                host half: empty apply, so the entry-scan picks the package up
  lib/client.js               browser half: the header control and the synthesized cues
  verify-client.mjs           behavioural test suite, no browser required
  README.md                   the plugin, in detail
stt/
  package.json                declares dsh.client (platform: web) and exports ./client
  lib/index.js                host half: starts the faster-whisper sidecar on load
  lib/client.js               browser half: the mic button, meter, recording, insertion, panel
  verify-client.mjs           behavioural test suite, no browser required
  verify-server.mjs           engine checks + optional end-to-end clip transcription
  server/stt_server.py        the stdlib HTTP sidecar that owns the model
  server/setup|start|stop     install / run / stop the sidecar (PowerShell and POSIX)
  server/warmup.py            load the model, decode a tone or a file, prove the pipeline
  README.md                   the plugin, in detail (including honest speed numbers)
rebrand/
  README.md                   what changes, how to apply, how to verify, how to roll back
  resolve-frontend.mjs        finds every installed @deepseek-ai/dsh-web-frontend copy
  patch-web-brand.mjs         patches the minified JS bundle (anchor-based)
  patch-web-shell.mjs         patches index.html, manifest.webmanifest, favicon.svg
  apply-rebrand.mjs           apply both halves, then verify the result
  verify-web-brand.mjs        evaluates the patched components and scans for residual brand
```

## Caveats worth knowing

- **STT is offline, and its cost is per utterance, not per second.** The
  faster-whisper sidecar reads weights from `stt/.models` (git-ignored, ~145 MB for
  the default `base` model) with `local_files_only` first, so once setup has run,
  dictation never touches the network. Whisper pads every clip to a 30-second
  encoder window, so a 2.5-second utterance costs about what a 20-second one does:
  medians of five runs on a 15 W laptop chip gave **~1.9 s per utterance with the
  default `base`**, ~1.1 s with `tiny`, ~6 s with `small` — all three transcribing
  the test clip correctly. Switch with `DSH_STT_MODEL` or
  `stt/server/start.ps1 -Model small`; see
  [`stt/README.md`](./stt/README.md#speed--the-honest-numbers).
- **STT insertion never fails silently.** The caret insert rides the composer's own
  paste command, then the editor's DOM; only when neither is available does the
  transcript go to the clipboard, and the button always says which path it took,
  next to the mic. The panel keeps the last transcript and a diagnostics readout.
- **The rebrand is build-specific.** Its anchors were derived from the frontend
  build that shipped with the DSH version installed when it was written. A newer
  `@deepseek-ai/dsh-web-frontend` may rename its minified symbols; the patcher
  then stops with `precondition failed: …` rather than corrupting the bundle.
  Re-deriving the anchors is a real (and verifiable) job — see
  [`rebrand/README.md`](./rebrand/README.md).
- **More than one frontend copy can exist.** The profile's `node_modules` copy
  and every `npx` cache hold their own `dist/`. `apply-rebrand.mjs` patches every
  copy whose bytes match what the running server serves (matched over HTTP, no
  authentication needed for hashed assets), and `--all` patches every copy it
  finds.
- **A DSH upgrade undoes the rebrand.** The upgrade replaces the frontend
  `dist/`; re-run `node rebrand/apply-rebrand.mjs`.
- **Sound preferences are browser-local** (`localStorage`), not host settings.

## License

[MIT](./LICENSE).

