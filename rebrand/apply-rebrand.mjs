/**
 * Apply the rebrand from the command line.
 *
 * This is the manual half of the rebrand, kept for the things a boot pass cannot
 * do: inspect what would change (`--check`), patch every copy on the machine
 * (`--all`), point at one specific install (`--dist=DIR`), and read a report
 * suitable for handing to someone when an anchor stops matching.
 *
 * The library it drives — `lib/apply-rebrand.mjs` — is the same one the Cordis
 * host plugin (`lib/index.js`) runs on every boot, so there is exactly one
 * implementation of "what the rebrand does". Installing the plugin is the
 * normal path; this script is what you reach for when you want to see or steer
 * the work yourself.
 *
 * Usage:
 *   node rebrand/apply-rebrand.mjs --check      # report what would change, write nothing
 *   node rebrand/apply-rebrand.mjs              # patch the served install
 *   node rebrand/apply-rebrand.mjs --all        # patch every install found on this machine
 *   node rebrand/apply-rebrand.mjs --dist=DIR   # patch one specific install
 *
 * Pre-patch copies land in `rebrand/lib/backups/`; restoring one and reloading
 * the page is the whole rollback.
 */

import { applyRebrand, resolveTargets } from './lib/apply-rebrand.mjs';
import { frontendInstalls } from './lib/resolve-frontend.mjs';

const CHECK_ONLY = process.argv.includes('--check');
const ALL = process.argv.includes('--all');
const DIST_ARG = process.argv.find((arg) => arg.startsWith('--dist='));
const DIST = DIST_ARG === undefined ? null : DIST_ARG.slice('--dist='.length);

const outcome = await applyRebrand({
  check: CHECK_ONLY,
  all: ALL,
  dist: DIST,
  detectServed: DIST === null && !ALL,
  log: (line) => console.log(line),
});

if (outcome.status === 'no-frontend') {
  console.error('No @deepseek-ai/dsh-web-frontend install found.');
  console.error('Set DSH_HOME, or point at one directly with --dist=DIR or DSH_WEB_FRONTEND_BUNDLE=FILE.');
  process.exit(1);
}

if (DIST !== null && outcome.results.length === 0) {
  console.error(`--dist=… did not resolve to a patchable install: ${DIST}`);
  process.exit(1);
}

console.log('');
if (outcome.failures > 0) {
  console.log(`${String(outcome.failures)} check(s) failed — the frontend is NOT fully rebranded.`);
  process.exit(1);
}
if (CHECK_ONLY) {
  console.log('check complete: every install above can be patched cleanly.');
} else {
  console.log('rebrand applied and verified. Reload the GUI page (Ctrl+Shift+R) to see it.');
  if (outcome.untouched.length > 0) {
    console.log(`note: ${String(outcome.untouched.length)} other install(s) left untouched; use --all to patch them:`);
    for (const install of outcome.untouched) console.log(`  ${install.dist}`);
  }
}

// Surface a discovery mismatch the caller may want to act on.
const discovered = frontendInstalls().length;
if (discovered === 0 && DIST === null) {
  console.error('note: no install was discovered at all; the run above patched nothing.');
  process.exit(1);
}
