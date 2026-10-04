/**
 * Host-plugin harness: run `rebrand/lib/index.js` `apply()` against a stub
 * context and a pristine frontend, and prove it (a) patches, (b) is idempotent,
 * (c) honours `enabled: false`, and (d) never throws when the frontend is
 * unrecognizable.
 *
 * This exercises the exact function the Cordis Loader calls, without booting a
 * profile. The package declares no dependencies and imports nothing from DSH, so
 * a stub context is an honest stand-in here — the real boot is verified
 * separately by loading the bundle into a profile.
 *
 * Usage:
 *   node scripts/check-rebrand-plugin.mjs <pristine-dist>
 *
 * Get a pristine dist with:
 *   npm pack @deepseek-ai/dsh-web-frontend@<version> && tar -xzf <tarball>
 *   node scripts/check-rebrand-plugin.mjs ./package/dist
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../rebrand/lib/index.js';
import { bundleIn } from '../rebrand/lib/resolve-frontend.mjs';

const source = process.argv[2];
if (source === undefined || !existsSync(source)) {
  console.error('usage: node scripts/check-rebrand-plugin.mjs <pristine-dist>');
  process.exit(2);
}

let failures = 0;
/**
 * Record one check.
 *
 * @param {string} label - what was checked.
 * @param {boolean} condition - the result.
 * @param {string} [detail] - context printed on failure.
 */
function ok(label, condition, detail = '') {
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
  if (!condition) failures += 1;
}

/**
 * A stub Cordis context that records what the plugin logged.
 *
 * @returns {{lines: string[], logger: Record<string, (line: string) => undefined>}} the stub.
 */
function stubContext() {
  const lines = [];
  const record = (line) => {
    lines.push(String(line));
    return undefined;
  };
  return { lines, logger: { info: record, warn: record, error: record, debug: () => undefined } };
}

/**
 * Copy the pristine dist into a fresh temp directory.
 *
 * @returns {{root: string, dist: string}} the temp root and its dist/.
 */
function freshDist() {
  const root = mkdtempSync(join(tmpdir(), 'rebrand-plugin-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  cpSync(source, dist, { recursive: true });
  return { root, dist };
}

console.log('rebrand host plugin');

// (a) it patches a pristine install.
const first = freshDist();
{
  const ctx = stubContext();
  await apply(ctx, { dist: first.dist, detectServed: false });
  const html = readFileSync(join(first.dist, 'index.html'), 'utf8');
  ok('apply() rebrands a pristine install', html.includes('<title>Harness</title>'), /<title>.*<\/title>/.exec(html)?.[0] ?? '');
  ok('apply() reports the work through the logger', ctx.lines.some((line) => line.includes('rebrand:')), ctx.lines.join(' | '));
}

// (b) a second boot writes nothing.
{
  const before = readFileSync(join(first.dist, 'manifest.webmanifest'), 'utf8');
  const ctx = stubContext();
  await apply(ctx, { dist: first.dist, detectServed: false });
  const after = readFileSync(join(first.dist, 'manifest.webmanifest'), 'utf8');
  ok('apply() is idempotent', before === after);
  ok('apply() stays quiet on an already-patched install', ctx.lines.length === 0, ctx.lines.join(' | '));
}

// (c) enabled: false is a no-op.
{
  const second = freshDist();
  const ctx = stubContext();
  await apply(ctx, { dist: second.dist, detectServed: false, enabled: false });
  const html = readFileSync(join(second.dist, 'index.html'), 'utf8');
  ok('enabled: false leaves the frontend alone', html.includes('<title>DeepSeek Harness</title>'));
  ok('enabled: false says why', ctx.lines.some((line) => line.includes('disabled by config')));
  rmSync(second.root, { recursive: true, force: true });
}

// (d) an unrecognizable frontend is reported, never thrown.
{
  const third = freshDist();
  // Damage the bundle the shell actually names, not a decoy beside it. The
  // resolver reads the content hash out of `index.html` (`bundleIn`), so an
  // extra `assets/index-<other-hash>.js` is never opened: the frontend only
  // becomes unrecognizable when *the referenced* bundle is one this patcher
  // cannot match. Asking the resolver which file that is keeps this fixture
  // correct when a DSH upgrade changes the hash — a hardcoded decoy name
  // silently stopped testing the failure path the moment the real bundle
  // sorted ahead of it.
  const target = bundleIn(third.dist);
  if (target === null) {
    ok('the fixture can identify the referenced bundle', false, 'bundleIn() returned null');
  } else {
    writeFileSync(target, 'export const nothing = 1;\n');
  }
  const ctx = stubContext();
  let threw = null;
  try {
    await apply(ctx, { dist: third.dist, detectServed: false });
  } catch (error) {
    threw = error;
  }
  ok('apply() does not throw on an unrecognizable bundle', threw === null, threw === null ? '' : String(threw));
  ok('apply() warns instead', ctx.lines.some((line) => line.includes('check(s) failed')), ctx.lines.join(' | '));
  rmSync(third.root, { recursive: true, force: true });
}

rmSync(first.root, { recursive: true, force: true });

console.log('');
if (failures > 0) {
  console.log(`${String(failures)} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
