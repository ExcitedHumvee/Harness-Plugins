# AGENTS.md — installing these plugins into a DSH install

Audience: an AI coding agent with shell access on the user's machine. The user
pointed you at this repository and wants its plugins installed into their
**DeepSeek Harness (DSH) Web GUI**.

Follow the steps in order. Every command is non-destructive in `--check` form;
apply commands are idempotent and back up what they touch. Do not improvise around
a failure — the failure sections say what each one means.

---

## What you are installing

| Plugin | Package | Kind | Result |
|---|---|---|---|
| `sound-alerts/` | `dsh-sound-alerts` | Bundle, with a browser (`dsh.client`) half | A speaker control in the session header; a cue when a response completes and when input is needed, each repeating every minute until you respond and each flashing the screen |
| `rebrand/` | `dsh-rebrand` | Bundle, host-only | The DeepSeek wordmark/logo go away; title, manifest, and favicon become **Harness**, reapplied automatically at every boot |

Both are **bundles**: npm packages whose `package.json` declares
`dsh.bundle.patch`. DSH installs a bundle by listing it in the profile's
`dsh.profile.bundles` and applying the package's `cordis.patch.yml` as a
configuration layer at boot. `install.mjs` drives that for a local checkout;
`dsh plugin` does it for any source.

There is no build step: both packages ship their runtime files.

**Nothing here edits a database, a credential file, or session data.** The only
files outside the checkout that an install changes are
`$DSH_HOME/profiles/<profile>/package.json` (the dependency and layer list),
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` (only to remove rows this
repository previously wrote), and — for the rebrand — the installed frontend's
`dist/`, which is what it exists to change.

---

## Step 0 — preflight

```sh
node --version                  # need v20 or newer
echo "$DSH_HOME"                # normally /home/<user>/.dsh or C:\Users\<user>\.dsh
```

```sh
# Confirm DSH is installed and find the profile.
ls "$DSH_HOME/profiles"                       # expect: web (and node_modules)
cat "$DSH_HOME/profiles/web/package.json"     # expect: dsh.profile.bundles, "patchReload": "live"
```

If `$DSH_HOME` is empty, DSH defaults to `~/.dsh`.

**pnpm must be on PATH for the CLI channel**, because `dsh plugin` is a pnpm
forwarder. `corepack enable pnpm` is the least invasive way to get it. If pnpm
cannot be installed, use the marketplace channel in step 2 instead — it does not
need pnpm.

**Clone destination matters, and so does its path.** The profile records the
absolute path of this checkout. Clone somewhere permanent — not a temp directory.
On Windows, a path containing a space cannot be forwarded by `dsh plugin`
(`cmd.exe` splits the argument and pnpm reports
`Failed to resolve the latest version of repos\Harness`); either clone to a path
without spaces, or let `install.mjs` create its persistent link under
`$DSH_HOME/.dsh-plugin-links` (see step 2).

---

## Step 1 — check everything first

Run from the repository root.

```sh
node install.mjs --check
```

Expected on a fresh machine: a `MISSING <id>: not installed` line per plugin
(exit code 1). Lines that are **not** errors:

- `dev <id>: mounted by file: URL` — an older checkout mounted it directly. Step 2
  converts it to a bundle; that is an upgrade, not a problem.
- `ok <id>: bundle … is a profile layer` — already installed.

```sh
node verify.mjs
```

Six steps. On an uninstalled machine, `6/6 profile installation` fails and the
rest should pass. The `4/6 rebrand host plugin behaviour` step prints a `skip` on
a fresh clone (it needs the patcher's own pre-patch backup as its input) — a skip
is not a failure.

```sh
node rebrand/apply-rebrand.mjs --check     # frontend rebrand: reports, writes nothing
```

Expected: `status: would-patch` or `status: already-patched`, followed by `ok`
lines and `check complete: every install above can be patched cleanly.`

---

## Step 2 — install

### Preferred: DSH's own CLI

```sh
dsh plugin --profile web add "github:ExcitedHumvee/Harness-Plugins#path:/sound-alerts"
dsh plugin --profile web add "github:ExcitedHumvee/Harness-Plugins#path:/rebrand"
```

Restart DSH afterwards (`dsh web`). Bundles are composed at boot, so
`patchReload: live` does **not** cover them.

For a local checkout, `node install.mjs` runs the same two commands against this
directory, with two safeguards worth knowing:

```sh
node install.mjs
```

- it **removes this repository's old `file:` rows first**. A row with the same id
  as a bundle's row stops the profile from booting
  (`duplicate loader entry id`), and a *renamed* second row is refused too
  (`package <name> resolves from multiple active Loader sources`). Peeling first
  is what makes upgrading from the old file-URL layout safe.
- if the checkout path contains a space it creates a persistent link under
  `$DSH_HOME/.dsh-plugin-links` and installs through that. The link is
  deliberately not temporary: pnpm records the link target as the dependency.

### Alternative: a plugin marketplace inside the GUI

If the user wants to install from the DSH Web GUI rather than a terminal, the
supported route is the community marketplace plugin, which adds an install page to
DSH's settings and indexes every repository carrying GitHub's `dsh-plugin` topic:

```sh
dsh plugin --profile web add bradeGithub/DSH-Plugins-Marketplace
```

Restart DSH, then install **Harness Plugins** from **Settings → DSH 插件市场**.
This channel does not need pnpm. Note that DSH's own settings **Plugin list** tab
is a read-only inventory — do not look for an install button there.

### Development only: `--wire`

`node install.mjs --wire` mounts a plugin's host entry straight from the checkout
by `file:` URL. It is covered by `patchReload: live`, so a host-half edit reloads
without reinstalling — useful while iterating, not a distribution form. It clears
the bundle entries first, for the same duplicate-row reason.

### What success looks like

- `install.mjs` ends with `all 2 plugin(s) recorded as profile bundles` and prints
  a `backup:` line for any patch file it rewrote.
- `dsh --profile web --dump-config` shows a `# == dsh-sound-alerts` section and a
  `# == dsh-rebrand` section.

Confirm the composition before restarting, if you like:

```sh
dsh --profile web --dump-config | grep -A2 '# == dsh-'
```

---

## Step 3 — verify

```sh
node verify.mjs
```

All six steps must end in `all checks passed`. This re-checks the package
contract, the plugin behaviour, the rebrand, and the profile installation from
scratch, so it is the gate to trust.

Then confirm the part that only a real boot can prove — that the browser half is
composed into the boot graph and servable:

```sh
curl -s "http://127.0.0.1:3080/plugins/dsh-sound-alerts/client.js" -o /dev/null -w '%{http_code}\n'
```

A `404` on a bundle install means the row did not compose; check
`--dump-config` first. On a `--wire` install the served path is
`/plugins/sound-alerts/client.js` — the row id, not the package name — because a
`file:`-mounted row is served under its row id.

---

## Step 4 — hand it back to the user

1. **Restart DSH** (`dsh web`) — bundles compose at boot. Then hard-reload the GUI
   page (Ctrl+Shift+R).
2. Tell them where to look:
   - `sound-alerts`: a speaker button in the session header utilities, opening a
     panel with the master switch, volume, the screen-flash switch, minimum turn
     length, per-cue sound/repeat/gap, the per-cue "repeat until you respond"
     reminder and its interval, Test, and Reset. Preferences are browser-local.
   - `rebrand`: the browser tab reads **Harness** and the favicon is a neutral
     rounded-square "H".
3. Mention the one cache quirk: if the tab title or favicon still looks old, the
   browser cached `favicon.svg` — open a fresh tab or hard-reload.
4. Mention the one gotcha: `dsh plugin` needs pnpm, which does not ship with Node.
   `corepack enable pnpm` is the usual fix.

Do not claim it works before the user confirms the page; `verify.mjs` proves the
files and the composition, not the rendering.

---

## Failure modes

**`precondition failed: <anchor> expected 1 occurrence(s), found 0`** (rebrand)
The installed `@deepseek-ai/dsh-web-frontend` build is not the one the anchors were
derived from, typically after a DSH upgrade. This is a **failure the patcher is
designed to produce** — it refused rather than corrupting the bundle, and the GUI
still boots (the host plugin logs the refusal and returns). Report which anchor
failed and the frontend version:

```sh
node -e "console.log(require('$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-web-frontend/package.json').version)"
```

Re-deriving the anchors is a deliberate job: find the same primitives in the new
bundle (`FishLogo`, `BrandWordmark`, the `FISH_LOGO_PATH`/`FISH_LOGO_VIEWBOX`
constants), update the constants at the top of `rebrand/lib/patch-web-brand.mjs`,
and prove the new replacement with
`node rebrand/apply-rebrand.mjs --check --dist=<dist>`.
Hand this to the user as a decision, not a silent edit.

**`duplicate loader entry id: <id>`** — a `file:` row from an older install is
still in the profile's `cordis.patch.yml` alongside the bundle's row. Run
`node install.mjs` (it peels the old row), or delete the row by hand. Leaving both
is not an option; the profile will not boot.

**`package <name> resolves from multiple active Loader sources`** — the same
collision with the row renamed. Same fix.

**The GUI stops loading after an install** — the profile's patch layer is
malformed. Restore the newest `cordis.patch.yml.bak-*` beside it, reload, and
report the diff. A profile patch file is a YAML array; a stray indent or a
duplicated row id can break composition.

**`manifest is not valid JSON`** (rebrand) — the shipped `manifest.webmanifest`
changed shape. Nothing was written; report it, and confirm with the user before
touching `rebrand/lib/patch-web-shell.mjs`.

**`--dist=… does not exist` / `No @deepseek-ai/dsh-web-frontend install found`** —
DSH's frontend is not where the resolver looked. Ask the user for `$DSH_HOME`, or
point at one directly with `node rebrand/apply-rebrand.mjs --dist=<path to dist>`.
Do not guess a path and patch it.

**`FAILED to install <name>` from `install.mjs`** — the `dsh plugin add` call
failed; read the pnpm output above it. The most common causes are pnpm missing
from PATH, or a checkout path containing a space on Windows.

**`FAILED to write the expected rows`** (install.mjs) — the patch file was written
but the intended state did not survive a re-read. A timestamped `.bak-` copy sits
beside it; restore that copy and report.

---

## Rollback

```sh
dsh plugin --profile web remove dsh-sound-alerts
dsh plugin --profile web remove dsh-rebrand

# or, for a local checkout:
node install.mjs --uninstall
```

`--uninstall` removes this repository's rows and bundle entries, leaving the patch
file as `[]` when nothing else is using it.

For the rebrand, restore the pre-patch files from `rebrand/lib/backups/` into the
frontend's `dist/` (`index-*.js`, `index.html`, `manifest.webmanifest`,
`favicon.svg`) **and** disable the plugin, or the next boot reinstates it:

```yaml
- id: rebrand
  config:
    enabled: false
```

See [`rebrand/README.md`](./rebrand/README.md#rolling-back).

---

## Rules for this task

- **Never edit `$DSH_HOME/settings.yaml`, `.credentials.yaml`, or any session
  data.**
- **Do not hand-write plugin rows when a bundle will do.** The bundle's own
  `cordis.patch.yml` is the mounting mechanism; a hand-written row is the
  development (`--wire`) path only.
- **Never commit `rebrand/lib/backups/`.** It holds copies of a proprietary
  published bundle and is git-ignored on purpose.
- **Do not run the rebrand against a `dist/` you have not identified.** Use
  `--check` first; it prints the exact path it would touch.
- **Version bumps matter for updates.** The marketplace compares the `version` in
  each package's `package.json`; bump it when changing a package or no update is
  ever offered.
- **Do not start a replacement server** to "make it work". These are plugins for
  the user's existing DSH install.
- Report the exact commands you ran and their exit codes when you are done.
