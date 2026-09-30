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
 *   - every module the client bundle `require`s is resolvable at materialization
 *     — from DSH's frozen platform seed table, or from this package's own
 *     `dsh.client.external`;
 *   - every path named in `files` exists.
 *
 * The client-module check is the one that tracks a moving DSH contract. A browser
 * bundle is lazy CJS: it registers a factory and resolves `require` against the
 * platform seed table composed by the web shell's `rM()`. A specifier that is
 * neither seeded nor declared in `dsh.client.external` throws at materialization
 * — a runtime failure in the user's page, which nothing else here would catch.
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

/**
 * The module-table seed the DSH web shell hands every client bundle.
 *
 * This is the `staticModules` table the shell composes at boot (the frontend
 * bundle's own seed function, `rM()`), and it is the table every dynamic bundle
 * resolves its externals against. It is deliberately a plain list rather than a
 * read of the installed frontend: this script must run on a fresh clone, where
 * there is no installed frontend to read.
 *
 * Verified against `@deepseek-ai/dsh-web-frontend@0.2.0-rc.2`. If a future DSH
 * adds a seed, a bundle may still resolve it at runtime; if a future DSH *removes*
 * one, the failure surfaces here rather than in someone's page.
 */
const PLATFORM_SEED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]);

/** Builtin specifiers a bundle may always name. */
const NODE_BUILTIN_PREFIXES = ['node:', 'cordis:'];

/**
 * Every bare module specifier a client bundle `require`s.
 *
 * Only the synchronous, literal `require("…")` form is read, which is what the
 * bundle format uses for platform modules; relative paths and dynamic
 * `require.async(...)` chunk requests are not module-table lookups.
 *
 * @param text - the client bundle's text.
 * @returns {string[]} the bare specifiers, deduplicated.
 */
function requiredSpecifiers(text) {
  const found = new Set();
  for (const match of text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = match[1];
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    found.add(spec);
  }
  return [...found].sort();
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

    // Shape of the declaration DSH 0.2 validates, so a typo fails here rather
    // than at composition time in the profile.
    const declaredInject = manifest.dsh.client.inject;
    if (declaredInject !== undefined) {
      ok(
        'dsh.client.inject is a string array',
        Array.isArray(declaredInject) && declaredInject.every((entry) => typeof entry === 'string'),
      );
    }
    const declaredExternal = manifest.dsh.client.external;
    if (declaredExternal !== undefined) {
      ok(
        'dsh.client.external is a string array',
        Array.isArray(declaredExternal) && declaredExternal.every((entry) => typeof entry === 'string'),
      );
    }
    if (manifest.dsh.client.immediately !== undefined) {
      ok('dsh.client.immediately is a boolean', typeof manifest.dsh.client.immediately === 'boolean');
    }

    const clientRel = manifest.exports?.['./client'];
    ok('exports a ./client bundle', typeof clientRel === 'string' && clientRel !== '');
    if (typeof clientRel === 'string') {
      const clientPath = join(here, pkg.dir, clientRel);
      const clientExists = existsSync(clientPath);
      ok(`client bundle exists (${clientRel})`, clientExists);

      if (clientExists) {
        const text = readFileSync(clientPath, 'utf8');
        // The DSH 0.2 browser contract: a bundle registers a lazy factory rather
        // than exporting ESM, so its module bodies must not use `import`/`export`.
        ok(
          'client bundle registers through window.__ModuleLoader__',
          text.includes('__ModuleLoader__') && text.includes('factory'),
        );
        ok(
          'client bundle uses no ESM import/export',
          !/^\s*(?:import|export)\s/m.test(text),
        );

        const declared = new Set(Array.isArray(declaredExternal) ? declaredExternal : []);
        // `<pkg>/client` aliases the bare package row, so compare both forms.
        const declaredBare = new Set([...declared].map((name) => name.replace(/\/client$/, '')));
        const specifiers = requiredSpecifiers(text);
        const unresolved = specifiers.filter(
          (spec) =>
            !PLATFORM_SEED.has(spec) &&
            !declared.has(spec) &&
            !declaredBare.has(spec) &&
            !NODE_BUILTIN_PREFIXES.some((prefix) => spec.startsWith(prefix)),
        );
        ok(
          `every require resolves from the platform seed or dsh.client.external (${String(specifiers.length)} checked)`,
          unresolved.length === 0,
          unresolved.length === 0
            ? ''
            : `unresolved: ${unresolved.join(', ')} — add to dsh.client.external or the PLATFORM_SEED list`,
        );
      }
    }
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
