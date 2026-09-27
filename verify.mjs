/**
 * Check everything in this repository, end to end.
 *
 * Six questions, asked in order:
 *
 *   1. Does every script here parse?
 *   2. Does every plugin package satisfy the bundle contract DSH installs from?
 *      (`node install.mjs --check` reads the package manifests through the same
 *      discovery the installer uses, so a package that stops being installable
 *      fails here rather than at install time.)
 *   3. Does the `sound-alerts` browser half behave? (`sound-alerts/verify-client.mjs`)
 *   4. Does the `rebrand` host half behave — patches, re-runs idempotently, never
 *      throws? (`scripts/check-rebrand-plugin.mjs`, against the pristine
 *      pre-patch frontend kept in `rebrand/lib/backups/`.)
 *   5. Is the frontend rebrand in effect on this machine? (`rebrand/apply-rebrand.mjs --check`)
 *   6. Is every plugin installed into the DSH profile? (`install.mjs --check`)
 *
 * Steps 5 and 6 read the machine, not just the checkout, so a failure there means
 * "not installed here (yet)" rather than "bad code". Step 4 needs the patcher's
 * own pre-patch backup as its input; on a fresh clone that backup does not exist
 * yet, and the step reports a skip rather than a failure — the bundle contract in
 * step 2 still proves the patchers are present and loadable.
 *
 * Usage:
 *   node verify.mjs
 *
 * Exit code 0 means every step that could run passed.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Skip vendored trees, VCS metadata, and the pre-patch backup directory. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'backups']);

/**
 * Every `.js` / `.mjs` file in this checkout.
 *
 * @param {string} [dir] - directory to walk.
 * @returns {string[]} absolute paths.
 */
function scriptFiles(dir = here) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...scriptFiles(join(dir, entry.name)));
      continue;
    }
    if (/\.m?js$/.test(entry.name)) files.push(join(dir, entry.name));
  }
  return files;
}

/**
 * Run a child Node script with inherited stdio.
 *
 * @param {string} script - absolute script path.
 * @param {string[]} [args] - arguments for it.
 * @returns {boolean} true when it exits 0.
 */
function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', cwd: here });
  if (result.error !== undefined) {
    console.log(`  FAIL could not run ${script}: ${String(result.error)}`);
    return false;
  }
  return result.status === 0;
}

/** @type {{label: string, ok: boolean}[]} */
const results = [];

console.log('1/6  syntax');
{
  const files = scriptFiles();
  let bad = 0;
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      bad += 1;
      console.log(`  FAIL ${relative(here, file)}`);
      console.log(String(result.stderr).trim());
    }
  }
  if (bad === 0) console.log(`  ok   ${String(files.length)} script(s) parse`);
  results.push({ label: 'scripts parse', ok: bad === 0 });
}

console.log('');
console.log('2/6  bundle contract');
{
  const ok = run(join(here, 'scripts', 'check-packages.mjs'));
  results.push({ label: 'every plugin package is installable as a bundle', ok });
}

console.log('');
console.log('3/6  sound-alerts behaviour');
{
  const ok = run(join(here, 'sound-alerts', 'verify-client.mjs'));
  results.push({ label: 'sound-alerts client behaviour', ok });
}

console.log('');
console.log('4/6  rebrand host plugin behaviour');
{
  // The patcher's own pre-patch backup is a pristine frontend, which is exactly
  // what the harness needs as input. Reassemble a dist/ from it in a temp dir.
  const backups = join(here, 'rebrand', 'lib', 'backups');
  const names = ['index.html', 'manifest.webmanifest', 'favicon.svg'];
  const bundleName = existsSync(backups)
    ? readdirSync(backups).find((name) => /^index-.*\.js\.orig-backup$/.test(name))
    : undefined;
  const missing = names.filter((name) => !existsSync(join(backups, `${name}.orig-backup`)));

  if (bundleName === undefined || missing.length > 0) {
    const missingList = bundleName === undefined ? [...missing, 'index-*.js'] : missing;
    console.log(`  skip no pre-patch backup in rebrand/lib/backups/ (missing: ${missingList.join(', ')})`);
    console.log('       run `node rebrand/apply-rebrand.mjs` once against a pristine frontend to create it,');
    console.log('       then re-run this check to exercise the host plugin end to end.');
  } else {
    const root = mkdtempSync(join(tmpdir(), 'verify-rebrand-'));
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    for (const name of names) copyFileSync(join(backups, `${name}.orig-backup`), join(dist, name));
    copyFileSync(join(backups, bundleName), join(dist, 'assets', bundleName.replace(/\.orig-backup$/, '')));

    const ok = run(join(here, 'scripts', 'check-rebrand-plugin.mjs'), [dist]);
    results.push({ label: 'rebrand host plugin patches, is idempotent, and fails safe', ok });
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('');
console.log('5/6  rebrand in effect');
{
  const ok = run(join(here, 'rebrand', 'apply-rebrand.mjs'), ['--check']);
  results.push({ label: 'frontend rebrand applied and verified', ok });
}

console.log('');
console.log('6/6  profile installation');
{
  const ok = run(join(here, 'install.mjs'), ['--check']);
  results.push({ label: 'plugins installed into the DSH profile', ok });
}

const failed = results.filter((entry) => !entry.ok);
console.log('');
console.log(failed.length === 0 ? 'all checks passed' : `${String(failed.length)} step(s) failed:`);
for (const entry of failed) console.log(`  - ${entry.label}`);
process.exit(failed.length === 0 ? 0 : 1);
