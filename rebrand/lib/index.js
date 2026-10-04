/**
 * Node half of the rebrand plugin: keep the installed DSH web frontend rebranded.
 *
 * The rebrand is not a browser feature — it edits the *published* frontend
 * artifacts in place (`dist/index.html`, `dist/manifest.webmanifest`,
 * `dist/favicon*.svg`, `dist/assets/index-*.js`) — so it lives here, in a host
 * plugin, rather than in a `dsh.client` bundle.
 *
 * Running it on boot is what makes the rebrand an installable plugin instead of a
 * script somebody has to remember to re-run: a DSH upgrade replaces `dist/` and
 * would otherwise silently restore the DeepSeek wordmark.
 *
 * Three properties of that boot behavior matter:
 *
 * - **Idempotent.** Every rewrite detects its own output, so the second boot
 *   writes nothing. The patch also refuses to write when it cannot verify the
 *   result, so a frontend whose minified symbols moved is left untouched.
 * - **Never fatal.** A failure is logged and the boot continues. The rebrand is
 *   cosmetic; a GUI that will not start because a logo could not be removed is a
 *   worse outcome than a logo that stayed.
 * - **Targeted.** Only the copy the running server actually serves is patched
 *   (matched over HTTP against local files), falling back to the profile's copy.
 *
 * Configuration (set on this plugin's row in a profile `cordis.patch.yml`):
 *
 * ```yaml
 * - id: rebrand
 *   name: dsh-rebrand
 *   config:
 *     enabled: true          # false turns the plugin into a no-op without uninstalling
 *     everyBoot: false       # true re-verifies and re-patches on every boot
 *     detectServed: true     # false skips the HTTP probe and uses the first install
 *     all: false             # true patches every frontend copy found on the machine
 *     dist: null             # an explicit dist/ directory, bypassing discovery
 * ```
 *
 * @module dsh-rebrand
 */

import { applyRebrand } from './apply-rebrand.mjs';

export const name = 'dsh-rebrand';

/**
 * @typedef {object} Config
 * @property {boolean} [enabled] - turn the whole plugin off without uninstalling it.
 * @property {boolean} [everyBoot] - re-verify and re-patch on every boot instead of only when the install is not yet rebranded.
 * @property {boolean} [detectServed] - probe the running server to pick the frontend copy it serves.
 * @property {boolean} [all] - patch every frontend copy found, not only the served one.
 * @property {string|null} [dist] - an explicit `dist/` directory to patch.
 */

/** Defaults, applied over whatever the loader row carries. */
const DEFAULTS = {
  enabled: true,
  everyBoot: false,
  detectServed: true,
  all: false,
  dist: null,
};

/**
 * Normalize the row's config, tolerating absent or mistyped values.
 *
 * The values here only steer *which* copy is patched and how loudly it reports;
 * a bad value must not be able to fail a boot, so anything unrecognized falls
 * back to the default rather than throwing.
 *
 * @param {unknown} raw - the config the loader passed.
 * @returns {Required<Config>} the effective config.
 */
function normalize(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  const bool = (key) => (typeof value[key] === 'boolean' ? value[key] : DEFAULTS[key]);
  return {
    enabled: bool('enabled'),
    everyBoot: bool('everyBoot'),
    detectServed: bool('detectServed'),
    all: bool('all'),
    dist: typeof value.dist === 'string' && value.dist !== '' ? value.dist : DEFAULTS.dist,
  };
}

/**
 * Apply the rebrand once per boot.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the host plugin context.
 * @param {Config} [config] - the row's config.
 * @returns {Promise<void>} settlement after the rebrand pass.
 */
export async function apply(ctx, config) {
  const options = normalize(config);
  if (!options.enabled) {
    ctx.logger?.info?.('rebrand: disabled by config — the frontend is left as installed');
    return;
  }

  const log = (line) => ctx.logger?.info?.(line) ?? console.log(line);

  /** @type {{status: string, failures: number, results: {dist: string, status: string, detail: string}[], untouched: {dist: string}[]}} */
  let outcome;
  try {
    outcome = await applyRebrand({
      all: options.all,
      dist: options.dist,
      detectServed: options.detectServed,
      redo: options.everyBoot,
      check: false,
      log,
    });
  } catch (error) {
    // Discovery or parsing failed in a way the per-install plan did not catch.
    ctx.logger?.warn?.(`rebrand: could not run — ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (outcome.status === 'no-frontend') {
    ctx.logger?.warn?.(
      'rebrand: no @deepseek-ai/dsh-web-frontend install found; set DSH_HOME, or this plugin\'s config.dist, to patch one',
    );
    return;
  }

  for (const result of outcome.results) {
    if (result.status === 'already-patched') {
      ctx.logger?.debug?.(`rebrand: already applied — ${result.dist}`);
      continue;
    }
    log(`rebrand: ${result.status} — ${result.dist}`);
  }

  if (outcome.failures > 0) {
    ctx.logger?.warn?.(
      `rebrand: ${String(outcome.failures)} check(s) failed — the frontend was left untouched. ` +
        'The installed @deepseek-ai/dsh-web-frontend build may have changed the brand artwork, or the shape of the ' +
        'components this patch recognizes; run `node rebrand/apply-rebrand.mjs --check` for the anchor that moved.',
    );
  }
}
