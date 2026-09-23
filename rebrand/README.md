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
| `dist/index.html` | `<title>DeepSeek Harness</title>` → `<title>Harness</title>`, plus `apple-mobile-web-app-title` | `patch-web-shell.mjs` |
| `dist/manifest.webmanifest` | `name` and `short_name` → `Harness` | `patch-web-shell.mjs` |
| `dist/favicon.svg` | DeepSeek whale replaced with a neutral rounded-square "H" mark | `patch-web-shell.mjs` |
| `dist/assets/index-*.js` | The whale glyph and the outlined "DeepSeek" lockup removed | `patch-web-brand.mjs` |

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

## Applying it

```sh
# Dry run: report what would change and verify the prospective result, touch nothing.
node rebrand/apply-rebrand.mjs --check

# Apply (idempotent: an already-patched install is reported and skipped).
node rebrand/apply-rebrand.mjs
```

The install is discovered automatically (`$DSH_HOME`, then the npx caches). When
more than one copy exists, the default target is every copy whose bundle bytes
match what the running server serves — matched by fetching `/assets/<bundle>`
over HTTP, which is public even though the shell HTML needs authentication — and
the fallback is the profile's copy when no server answers. To be explicit:

```sh
node rebrand/apply-rebrand.mjs --all          # every copy found on this machine
node rebrand/apply-rebrand.mjs --dist=DIR     # one specific dist/ directory
DSH_WEB_FRONTEND_BUNDLE=/path/to/index-<hash>.js node rebrand/patch-web-brand.mjs
```

`--dist=DIR` and `DSH_WEB_FRONTEND_DIST`/`DSH_WEB_FRONTEND_BUNDLE` also exist on
the individual patchers and on the verifier.

Every patcher writes pre-patch copies into `rebrand/backups/` before its first
change, and refuses to write when it cannot complete every replacement.

### Why the bundle patch is anchor-based

`patch-web-brand.mjs` is written against exact byte anchors rather than line
numbers or formatting, because the bundle is minified production output on one
line. It asserts every anchor before touching anything, refuses to run when an
anchor is missing or ambiguous, writes only after all replacements succeed, and
re-checks the result. It also terminates declarations by brace balancing that is
string-literal aware — the bundle carries `{` and `}` inside SVG path data and
quoted text — and skips a function's parameter list before balancing, because
default parameter values are object literals (`{size:t=24}`) whose braces would
otherwise be mistaken for the function body.

**This makes the patch build-specific.** The anchors describe the frontend build
it was written against (`@deepseek-ai/dsh-web-frontend@0.1.5-rc.3`, whose entry
bundle is `index-BKQ_L1z6.js`). A newer `@deepseek-ai/dsh-web-frontend` will very
plausibly rename its minified symbols and change its path data, and the patcher
then stops with `precondition failed: …` instead of corrupting the bundle. That
is the intended outcome. Re-deriving the anchors against the new build is a
deliberate, verified job — the six anchors are listed at the top of
`patch-web-brand.mjs`, and `verify-web-brand.mjs` is what proves the new
replacement renders.

## Verifying

```sh
node rebrand/verify-web-brand.mjs          # the served/first install
node rebrand/verify-web-brand.mjs --all    # every install found
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

`apply-rebrand.mjs` runs the same checks — against the bytes it is about to write
before writing them, and again from disk afterwards — so a patch that parses but
renders the wrong mark fails the install instead of shipping.

## After applying

The frontend dist is served straight from disk, so the rebrand takes effect when
the page reloads — no server restart is needed for the shell files.

Two browser caches are worth knowing about:

- **favicon.svg** is cached aggressively. If the old mark is still showing, hard-reload
  (Ctrl+Shift+R) or add the page to a fresh tab.
- The **app title** likewise comes from `index.html`, so a reload picks it up.

Reinstalling or upgrading `@deepseek-ai/dsh-web-frontend` replaces `dist/` and the
rebrand is lost; re-run `node rebrand/apply-rebrand.mjs`. The bundle's
content-hashed filename changes on upgrade, which is why the patcher reads the
filename out of `index.html` rather than hardcoding it.

## Rolling back

```sh
# backups/ holds the pre-patch file for every artifact this tooling touched
copy rebrand\backups\index-<hash>.js.orig-backup  <dist>\assets\index-<hash>.js
copy rebrand\backups\index.html.orig-backup       <dist>\index.html
copy rebrand\backups\manifest.webmanifest.orig-backup <dist>\manifest.webmanifest
copy rebrand\backups\favicon.svg.orig-backup      <dist>\favicon.svg
```

Backups live in `rebrand/backups/` (git-ignored) rather than beside the live
files on purpose: the frontend-static server serves **any** file under `dist/`
whose extension it does not recognize as `application/octet-stream`, so a backup
left in `dist/assets/` would be downloadable from `/assets/…` — an orphaned copy
of the brand that was just removed, reachable by URL.

## Renaming it to something else

`APP_NAME` in `patch-web-shell.mjs` sets the title and manifest name, and
`HARNESS_WORDMARK` in `patch-web-brand.mjs` carries the uppercase in-app wordmark.
Change both, then re-run against a pristine bundle (restore a backup first) — the
"already patched" detection keys on the default name.
