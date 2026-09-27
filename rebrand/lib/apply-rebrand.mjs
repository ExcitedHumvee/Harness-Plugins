/**
 * Apply the rebrand to installed `@deepseek-ai/dsh-web-frontend` copies.
 *
 * This is the library half of the rebrand: it resolves which frontend install to
 * patch, patches the bundle and the shell files, and verifies the bytes it is
 * about to write before writing them. Two callers use it:
 *
 *   - `lib/index.js`, the Cordis host plugin, which runs it on every DSH boot so
 *     the rebrand survives a DSH upgrade without anyone re-running a script;
 *   - `apply-rebrand.mjs`, the manual CLI for `--check`, `--all`, `--dist=DIR`,
 *     and rollback-oriented reporting.
 *
 * Two design rules keep a cosmetic patch from becoming an availability problem:
 *
 * 1. **Nothing throws out of here.** A frontend whose build moved its minified
 *    symbols makes the patcher refuse (`precondition failed: …`) — that refusal
 *    is a *result*, not an exception. It is reported as `failed` with the reason
 *    and the GUI still starts.
 * 2. **An already-rebranded install is not re-verified.** Verification is the
 *    expensive part, and running it on every boot to re-derive a conclusion the
 *    files already state would make the plugin a startup cost for no gain.
 *    Pass `redo` to override that when something may have overwritten the files.
 *
 * @module dsh-rebrand/apply
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { patchBundleText, patchInstall } from './patch-web-brand.mjs';
import { patchIndexHtml, patchManifest, patchShell, NEUTRAL_MARK_SVG } from './patch-web-shell.mjs';
import { detectServedInstalls, frontendInstalls, installAt } from './resolve-frontend.mjs';
import { verifyBundle, verifyShell } from './verify-web-brand.mjs';

/** The document/app name the rebrand installs. */
export { APP_NAME } from './patch-web-shell.mjs';

/**
 * Read one shell artifact out of an install, or null when it is absent.
 *
 * @param {string} dist - a frontend `dist` directory.
 * @param {string} name - the file name inside it.
 * @returns {string|null} the file's text, or null.
 */
function readIfPresent(dist, name) {
  const file = join(dist, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * Whether every artifact in an install already carries this rebrand.
 *
 * Cheap on purpose: it reads the same bytes the patchers would read, but never
 * re-derives the bundle's element tree.
 *
 * @param {{dist: string, bundle: string|null}} install - a discovered install.
 * @returns {boolean} true when nothing is left to do.
 */
export function isAlreadyPatched(install) {
  if (install.bundle === null || !existsSync(install.bundle)) return false;

  const bundle = readFileSync(install.bundle, 'utf8');
  if (patchBundleText(bundle).status !== 'already-patched') return false;

  const html = readIfPresent(install.dist, 'index.html');
  const manifest = readIfPresent(install.dist, 'manifest.webmanifest');
  const favicon = readIfPresent(install.dist, 'favicon.svg');

  const htmlDone = html === null || !html.includes('DeepSeek');
  const manifestDone = manifest === null || (() => {
    try {
      const parsed = JSON.parse(manifest);
      return parsed.name === 'Harness' && parsed.short_name === 'Harness';
    } catch {
      return false;
    }
  })();
  const faviconDone = favicon === null || favicon.includes('harness-mark-bg');

  return htmlDone && manifestDone && faviconDone;
}

/**
 * Plan one install, turning a refusal into a report instead of an exception.
 *
 * @param {{dist: string, bundle: string|null}} install - a discovered install.
 * @returns {{checks: {label: string, ok: boolean, detail: string}[], status: string, detail: string, alreadyPatched: boolean}} the plan.
 */
export function planInstall(install) {
  // A bundle the patcher cannot even classify is not "already patched"; the
  // guarded block below is what reports why.
  let alreadyPatched = false;
  try {
    alreadyPatched = isAlreadyPatched(install);
  } catch {
    alreadyPatched = false;
  }
  const checks = [];
  let status = alreadyPatched ? 'already-patched' : 'would-patch';
  let detail = '';

  if (install.bundle === null || !existsSync(install.bundle)) {
    return {
      checks: [{ label: 'bundle found', ok: false, detail: 'no index-*.js in dist/assets' }],
      status: 'unpatchable',
      detail: 'no index-*.js in dist/assets',
      alreadyPatched: false,
    };
  }

  try {
    const bundleText = readFileSync(install.bundle, 'utf8');
    const result = patchBundleText(bundleText);
    if (result.detail !== undefined && result.detail !== '') detail = result.detail;
    checks.push(...verifyBundle(result.source));

    const html = readIfPresent(install.dist, 'index.html');
    const manifest = readIfPresent(install.dist, 'manifest.webmanifest');
    const favicon = readIfPresent(install.dist, 'favicon.svg');
    const shell = patchShell(install, { checkOnly: true });
    if (shell.status === 'would-patch') status = 'would-patch';

    checks.push(
      ...verifyShell({
        html: html === null ? null : patchIndexHtml(html).text,
        manifest: manifest === null ? null : patchManifest(manifest).text,
        favicon: favicon !== null && !favicon.includes('harness-mark-bg') ? NEUTRAL_MARK_SVG : favicon,
      }),
    );
  } catch (error) {
    // An anchor mismatch, an unparseable manifest, a half-written bundle: the
    // patcher refuses rather than corrupting the build. Report the refusal.
    return {
      checks: [...checks, { label: 'patch could be derived', ok: false, detail: error instanceof Error ? error.message : String(error) }],
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      alreadyPatched: false,
    };
  }

  if (checks.some((entry) => !entry.ok)) status = 'failed';
  return { checks, status, detail, alreadyPatched };
}

/**
 * Choose which installs to patch.
 *
 * The order matters on a machine with several copies: the profile's copy is
 * scanned first, and when a server answers, only the copies whose bundle bytes
 * match what it serves are targeted. Patching a copy nobody serves would look
 * like a rebrand that silently did nothing.
 *
 * @param {{all?: boolean, dist?: string|null, detectServed?: boolean, log?: (line: string) => void}} [options] - selection options.
 * @returns {Promise<{targets: {dist: string, bundle: string|null}[], installs: {dist: string}[]}>} the targets and everything found.
 */
export async function resolveTargets(options = {}) {
  const { all = false, dist = null, detectServed = true, log = () => {} } = options;
  const installs = frontendInstalls();

  if (dist !== null) return { targets: [installAt(dist)], installs };
  if (installs.length === 0) return { targets: [], installs };
  if (all) return { targets: installs, installs };

  if (detectServed) {
    const served = await detectServedInstalls(installs);
    if (served !== null) {
      const targets = installs.filter((install) => served.dists.includes(install.dist));
      log(`served over HTTP (${served.servedUrl}): ${String(targets.length)} matching install(s)`);
      for (const install of targets) log(`  ${install.dist}`);
      return { targets, installs };
    }
  }

  log('could not match a running server; using the first discovered install');
  return { targets: installs.slice(0, 1), installs };
}

/**
 * Apply the rebrand to the selected installs.
 *
 * @param {{all?: boolean, dist?: string|null, check?: boolean, redo?: boolean, detectServed?: boolean, log?: (line: string) => void}} [options] - apply options; `redo` re-applies even when the install already looks rebranded, `check` reports without writing.
 * @returns {Promise<{status: string, failures: number, results: {dist: string, status: string, detail: string}[], untouched: {dist: string}[]}>} the outcome.
 */
export async function applyRebrand(options = {}) {
  const { check = false, redo = false, log = () => {} } = options;
  const { targets, installs } = await resolveTargets(options);

  if (targets.length === 0) {
    return { status: 'no-frontend', failures: 0, results: [], untouched: [] };
  }

  const results = [];
  let failures = 0;

  for (const install of targets) {
    const plan = planInstall(install);

    if (check) {
      const failed = plan.checks.filter((entry) => !entry.ok);
      failures += failed.length;
      log(`install: ${install.dist}`);
      log(`  status: ${plan.status}`);
      if (plan.detail !== '' && plan.status === 'failed') log(`  reason: ${plan.detail}`);
      for (const entry of plan.checks) {
        log(entry.ok ? `  ok   ${entry.label}` : `  FAIL ${entry.label}${entry.detail === '' ? '' : ` — ${entry.detail}`}`);
      }
      results.push({ dist: install.dist, status: plan.status, detail: plan.detail });
      continue;
    }

    // Nothing to do: skip quietly, without re-reading the bundle's element tree.
    if (plan.alreadyPatched && !redo) {
      results.push({ dist: install.dist, status: 'already-patched', detail: 'already rebranded' });
      continue;
    }

    if (plan.status === 'unpatchable') {
      failures += 1;
      log(`install: ${install.dist}`);
      log('  FAIL no patchable bundle was found');
      results.push({ dist: install.dist, status: 'unpatchable', detail: plan.detail });
      continue;
    }

    log(`install: ${install.dist}`);
    try {
      const bundle = patchInstall(install);
      const shell = patchShell(install);
      log(`  bundle: ${bundle.status} — ${bundle.detail}`);
      log(`  shell:  ${shell.status} — ${shell.detail}`);

      const checks = [
        ...verifyBundle(readFileSync(install.bundle, 'utf8')),
        ...verifyShell({
          html: readIfPresent(install.dist, 'index.html'),
          manifest: readIfPresent(install.dist, 'manifest.webmanifest'),
          favicon: readIfPresent(install.dist, 'favicon.svg'),
        }),
      ];
      for (const entry of checks) {
        if (!entry.ok) failures += 1;
        log(entry.ok ? `  ok   ${entry.label}` : `  FAIL ${entry.label}${entry.detail === '' ? '' : ` — ${entry.detail}`}`);
      }

      results.push({ dist: install.dist, status: 'patched', detail: `${bundle.detail}; ${shell.detail}` });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures += 1;
      log(`  FAIL ${reason}`);
      results.push({ dist: install.dist, status: 'failed', detail: reason });
    }
  }

  const untouched = installs.filter((install) => !targets.includes(install));
  return { status: failures > 0 ? 'failed' : check ? 'checked' : 'applied', failures, results, untouched };
}
