# dsh-rebrand

Removes the DeepSeek wordmark and logo from the DSH Web GUI and renames the
application to **Harness**.

The GUI ships as built artifacts inside the installed
`@deepseek-ai/dsh-web-frontend` package, so there is no source tree to edit: the
rebrand is applied to the published `dist/` in place, and the patch scripts here
are the record of exactly what changed.

## What is changed

| Artifact | Change | Script |
|---|---|---|
| `dist/index.html` | `<title>DeepSeek Harness</title>` → `<title>Harness</title>`, plus `apple-mobile-web-app-title` | `lib/patch-web-shell.mjs` |
| `dist/manifest.webmanifest` | `name` and `short_name` → `Harness` | `lib/patch-web-shell.mjs` |
| `dist/favicon.svg` | DeepSeek whale replaced with a neutral rounded-square "H" mark | `lib/patch-web-shell.mjs` |
| `dist/assets/index-*.js` | The whale glyph and the outlined "DeepSeek" lockup removed | `lib/patch-web-brand.mjs`, resolving names via `lib/bundle-symbols.mjs` |

The bundle and the shell are two separate halves of the same job: the bundle
patch removes the mark from inside the running app, and the shell patch removes
it from the browser chrome (tab title, install name, bookmark icon) that is shown
before any JavaScript runs.

Inside the bundle, three exported primitives carried the brand:

| Export | Was | Now |
|---|---|---|
| `FishLogo` (`cC`) | the whale glyph | a neutral four-point spark |
| `BrandWordmark` (`uC`) | whale + outlined "DeepSeek" + a rounded badge whose glyph paths spell "DS" | the word `HARNESS` |
| `FISH_LOGO_PATH` / `FISH_LOGO_VIEWBOX` (`$6` / `Mr`) | the whale path and its 23.16 × 17.04 box | the neutral glyph and its 16 × 16 box |

The `FISH_LOGO_PATH` / `FISH_LOGO_VIEWBOX` export **names** are kept even though
the brand is gone: they are part of the published `ui-primitives` surface, so
renaming them would break any consumer that imports them. Their values no longer
describe DeepSeek artwork, which is what makes the mark unreachable from anywhere
in the UI.

References to `@deepseek-ai/*` package names, CSS custom properties such as
`--dsw-static-deepseek-450` (a color token, never rendered as text), and module
ids are intentionally untouched: they are not user-visible branding, and changing
them would break the plugin and module graph.

## Installing it

```sh
dsh plugin --profile web add "github:ExcitedHumvee/Harness-Plugins#path:/rebrand"
```

Then **restart DSH** (`dsh web`). A bundle is composed at boot, so unlike a profile
patch-file edit it is not picked up by `patchReload: live` — and the boot is
exactly when this plugin does its work.

`dsh plugin` forwards to pnpm in the profile directory, so pnpm must be on PATH
(`corepack enable pnpm`). On Windows, install from a path without spaces — DSH
forwards the argument through `cmd.exe`, which splits it.

To remove it:

```sh
dsh plugin --profile web remove dsh-rebrand
```

### It patches on every boot

This is a host plugin (`lib/index.js`), not a script you have to remember to
re-run. On activation it finds the frontend the running server actually serves,
applies the patch, and verifies the result. Three properties make that safe:

- **Idempotent.** Every rewrite detects its own output, so a second boot writes
  nothing; an install that is already rebranded is recognized without re-deriving
  the bundle's element tree.
- **Never fatal.** If the frontend is a build the anchors do not match, the
  patcher refuses, the reason is logged, and the GUI starts anyway. A rebrand that
  cannot apply must not become a DSH that will not boot.
- **Survives an upgrade.** Reinstalling `@deepseek-ai/dsh-web-frontend` replaces
  `dist/`; the next boot puts the rebrand back.

### Configuration

The plugin's row is configurable from the profile's own `cordis.patch.yml`, which
wins over the bundle's layer. Every key is optional:

```yaml
- id: rebrand
  config:
    enabled: true          # false makes the row a no-op without uninstalling
    everyBoot: false       # true re-verifies and re-patches on every boot
    detectServed: true     # probe the running server and patch the copy it serves
    all: false             # patch every frontend copy on the machine
    dist: null             # an explicit dist/ directory, bypassing discovery
```

### Applying it by hand

The CLI drives the same code as the plugin, and adds the modes a boot pass cannot
offer — a report of what would change, and a choice of target:

```sh
# Dry run: report what would change and verify the prospective result, touch nothing.
node rebrand/apply-rebrand.mjs --check

# Apply (idempotent: an already-patched install is reported and skipped).
node rebrand/apply-rebrand.mjs

node rebrand/apply-rebrand.mjs --all          # every copy found on this machine
node rebrand/apply-rebrand.mjs --dist=DIR     # one specific dist/ directory
DSH_WEB_FRONTEND_BUNDLE=/path/to/index-<hash>.js node rebrand/lib/patch-web-brand.mjs
```

`--dist=DIR` and `DSH_WEB_FRONTEND_DIST`/`DSH_WEB_FRONTEND_BUNDLE` also exist on
the individual patchers and on the verifier.

Every patcher writes pre-patch copies into `rebrand/lib/backups/` before its first
change, and refuses to write when it cannot complete every replacement.

### Why the bundle patch is anchor-based

`lib/patch-web-brand.mjs` is written against exact byte anchors rather than line
numbers or formatting, because the bundle is minified production output on one
line. It asserts every anchor before touching anything, refuses to run when an
anchor is missing or ambiguous, writes only after all replacements succeed, and
re-checks the result. It also terminates declarations by brace balancing that is
string-literal aware — the bundle carries `{` and `}` inside SVG path data and
quoted text — and skips a function's parameter list before balancing, because
default parameter values are object literals (`{size:t=24}`) whose braces would
otherwise be mistaken for the function body.

**The anchors are brand geometry, not minified identifiers.** `bundle-symbols.mjs`
resolves every build-specific name at patch time instead of hardcoding it:

| What | How it is found |
|---|---|
| the JSX runtime local (`d`, then `l`) | the `.jsx(`/`.jsxs(` call inside a component already identified |
| `FishLogo` / `BrandWordmark` (`cC`/`uC`, then `G_`/`K_`) | the package's own **export map** (`FishLogo:G_`), cross-checked against each component's props signature and the brand geometry in its body |
| `FISH_LOGO_PATH` / `FISH_LOGO_VIEWBOX` locals (`$6`/`Mr`, then `K6`/`lo`) | the same export map, confirmed against the whale-path literal |
| each function's parameter names (`size:e`, `className:n`, …) | the matched declaration itself |

The exported names are part of the package's API and survive minification; the
artwork bytes (whale path, "DeepSeek" lettering, "DS" badge) are stable across
builds. Those two signals are what the patch pins.

This matters because the distinction is the difference between working across an
upgrade and refusing across it. The patch originally hardcoded `d`, `cC`, `uC`,
`Mr`, `$6` — the names in `@deepseek-ai/dsh-web-frontend@0.1.5-rc.3` — and when
the frontend moved to `0.2.0-rc.2` (entry bundle `index-5SrrfWpU.js`) the
minifier renamed all of them and the patcher stopped with
`precondition failed: …`. That refusal is still the correct outcome for a build
whose **shape** the patch cannot recognize, and it never corrupts the bundle —
but a renamed symbol is no longer enough to trigger it. `lib/verify-web-brand.mjs`
resolves its anchors the same way, so the verifier cannot drift from the patcher.

## Verifying

```sh
node rebrand/apply-rebrand.mjs --check              # every install / the served one
node rebrand/lib/verify-web-brand.mjs               # the served/first install
node rebrand/lib/verify-web-brand.mjs --all         # every install found
```

`node --check` only proves the patched bundle parses. `verify-web-brand.mjs`
closes the gap: it slices the patched `BrandWordmark` and `FishLogo` declarations
and their shared path constants out of the live bundle, evaluates them against a
minimal React stub, and asserts on the resulting element trees — that the whale
path is gone, that `BrandWordmark` renders exactly the string `HARNESS` with no
SVG paths, that `FishLogo` renders one non-whale path in a 16 × 16 box, and that
both still honor `size` and `className`. It then scans the whole bundle for
residual brand geometry and for a user-visible `"DeepSeek` literal, and checks the
shell files for the title, manifest names, and favicon mark.

`lib/apply-rebrand.mjs` — the same code the plugin and the CLI run — applies the
same checks against the bytes it is about to write, and again from disk
afterwards, so a patch that parses but renders the wrong mark fails the install
instead of shipping. `node ../../scripts/check-rebrand-plugin.mjs <pristine-dist>`
exercises the host plugin itself: that it patches, is idempotent, honors
`enabled: false`, and reports rather than throws on an unrecognizable bundle.

## After applying

The frontend dist is served straight from disk, so the rebrand takes effect when
the page reloads — no server restart is needed for the shell files.

Two browser caches are worth knowing about:

- **favicon.svg** is cached aggressively. If the old mark is still showing, hard-reload
  (Ctrl+Shift+R) or add the page to a fresh tab.
- The **app title** likewise comes from `index.html`, so a reload picks it up.

Reinstalling or upgrading `@deepseek-ai/dsh-web-frontend` replaces `dist/`. With the
plugin installed there is nothing to do — the next boot reapplies it. Without the
plugin, re-run `node rebrand/apply-rebrand.mjs`. The bundle's content-hashed
filename changes on upgrade, which is why the patcher reads the filename out of
`index.html` rather than hardcoding it.

## Rolling back

Restore the pre-patch copies and reload:

```sh
# lib/backups/ holds the pre-patch file for every artifact this tooling touched
copy rebrand\lib\backups\index-<hash>.js.orig-backup  <dist>\assets\index-<hash>.js
copy rebrand\lib\backups\index.html.orig-backup       <dist>\index.html
copy rebrand\lib\backups\manifest.webmanifest.orig-backup <dist>\manifest.webmanifest
copy rebrand\lib\backups\favicon.svg.orig-backup      <dist>\favicon.svg
```

Then, if the plugin is installed, disable it — otherwise the next boot puts the
rebrand straight back:

```yaml
- id: rebrand
  config:
    enabled: false
```

Backups live in `rebrand/lib/backups/` (git-ignored) rather than beside the live
files on purpose: the frontend-static server serves **any** file under `dist/`
whose extension it does not recognize as `application/octet-stream`, so a backup
left in `dist/assets/` would be downloadable from `/assets/…` — an orphaned copy
of the brand that was just removed, reachable by URL.

## Renaming it to something else

`APP_NAME` in `lib/patch-web-shell.mjs` sets the title and manifest name, and the
`HARNESS` literal inside `harnessWordmarkReplacement()` in
`lib/patch-web-brand.mjs` carries the uppercase in-app wordmark. Change both, and
change `PATCHED_MARKER` in `lib/bundle-symbols.mjs` to match the new literal, since
that is what "already patched" detection keys on. Then re-run against a pristine
bundle (restore a backup first).
