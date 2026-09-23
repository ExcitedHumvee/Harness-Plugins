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
| `rebrand/` | Patch scripts that edit the installed web frontend in place | The DeepSeek wordmark/logo go away; title, manifest, and favicon become **Harness** |

Neither one lives in `node_modules`, and neither needs a build step.

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

## Step 1 — the two halves, each in check mode first

Run from the repository root.

```sh
node install.mjs --check
```

Expected on a fresh machine: one `MISSING sound-alerts: no row in …` line and
`1 plugin(s) not wired — run: node install.mjs` (exit code 1).

If it instead reports `STALE sound-alerts: row points at <some other path>`, the
profile is already wired to a *different* checkout of this plugin. That is not an
error: decide with the user's intent — if this checkout is the one to use, apply
with `--force` in step 2. If the other path is the one they actually want, tell
them and stop.

```sh
node rebrand/apply-rebrand.mjs --check
```

Expected: `status: would-patch` followed by ~27 `ok` lines, ending in
`check complete: every install above can be patched cleanly.` (exit 0).

If it prints `status: already-patched`, the rebrand is already in effect in that
install — that is a success, not a failure.

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

---

## Step 3 — verify independently

```sh
node verify.mjs
```

Four sections — syntax, sound-alerts behaviour, rebrand in effect, profile
wiring — must all end in `all checks passed`. This re-checks the rebrand and the
wiring from scratch, so it is the gate to trust.

---

## Step 4 — hand it back to the user

1. Tell them to **reload the GUI page** with a hard reload (Ctrl+Shift+R). No
   server restart is needed: the `web` profile has `patchReload: live`, and the
   frontend `dist/` is served from disk.
2. Tell them where to look:
   - `sound-alerts`: a speaker button in the session header utilities (next to
     the other header icons). It opens a panel with the master switch, volume,
     minimum turn length, per-cue sound/repeat/gap, Test, and Reset.
   - `rebrand`: the browser tab reads **Harness**, and the favicon is a neutral
     rounded-square "H".
3. Mention the one cache quirk: if the tab title or favicon still looks old, the
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

**The GUI stops loading after install** — the patch layer is malformed. Restore
the newest `cordis.patch.yml.bak-*` beside the patch file, reload, and report the
diff. A profile patch file is a YAML array; a stray indent or a duplicated row id
can break composition.

---

## Rollback

```sh
node install.mjs --uninstall            # removes sound-alerts from the profile
```

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
- **Do not commit or ship `rebrand/backups/`.** It holds copies of a proprietary
  published bundle and is git-ignored on purpose.
- **Do not run a rebrand against a `dist/` you have not identified.** Use
  `--check` first; it prints the exact path it would touch.
- **Do not start a replacement server** to "make it work". These are plugins for
  the user's existing DSH install.
- Report the exact commands you ran and their exit codes when you are done.
