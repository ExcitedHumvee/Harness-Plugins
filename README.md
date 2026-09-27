<h1 align="center">Harness Plugins</h1>

<p align="center">
Two plugins for the <b>DeepSeek Harness (DSH)</b> Web GUI: notification sounds when an agent finishes or needs you, and a rebrand that removes the DeepSeek wordmark and logo.
</p>

| Plugin | What it does | Where the work happens |
|---|---|---|
| [`sound-alerts/`](./sound-alerts/README.md) | One synthesized cue when a final response completes, another when the agent is waiting on your input, each able to repeat every minute until you respond, with a header control for customizing both | Browser (`dsh.client`) |
| [`rebrand/`](./rebrand/README.md) | Removes the DeepSeek wordmark and logo from the shipped web frontend and renames the app to **Harness** | Host (`dsh.bundle`) |

Both are **bundles**: npm packages whose manifest declares `dsh.bundle`, which is
the form DSH installs from a git repository, a tarball, npm, or a local folder.
Installing one takes a single DSH command and no build step — the packages ship
their runtime files.

## Install

Pick the channel that matches what you have.

### From the Web GUI (a plugin marketplace)

A community marketplace plugin adds an install UI to DSH's settings, with one-click
install and update for every repository carrying GitHub's `dsh-plugin` topic.
Install the marketplace itself first (DSH's own CLI, one command), then install
these two from its list:

```sh
dsh plugin --profile web add bradeGithub/DSH-Plugins-Marketplace
```

Restart DSH, open **Settings → DSH 插件市场**, and install **Harness Plugins**.
This repository carries the `dsh-plugin` topic, so it is indexed and appears
there automatically; use its search box if the list is long.

DSH itself has no built-in "pick a folder from my computer" plugin installer —
its own install surface is the CLI, and the settings **Plugin list** tab is a
read-only inventory. The marketplace is the GUI route; the two channels below are
the built-in ones.

### From this repository, by DSH's own CLI

Point `dsh plugin` at each package. One command per plugin, and the commands are
safe to re-run:

```sh
dsh plugin --profile web add "github:ExcitedHumvee/Harness-Plugins#path:/sound-alerts"
dsh plugin --profile web add "github:ExcitedHumvee/Harness-Plugins#path:/rebrand"
```

**Restart DSH afterwards** (`dsh web`). A bundle contributes a configuration
*layer* that is composed at boot, so unlike a patch-file edit it is not picked up
by `patchReload`.

`dsh plugin` forwards to pnpm inside the profile directory, so pnpm has to be on
PATH — `corepack enable pnpm`, or install pnpm directly. The `#path:/<subdir>`
form selects a package inside this repository and works on Windows as written;
posix shells also accept the commit-pinning spelling
`#<commit>&path:/<subdir>` (quote it — `&` is special on Windows).

To install from a local clone or a downloaded folder instead, pass the folder
that holds `package.json` — not the repository root:

```sh
git clone https://github.com/ExcitedHumvee/Harness-Plugins.git
dsh plugin --profile web add "<clone>/sound-alerts"
dsh plugin --profile web add "<clone>/rebrand"
```

> **Windows, path with a space:** DSH forwards the path to pnpm through `cmd.exe`,
> which splits it, and pnpm reports `Failed to resolve the latest version of
> repos\Harness`. Clone to a path without spaces, or create a link once and install
> through that:
>
> ```powershell
> New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\repo" -Target "C:\path with spaces\Harness Plugins"
> dsh plugin --profile web add "$env:USERPROFILE\.dsh\repo\sound-alerts"
> ```

### From this checkout, while developing

`node install.mjs` drives the CLI channel above, and `--wire` mounts a plugin's
host half straight out of the checkout instead (a `file:` row in the profile's own
patch file, which *is* covered by `patchReload: live`):

```sh
node install.mjs             # install both as bundles (delegates to `dsh plugin add`)
node install.mjs --check     # report what is installed here, change nothing
node install.mjs --wire      # development mount: file: URLs, no reinstall on edit
node install.mjs --uninstall # remove both plugins from the profile
```

The two forms conflict — a duplicate row id stops the profile from booting — so
each one clears the other's rows and dependencies before it writes.

## Verify

```sh
node verify.mjs
```

Six steps: every script parses; each package satisfies the bundle contract; the
`sound-alerts` browser half and the `rebrand` host half behave; the rebrand is in
effect on this machine; both plugins are installed in the profile. Exit code 0
means everything that could run passed.

## After installing

1. **Restart DSH**, then hard-reload the page (Ctrl+Shift+R).
2. `sound-alerts`: a speaker button appears in the session header utilities. It
   opens a panel with the master switch, volume, minimum turn length, per-cue
   sound/repeat/gap, the per-cue "repeat until you respond" reminder and its
   interval, Test, and Reset. Preferences are browser-local (`localStorage`), not
   host settings.
3. `rebrand`: the browser tab reads **Harness** and the favicon is a neutral
   rounded-square "H". The patch is applied automatically at every boot, so a DSH
   upgrade no longer loses it. If the tab still looks old, the browser cached
   `favicon.svg` — open a fresh tab or hard-reload.

## Managing

```sh
dsh plugin --profile web remove dsh-sound-alerts
dsh plugin --profile web remove dsh-rebrand
```

`rebrand` is configurable from this profile's `cordis.patch.yml` without touching
the package — the row keys are documented in
[`rebrand/cordis.patch.yml`](./rebrand/cordis.patch.yml), and `enabled: false`
turns it into a no-op. `sound-alerts` has no host-side settings; its control is in
the GUI.

## Layout

```
README.md                  this file
install.mjs                install / --check / --wire / --uninstall for this checkout
verify.mjs                 runs all six checks
scripts/
  check-packages.mjs       validates every package against the bundle contract
  check-rebrand-plugin.mjs exercises the rebrand host plugin against a pristine frontend
sound-alerts/
  package.json             declares dsh.bundle + dsh.client (platform: web)
  cordis.patch.yml         the layer this bundle contributes
  lib/index.js             host half: empty apply, so the entry scan sees the package
  lib/client.js            browser half: the header control and the synthesized cues
  verify-client.mjs        behavioural test suite, no browser required
  README.md                the plugin, in detail
rebrand/
  package.json             declares dsh.bundle
  cordis.patch.yml         the layer this bundle contributes (and the config keys)
  lib/index.js             host half: applies the rebrand on boot, never fatal
  lib/apply-rebrand.mjs    the shared apply logic the plugin and the CLI both drive
  lib/patch-web-brand.mjs  patches the minified JS bundle (anchor-based)
  lib/patch-web-shell.mjs  patches index.html, manifest.webmanifest, favicon.svg
  lib/resolve-frontend.mjs finds every installed frontend copy
  lib/verify-web-brand.mjs evaluates the patched components and scans for residual brand
  lib/backups/             pre-patch copies (git-ignored) — also the rollback
  apply-rebrand.mjs        CLI: --check, --all, --dist=DIR
  README.md                what changes, how to verify, how to roll back
```

## Maintenance notes

- **GitHub topics.** For the marketplace to index this repository, it must carry
  the **`dsh-plugin`** topic (Settings → Topics). `deepseek-harness`, `cordis-plugin`,
  and a functional word or two are worth adding for discovery.
- **Version bumps.** The marketplace decides whether to offer an update by comparing
  the `version` in each package's `package.json` against the index. Bump it when you
  change a package, or the update button never appears.
- **The rebrand is build-specific.** Its anchors were derived from
  `@deepseek-ai/dsh-web-frontend@0.1.5-rc.3`. A newer frontend may rename its
  minified symbols; the patcher then refuses loudly (`precondition failed: …`) and
  leaves the bundle untouched, which is the intended outcome. Re-deriving the
  anchors is a deliberate, verifiable job — see [`rebrand/README.md`](./rebrand/README.md).
- **There can be more than one frontend copy** (the profile's, plus one per `npx`
  cache). The rebrand patches the copy the running server actually serves, matched
  over HTTP; `--all` patches every copy.
- **`rebrand/lib/backups/` is git-ignored on purpose** — it holds copies of a
  proprietary published bundle.

## Requirements

- DSH installed and running as the Web GUI (`dsh web`).
- Node.js 20+ for the scripts in this repository (developed against 24).
- pnpm on PATH for the CLI install channel (`dsh plugin` is a pnpm forwarder). The
  marketplace channel does not need it.

## License

[MIT](./LICENSE).
