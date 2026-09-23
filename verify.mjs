/**
 * Check everything in this repository, end to end.
 *
 * Five questions, asked in order:
 *
 *   1. Does every script here parse?
 *   2. Does the sound-alerts client behave? (`sound-alerts/verify-client.mjs`)
 *   3. Does the STT composer button behave? (`stt/verify-client.mjs`) — and does
 *      the faster-whisper sidecar answer? (`stt/verify-server.mjs`, which skips
 *      cleanly when nothing is listening)
 *   4. Is the frontend rebrand in effect? (`rebrand/verify-web-brand.mjs`)
 *   5. Is every plugin wired into the DSH profile? (`install.mjs --check`)
 *
 * Steps 4 and 5 read the machine, not just the checkout, so a failure there means
 * "not installed here (yet)" rather than "bad code". Run it after installing to
 * confirm both halves landed.
 *
 * Usage:
 *   node verify.mjs
 *
 * Exit code 0 means all five passed.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Skip vendored trees and the backup directory. */
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

/** Run a child Node script with inherited stdio; returns true when it exits 0. */
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

console.log('1/5  syntax');
{
  let bad = 0;
  for (const file of scriptFiles()) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      bad += 1;
      console.log(`  FAIL ${relative(here, file)}`);
      console.log(String(result.stderr).trim());
    }
  }
  if (bad === 0) console.log(`  ok   ${String(scriptFiles().length)} script(s) parse`);
  results.push({ label: 'scripts parse', ok: bad === 0 });
}

console.log('');
console.log('2/5  sound-alerts behaviour');
{
  const ok = run(join(here, 'sound-alerts', 'verify-client.mjs'));
  results.push({ label: 'sound-alerts client behaviour', ok });
}

console.log('');
console.log('3/5  stt composer button');
{
  const ok = run(join(here, 'stt', 'verify-client.mjs'));
  results.push({ label: 'stt client behaviour', ok });
  // The engine half: /health, the loaded model, and (when a clip is passed on the
  // command line) a transcript. With nothing listening it prints a skip notice and
  // exits 0, so a checkout without the sidecar installed still verifies cleanly.
  run(join(here, 'stt', 'verify-server.mjs'));
}

console.log('');
console.log('4/5  rebrand in effect');
{
  const ok = run(join(here, 'rebrand', 'verify-web-brand.mjs'));
  results.push({ label: 'frontend rebrand applied and verified', ok });
}

console.log('');
console.log('5/5  profile wiring');
{
  const ok = run(join(here, 'install.mjs'), ['--check']);
  results.push({ label: 'plugins wired into the DSH profile', ok });
}

const failed = results.filter((entry) => !entry.ok);
console.log('');
console.log(failed.length === 0 ? 'all checks passed' : `${String(failed.length)} step(s) failed:`);
for (const entry of failed) console.log(`  - ${entry.label}`);
process.exit(failed.length === 0 ? 0 : 1);
