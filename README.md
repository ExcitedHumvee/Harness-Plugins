# DSH Harness Plugins

Drop-in plugins for the **DeepSeek Harness (DSH) Web GUI**: they mount straight
from a git checkout by `file:` URL, with no package install and no build step.

This repository is written to be handed to an AI agent. Point it at this repo and
say "install these plugins"; the agent should read [`AGENTS.md`](./AGENTS.md),
which carries the exact commands, the decision rules, and the failure modes.

| Plugin | What it does |
|---|---|
| [`sound-alerts/`](./sound-alerts/README.md) | Notification sounds: one cue when a final response completes, another when the agent is waiting on your input, with a header control for customizing both |
| [`rebrand/`](./rebrand/README.md) | Removes the DeepSeek wordmark and logo from the shipped web frontend and renames the app to **Harness** |

They are independent: install either one, or both.

## Requirements

- DSH installed and running as the Web GUI (`dsh web`), which installs
  `@deepseek-ai/dsh-web-frontend` into `$DSH_HOME`.
- Node.js 20+ (developed against 24).
- The `web` profile — the default. Another profile works too: pass
  `--profile=<name>`.

## Install

Clone this repository somewhere permanent — the profile row records the
checkout's **absolute path**, so moving or deleting the clone later un-wires the
plugin.

```sh
git clone <this-repo-url> dsh-harness-plugins
cd dsh-harness-plugins

node install.mjs                  # wire sound-alerts into $DSH_HOME/profiles/web
node rebrand/apply-rebrand.mjs    # patch the web frontend to the Harness brand

node verify.mjs                   # confirm code, rebrand, and wiring
```

Then **reload the GUI page** (Ctrl+Shift+R). The `web` profile uses
`patchReload: live`, so no server restart is needed.

Both commands are idempotent, both have a `--check` mode that writes nothing, and
both back up anything they change (`install.mjs` writes
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
verify.mjs                    runs all four checks: syntax, plugin behaviour, rebrand, wiring
sound-alerts/
  package.json                declares dsh.client (platform: web) and exports ./client
  lib/index.js                host half: empty apply, so the entry-scan picks the package up
  lib/client.js               browser half: the header control and the synthesized cues
  verify-client.mjs           behavioural test suite, no browser required
  README.md                   the plugin, in detail
rebrand/
  README.md                   what changes, how to apply, how to verify, how to roll back
  resolve-frontend.mjs        finds every installed @deepseek-ai/dsh-web-frontend copy
  patch-web-brand.mjs         patches the minified JS bundle (anchor-based)
  patch-web-shell.mjs         patches index.html, manifest.webmanifest, favicon.svg
  apply-rebrand.mjs           apply both halves, then verify the result
  verify-web-brand.mjs        evaluates the patched components and scans for residual brand
```

## Caveats worth knowing

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
