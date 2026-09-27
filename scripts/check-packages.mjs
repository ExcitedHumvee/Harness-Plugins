/**
 * Validate the install contract of every plugin package in this checkout.
 *
 * A plugin is only installable here if its manifest says so in the way DSH reads
 * it. This script asserts exactly that, statically, so a renamed package, a moved
 * entry point, or a patch file that stopped naming its own package fails in
 * `verify.mjs` instead of in someone's profile:
 *
 *   - `dsh.bundle.patch` points at a file that exists;
 *   - that patch file's `insert:` rows mount this package by its own name, which
 *     is what makes the bundle layer load (a row naming a path or a stale name
 *     would break the install);
 *   - `main` / `exports["."]` resolve to a real host entry;
 *   - a package declaring `dsh.client` exports a real `./client` bundle;
 *   - every path named in `files` exists.
 *
 * It reads no machine state: a fresh clone verifies cleanly before anything is
 * installed.
 *
 * Usage:
 *   node scripts/check-packages.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));

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
 * The id a patch row mounts a package under, read without a YAML dependency.
 *
 * The rows are two lines — `- id: X` then `  name: Y` — so pairing them is enough
 * to check the contract without pulling in a parser the repo does not depend on.
 *
 * @param {string} text - the patch file's text.
 * @returns {{id: string, name: string}[]} the rows, in file order.
 */
function patchRows(text) {
  /** @type {{id: string, name: string}[]} */
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const idMatch = /^\s*-\s*id:\s*(\S+)\s*$/.exec(lines[i]);
    if (idMatch === null) continue;
    const nameMatch = /^\s*name:\s*['"]?([^'"]+?)['"]?\s*$/.exec(lines[i + 1] ?? '');
    rows.push({ id: idMatch[1], name: nameMatch === null ? '' : nameMatch[1].trim() });
  }
  return rows;
}

const packages = [];
for (const entry of readdirSync(here, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'scripts') continue;
  const manifest = join(here, entry.name, 'package.json');
  if (!existsSync(manifest)) continue;
  packages.push({ dir: entry.name, manifest });
}

console.log(`packages: ${packages.map((pkg) => pkg.dir).join(', ')}`);
console.log('');

if (packages.length === 0) {
  console.log('  FAIL no plugin packages found');
  process.exit(1);
}

for (const pkg of packages) {
  console.log(`${pkg.dir}/`);

  /** @type {{name?: string, main?: string, exports?: Record<string, string>, files?: string[], dsh?: {bundle?: {patch?: string|string[]}, client?: {platform?: string}}}} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(pkg.manifest, 'utf8'));
  } catch (error) {
    ok('package.json parses', false, error instanceof Error ? error.message : String(error));
    console.log('');
    continue;
  }

  const name = manifest.name;
  ok('declares a package name', typeof name === 'string' && name !== '');
  if (typeof name !== 'string' || name === '') {
    console.log('');
    continue;
  }

  // The bundle contract: what makes `dsh plugin add` create a profile layer.
  const declaredPatch = manifest.dsh?.bundle?.patch;
  const patchRel = Array.isArray(declaredPatch) ? declaredPatch[0] : declaredPatch;
  ok('declares dsh.bundle.patch', typeof patchRel === 'string' && patchRel !== '');

  if (typeof patchRel === 'string' && patchRel !== '') {
    const patchPath = join(here, pkg.dir, patchRel);
    const patchExists = existsSync(patchPath);
    ok(`patch file exists (${patchRel})`, patchExists);
    if (patchExists) {
      const rows = patchRows(readFileSync(patchPath, 'utf8'));
      ok('patch mounts at least one row', rows.length > 0);
      const self = rows.filter((row) => row.name === name);
      ok(`patch mounts this package by name (${name})`, self.length > 0, rows.map((row) => `${row.id} -> ${row.name}`).join(', '));
      // A row naming a relative path would be anchored beside the patch file and
      // bypass the installed copy, which is not how a distributed bundle works.
      const pathLike = rows.filter((row) => row.name.startsWith('.') || row.name.startsWith('/') || /^[A-Za-z]:/.test(row.name));
      ok('no patch row names a filesystem path', pathLike.length === 0, pathLike.map((row) => row.name).join(', '));
    }
  }

  const mainRel = manifest.exports?.['.'] ?? manifest.main;
  ok('host entry is declared', typeof mainRel === 'string' && mainRel !== '');
  if (typeof mainRel === 'string') ok(`host entry exists (${mainRel})`, existsSync(join(here, pkg.dir, mainRel)));

  if (manifest.dsh?.client !== undefined) {
    const platform = manifest.dsh.client.platform;
    ok('dsh.client targets the web platform', platform === 'web', String(platform));
    const clientRel = manifest.exports?.['./client'];
    ok('exports a ./client bundle', typeof clientRel === 'string' && clientRel !== '');
    if (typeof clientRel === 'string') ok(`client bundle exists (${clientRel})`, existsSync(join(here, pkg.dir, clientRel)));
  }

  for (const file of manifest.files ?? []) {
    if (file.includes('*')) continue;
    ok(`files[] entry exists (${file})`, existsSync(join(here, pkg.dir, file)));
  }

  console.log('');
}

console.log(relative(here, here) === '' ? '' : '');
if (failures > 0) {
  console.log(`${String(failures)} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
