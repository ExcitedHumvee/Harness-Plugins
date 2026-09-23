# AGENTS.md — installing these plugins into a DSH install

Audience: an AI coding agent with shell access on the user's machine. The user
pointed you at this repository and wants its plugins installed into their
**DeepSeek Harness (DSH) Web GUI**.

Follow the steps in order. Every command is non-destructive in `--check` form;
apply commands are idempotent and back up what they touch. Do not improvise around
a failure — the failure sections below say what each one means.

---

## What you are installing

| Plugin | Kind | Result |
|---|---|---|
| `sound-alerts/` | Cordis client plugin, mounted by `file:` URL from this checkout | A speaker control in the session header; a sound when a response completes and when input is needed |
| `stt/` | Cordis client plugin + a local Python sidecar | A microphone button in the composer that dictates into it with faster-whisper, running offline on CPU |
| `rebrand/` | Patch scripts that edit the installed web frontend in place | The DeepSeek wordmark/logo go away; title, manifest, and favicon become **Harness** |

`install.mjs` wires the Cordis plugins; the rebrand and the STT sidecar are
separate steps below. The STT sidecar is the only part with a heavyweight
dependency (~160 MB of Python packages plus ~145 MB of weights for its default
`base` model) — state that cost before starting it.

---

## Step 0 — preflight

Run these four checks. Stop and report if any fails; do not work around a missing
DSH install.

```sh
node --version                  # need v20 or newer
echo "$DSH_HOME"                # normally /home/<user>/.dsh or C:\Users\<user>\.dsh
```

```sh
# Confirm DSH is installed and find the profile to patch.
ls "$DSH_HOME/profiles"                       # expect: web (and node_modules)
cat "$DSH_HOME/profiles/web/package.json"     # expect: dsh.profile.bundles, "patchReload": "live"
```

If `$DSH_HOME` is empty, DSH defaults to `~/.dsh`. An installed DSH also puts
`@deepseek-ai/dsh-web-frontend` somewhere under `$DSH_HOME/profiles/node_modules`
or an `npx` cache — the rebrand tooling finds it on its own, so you do not have to.

**Clone destination matters.** The profile row records this checkout's absolute
path. Clone somewhere permanent (for example `~/dsh-harness-plugins`) — not
`/tmp`, not a directory that a cleanup job removes. If the clone later moves,
re-run `node install.mjs --force` from the new location.

---

## Step 1 — check everything first

Run from the repository root.

```sh
node install.mjs --check
```

Expected on a fresh machine: a `MISSING sound-alerts: no row in …` line and a
`MISSING stt: …` line, plus `2 plugin(s) not wired — run: node install.mjs`
(exit code 1).

If it instead reports `STALE <id>: row points at <some other path>`, the profile
is already wired to a *different* checkout of that plugin. That is not an error:
decide with the user's intent — if this checkout is the one to use, apply with
`--force` in step 2. If the other path is the one they actually want, tell them
and stop.

```sh
node rebrand/apply-rebrand.mjs --check     # frontend rebrand: reports, writes nothing
node stt/verify-client.mjs                 # STT button behaviour, no browser needed
```

Expected from the rebrand: `status: would-patch` followed by ~27 `ok` lines,
ending in `check complete: every install above can be patched cleanly.` (exit 0).
If it prints `status: already-patched`, the rebrand is already in effect — that is
a success, not a failure.

Expected from the STT check: `all checks passed (235)`. It tests plugin code only;
it does not need a model.

---

## Step 2 — apply

```sh
node install.mjs                # add --force only to repoint a STALE row
node rebrand/apply-rebrand.mjs  # add --all when --check listed more than one install
```

What success looks like:

- `install.mjs` prints `wrote <…>/cordis.patch.yml`, a `backup: …bak-<timestamp>`
  line, and a reminder that `patchReload: live` means no restart is needed.
- `apply-rebrand.mjs` prints `bundle: patched — … backup …`, a `shell:` line
  listing the title/manifest/favicon changes, a `verification:` block of `ok`
  lines, and `rebrand applied and verified.`

### The STT sidecar (only if the user wants the dictation button)

~160 MB of packages plus ~145 MB of weights for the default `base` model, so a few
minutes. Say so before starting it:

```powershell
pwsh -File stt\server\setup.ps1                  # Windows: default `base` weights
pwsh -File stt\server\setup.ps1 -Model small     # better accuracy, ~3x slower here
```

```bash
bash stt/server/setup.sh                 # macOS / Linux
```

The script installs a standalone `uv` into `stt/.tools` (no system Python
required — the Windows Store stub is not usable), creates `stt/.venv` with Python
3.11, installs `faster-whisper` (CTranslate2 + PyAV), and runs `warmup.py`, which
downloads the weights into `stt/.models` (git-ignored) and decodes a generated
tone. Everything after that runs offline: the server loads with
`local_files_only` first, and `DSH_STT_OFFLINE=1` forbids the hub outright.

Then either let the plugin start it, or start it by hand:

```powershell
pwsh -File stt\server\start.ps1          # logs to stt/server/server.log
```

Confirm before moving on:

```sh
curl http://127.0.0.1:8124/health        # {"status":"ready","model":"faster-whisper base",...}
node stt/verify-server.mjs --file clip.wav --expect "hello world"   # optional end to end
```

The weights load in ~3-5 s.

---

## Step 3 — verify independently

```sh
node verify.mjs
```

Five sections — syntax, sound-alerts behaviour, STT button behaviour, rebrand in
effect, profile wiring — must all end in `all checks passed`. This re-checks the
rebrand and the wiring from scratch, so it is the gate to trust.

One line in the STT section is **not** a failure: `skip the sidecar is not running
…`, because `stt/verify-server.mjs` reports and exits 0 by design, so a checkout
without the sidecar installed still verifies cleanly. The section still fails if
the plugin's own code is broken.

---

## Step 4 — hand it back to the user

1. Tell them to **reload the GUI page** with a hard reload (Ctrl+Shift+R). No
   server restart is needed: the `web` profile has `patchReload: live`, and the
   frontend `dist/` is served from disk.
2. Tell them where to look:
   - `sound-alerts`: a speaker button in the session header utilities (next to
     the other header icons). It opens a panel with the master switch, volume,
     minimum turn length, per-cue sound/repeat/gap, Test, and Reset.
   - `stt`: a microphone button in the composer row, left of the model picker and
     the send button. Click it, speak, click again — the transcript is inserted at
     the cursor. While the mic is open a pill beside the button shows a live level
     meter, a red dot, the elapsed time and the bytes captured, and it turns red
     with **No audio** if the input stays flat; right-click for the input-device
     picker, **Test microphone**, and the diagnostics block.
   - `rebrand`: the browser tab reads **Harness**, and the favicon is a neutral
     rounded-square "H".
3. Set expectations for the STT button: it is fast in audio terms and *flat* in
   wall-clock terms. Whisper pads every clip to a 30-second encoder window, so a
   two-second utterance costs about what a twenty-second one does — medians of
   five runs here gave **~1.9 s per click with the default `base`**, ~1.1 s with
   `tiny`, ~6 s with `small`, all three transcribing the test clip correctly. It
   is not broken when a short sentence takes a couple of seconds. The first click
   also blocks on the browser's microphone permission prompt.
4. Mention the one cache quirk: if the tab title or favicon still looks old, the
   browser cached `favicon.svg` — open a fresh tab or hard-reload.

Do not claim it works before the user confirms the page; `verify.mjs` proves the
files, not the rendering.

---

## Failure modes

**`precondition failed: <anchor> expected 1 occurrence(s), found 0`** (rebrand)
The installed `@deepseek-ai/dsh-web-frontend` build is not the one the anchors
were derived from — typically after a DSH upgrade. The patcher correctly refused
rather than corrupting the bundle. Do **not** blindly delete or loosen the anchor
checks. Report which anchor failed and the frontend package version:

```sh
node -e "console.log(require('$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-web-frontend/package.json').version)"
```

Re-deriving anchors is a deliberate job: locate the same primitives in the new
bundle (`FishLogo`, `BrandWordmark`, the `FISH_LOGO_PATH`/`FISH_LOGO_VIEWBOX`
constants), update the constants at the top of `rebrand/patch-web-brand.mjs`, and
prove the new replacement with `node rebrand/verify-web-brand.mjs`. Hand this to
the user as a decision, not a silent edit — the whole point of the anchors is
that a human looks when the build changes.

**`manifest is not valid JSON`** — the shipped `manifest.webmanifest` changed
shape. Nothing was written. Report it; the fix is a one-line rewrite of
`patch-web-shell.mjs`, but confirm with the user first.

**`--dist=… does not exist` / `No @deepseek-ai/dsh-web-frontend install found`** —
DSH's frontend is not where the resolver looked. Ask the user for `$DSH_HOME`, or
point at one directly with `node rebrand/apply-rebrand.mjs --dist=<path to dist>`.
Do not guess a path and patch it.

**`FAILED to write the expected rows`** (install.mjs) — the patch file was
written but the rows did not survive a re-read. A timestamped `.bak-` copy of the
previous file sits beside it; restore that copy and report.

**STT: the button is red and the panel says the sidecar is unreachable** — the
Python process is not running. Start it (`stt/server/start.ps1`) and watch
`stt/server/server.log`; the weights report ready in seconds.

**STT: `LocalEntryNotFoundError` / "no local weights yet" in the log** —
`DSH_STT_OFFLINE=1` and `stt/.models` has no copy of the model. Run
`stt/server/warmup.py --model <name>` once (with the network up), or leave
`DSH_STT_OFFLINE` at its `auto` default, which downloads once and then stays local.

**STT: the transcript never reaches the composer** — read the pill, then the
panel's diagnostics. The plugin tries, in order, the composer's paste command, the
public draft action, the editor's own DOM (`contenteditable` +
`execCommand("insertText")`, verified by reading the text back), and finally the
clipboard; the diagnostics line **Inserted via** names the one that ran, and
**Composer handles** says whether the slot handed the plugin a composer handle at
all (`none — the editor fallback is used` is normal on builds that do not pass
one). A composer that is mid-submit is never written into — it copies instead, by
design. If the pill says the text was inserted but the composer is empty, the
build's editor markup has changed; fix the selector in `findComposerEditor` rather
than reaching around Lexical's model.

**STT: the meter is flat while the user speaks** — that is the input device, not
the recogniser. Have them open the panel: the diagnostics show the device and the
peak in dBFS, **Test microphone** meters without recording, and the input picker
switches devices. A peak pinned at about -100 dB is a muted, disconnected, or
wrong input. Do not "fix" this in the plugin; there is no software route to audio
the browser never receives.

**STT: every utterance takes seconds, however short** — expected, and it is not a
bug. The cost is per 30-second encoder window, so it barely varies with clip
length: measured here, ~1.9 s with the default `base` and ~6 s with `small`. Do
not reach for threads or `beam_size` — beam 5 → 1 changed nothing, the encoder
dominates. Use `tiny` (~1.1 s) if the user wants it snappier, and point at
[`stt/README.md`](./stt/README.md#speed--the-honest-numbers).

**STT: "Microphone permission was refused"** — the browser blocked `getUserMedia`.
The DSH page on `127.0.0.1` is a secure context, so this is the site permission
setting, not a plugin problem; the user has to allow it, there is no way around it
programmatically.

**The GUI stops loading after install** — the patch layer is malformed. Restore
the newest `cordis.patch.yml.bak-*` beside the patch file, reload, and report the
diff. A profile patch file is a YAML array; a stray indent or a duplicated row id
can break composition.

---

## Rollback

```sh
node install.mjs --uninstall            # removes every plugin row this repo added
pwsh -File stt\server\stop.ps1          # frees the few hundred MB the STT model holds
```

Deleting `stt/.models` (git-ignored; ~145 MB for the default model) reclaims the
weights; the next start fetches them again.

For the rebrand, restore the pre-patch files kept in `rebrand/backups/` into the
frontend's `dist/` (`index-*.js`, `index.html`, `manifest.webmanifest`,
`favicon.svg`), then reload the page. Full commands are in
[`rebrand/README.md`](./rebrand/README.md#rolling-back).

---

## Rules for this task

- **Never edit `$DSH_HOME/settings.yaml`, `.credentials.yaml`, or any session
  data.** Installing a plugin touches exactly one file outside this checkout:
  `$DSH_HOME/profiles/<profile>/cordis.patch.yml`.
- **Never hand-write the `file:` URL** into the patch file. Let `install.mjs` do
  it: it URL-encodes spaces (`%20`) and every other character that needs it.
- **Never commit `stt/.venv`, `stt/.tools`, `stt/.models`, or the weights.** All of
  them are git-ignored; a clone must stay small. The weights live in `stt/.models`
  on purpose, so "offline" is provable and one `rm -rf` reclaims the space.
- **State the STT download cost before starting it** — ~160 MB of packages plus
  ~145 MB of weights for the default model — and do not start it unasked.
- **Do not commit or ship `rebrand/backups/`.** It holds copies of a proprietary
  published bundle and is git-ignored on purpose.
- **Do not run a rebrand against a `dist/` you have not identified.** Use
  `--check` first; it prints the exact path it would touch.
- **Do not start a replacement server** to "make it work". These are plugins for
  the user's existing DSH install. The one process worth starting is the local STT
  sidecar, and only on `127.0.0.1`.
- Report the exact commands you ran and their exit codes when you are done.
