/**
 * Apply the full rebrand: the JavaScript bundle, the shell artifacts, and a
 * verification pass over the result.
 *
 * This is the entry point to use. It resolves the installed frontend, patches
 * both halves, and then runs the same assertions `verify-web-brand.mjs` runs —
 * against the text that was just produced, in memory before writing and again
 * from disk after. A patch that parses but renders the wrong mark therefore
 * fails the install instead of shipping.
 *
 * Usage:
 *   node rebrand/apply-rebrand.mjs --check      # report what would change, write nothing
 *   node rebrand/apply-rebrand.mjs              # patch the served install
 *   node rebrand/apply-rebrand.mjs --all        # patch every install found on this machine
 *   node rebrand/apply-rebrand.mjs --dist=DIR   # patch one specific install
 *
 * Pre-patch copies land in `rebrand/backups/`; restoring one and reloading the
 * page is the whole rollback.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { patchBundleText, patchInstall } from './patch-web-brand.mjs';
import { patchIndexHtml, patchManifest, patchShell, NEUTRAL_MARK_SVG } from './patch-web-shell.mjs';
import { detectServedInstalls, frontendInstalls, installAt } from './resolve-frontend.mjs';
import { verifyBundle, verifyShell } from './verify-web-brand.mjs';

const CHECK_ONLY = process.argv.includes('--check');
const ALL = process.argv.includes('--all');
const DIST_ARG = process.argv.find((arg) => arg.startsWith('--dist='));

/**
 * Patch one install's files in memory and verify the prospective result.
 *
 * Verifying in memory is what lets `--check` report a trustworthy answer: the
 * checks run against exactly the bytes that `--apply` would write.
 *
 * @param {{dist: string, bundle: string|null}} install - a discovered install.
 * @returns {{checks: {label: string, ok: boolean, detail: string}[], status: string}} the report.
 */
function dryRun(install) {
  const checks = [];
  let status = 'already-patched';

  if (install.bundle === null || !existsSync(install.bundle)) {
    checks.push({ label: 'bundle found', ok: false, detail: 'no index-*.js in dist/assets' });
  } else {
    const result = patchBundleText(readFileSync(install.bundle, 'utf8'));
    if (result.status === 'patched') status = 'would-patch';
    checks.push(...verifyBundle(result.source));
  }

  const read = (name) => {
    const file = join(install.dist, name);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };
  const html = read('index.html');
  const manifest = read('manifest.webmanifest');
  const favicon = read('favicon.svg');
  const shell = patchShell(install, { checkOnly: true });
  if (shell.status === 'would-patch' && status === 'already-patched') status = 'would-patch';

  checks.push(
    ...verifyShell({
      html: html === null ? null : patchIndexHtml(html).text,
      manifest: manifest === null ? null : patchManifest(manifest).text,
      favicon: favicon !== null && !favicon.includes('harness-mark-bg') ? NEUTRAL_MARK_SVG : favicon,
    }),
  );

  return { checks, status };
}

/** Print a check list; returns the number of failures. */
function report(checks) {
  let failures = 0;
  for (const entry of checks) {
    if (entry.ok) {
      console.log(`  ok   ${entry.label}`);
    } else {
      failures += 1;
      console.log(`  FAIL ${entry.label}${entry.detail === '' ? '' : ` — ${entry.detail}`}`);
    }
  }
  return failures;
}

async function main() {
  const distArg = DIST_ARG === undefined ? null : DIST_ARG.slice('--dist='.length);
  const installs = frontendInstalls();
  if (installs.length === 0 && distArg === null) {
    console.error('No @deepseek-ai/dsh-web-frontend install found.');
    console.error('Set DSH_HOME, or point at one directly with --dist=DIR or DSH_WEB_FRONTEND_BUNDLE=FILE.');
    process.exit(1);
  }

  let targets;
  if (distArg !== null) {
    const explicit = installAt(distArg);
    if (!existsSync(explicit.dist)) {
      console.error(`--dist=… does not exist: ${explicit.dist}`);
      process.exit(1);
    }
    targets = [explicit];
  } else if (ALL) {
    targets = installs;
  } else {
    const served = await detectServedInstalls(installs);
    if (served !== null) {
      targets = installs.filter((install) => served.dists.includes(install.dist));
      console.log(`served over HTTP (${served.servedUrl}): ${String(targets.length)} matching install(s)`);
      for (const install of targets) console.log(`  ${install.dist}`);
    } else {
      targets = installs.slice(0, 1);
      console.log('could not match a running server; using the first discovered install');
    }
  }

  let failures = 0;
  for (const install of targets) {
    console.log('');
    console.log(`install: ${install.dist}`);

    if (CHECK_ONLY) {
      const { checks, status } = dryRun(install);
      console.log(`  status: ${status}`);
      failures += report(checks);
      continue;
    }

    const bundle = patchInstall(install);
    console.log(`  bundle:          ${bundle.status} — ${bundle.detail}`);
    const shell = patchShell(install);
    console.log(`  shell:           ${shell.status} — ${shell.detail}`);

    if (install.bundle === null || !existsSync(install.bundle)) {
      failures += 1;
      console.log('  FAIL no patchable bundle was found');
      continue;
    }

    const read = (name) => {
      const file = join(install.dist, name);
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    };
    const checks = [
      ...verifyBundle(readFileSync(install.bundle, 'utf8')),
      ...verifyShell({ html: read('index.html'), manifest: read('manifest.webmanifest'), favicon: read('favicon.svg') }),
    ];
    console.log('  verification:');
    const failed = report(checks);
    failures += failed;
  }

  console.log('');
  if (failures > 0) {
    console.log(`${String(failures)} check(s) failed — the frontend is NOT fully rebranded.`);
    process.exit(1);
  }
  if (CHECK_ONLY) {
    console.log('check complete: every install above can be patched cleanly.');
  } else {
    console.log('rebrand applied and verified. Reload the GUI page (Ctrl+Shift+R) to see it.');
    const untouched = installs.filter((install) => !targets.includes(install));
    if (untouched.length > 0) {
      console.log(`note: ${String(untouched.length)} other install(s) left untouched; use --all to patch them:`);
      for (const install of untouched) console.log(`  ${install.dist}`);
    }
  }
  process.exit(0);
}

await main();
