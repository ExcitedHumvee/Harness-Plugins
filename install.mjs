/**
 * Wire the DSH client plugins in this repository into a DSH profile.
 *
 * A client plugin does not need to be installed into `node_modules`: the profile
 * patch file (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`) can mount it
 * straight from this checkout by `file:` URL, and the plugin's own
 * `dsh.client` declaration is what makes the browser half load. So "installing"
 * means adding one row per plugin to that patch layer.
 *
 * This script finds every directory here that declares `dsh.client`, computes
 * the URL for its host entry, and adds or repoints the matching rows. It is
 * idempotent, backs the patch file up before its first write, and in `--check`
 * mode reports the wiring without touching anything.
 *
 * Usage:
 *   node install.mjs --check                 # report wiring, write nothing (exit 1 if unwired)
 *   node install.mjs                         # wire every plugin in this checkout
 *   node install.mjs --uninstall             # remove the rows this script adds
 *   node install.mjs --force                 # repoint rows that name a different path
 *   node install.mjs --profile=web           # profile to patch (default: web)
 *   node install.mjs --dsh-home=DIR          # DSH home to patch (default: $DSH_HOME or ~/.dsh)
 *   node install.mjs --patch-file=FILE       # patch layer to edit (overrides the two above)
 *
 * `rebrand/` is not a Cordis plugin — it patches the frontend build in place —
 * so it is intentionally skipped here. Run `node rebrand/apply-rebrand.mjs` for
 * that half; `node verify.mjs` runs both checks.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const arg = (name) => {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
};
const flag = (name) => process.argv.includes(`--${name}`);

const CHECK = flag('check');
const DRY_RUN = flag('dry-run') || CHECK;
const FORCE = flag('force');
const UNINSTALL = flag('uninstall');
const PROFILE = arg('profile') ?? 'web';
const DSH_HOME = arg('dsh-home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PATCH_FILE = resolve(arg('patch-file') ?? join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml'));

/** A row this installer owns; the marker makes removal and re-runs unambiguous. */
const marker = (id) => `# ${id} - installed by this repository's install.mjs; delete this row to disable.`;

/**
 * Discover the mountable plugins in this checkout: every top-level directory
 * whose package declares a DSH web client half.
 *
 * @returns {{id: string, dir: string, entry: string, url: string, name: string}[]} discovered plugins.
 */
function discoverPlugins() {
  /** @type {{id: string, dir: string, entry: string, url: string, name: string}[]} */
  const plugins = [];
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const dir = join(here, entry.name);
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    /** @type {{name?: string, main?: string, exports?: Record<string, string>, dsh?: {client?: {platform?: string}}}} */
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      continue;
    }
    if (pkg.dsh?.client?.platform !== 'web') continue;
    const relative = pkg.exports?.['.'] ?? pkg.main ?? 'lib/index.js';
    const hostEntry = join(dir, relative);
    if (!existsSync(hostEntry)) {
      console.error(`skipping ${entry.name}: host entry not found at ${hostEntry}`);
      continue;
    }
    plugins.push({
      id: entry.name,
      dir,
      entry: hostEntry,
      url: pathToFileURL(hostEntry).href,
      name: pkg.name ?? entry.name,
    });
  }
  return plugins;
}

/**
 * Read the patch file, or return an empty document when it does not exist yet.
 *
 * @returns {{lines: string[], eol: string, existed: boolean}} the file's lines.
 */
function readPatchFile() {
  if (!existsSync(PATCH_FILE)) return { lines: [], eol: '\n', existed: false };
  const text = readFileSync(PATCH_FILE, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { lines: text.split(/\r?\n/), eol, existed: true };
}

/**
 * Locate a plugin row by its `id`.
 *
 * Rows are two lines — `- id: X` followed by an indented `name: …` — so a row
 * spans from the `- id:` line through its `name:` line. Any comment lines this
 * installer wrote immediately above the `- id:` line belong to the row too.
 *
 * @param {string[]} lines - patch file lines.
 * @param {string} id - the row id.
 * @returns {{start: number, end: number, indent: string, name: string}|null} the row's line range.
 */
function findRow(lines, id) {
  const idLine = new RegExp(`^(\\s*)-\\s*id:\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  for (let i = 0; i < lines.length; i += 1) {
    const match = idLine.exec(lines[i]);
    if (match === null) continue;
    let end = i;
    if (i + 1 < lines.length && /^\s+name:/.test(lines[i + 1])) end = i + 1;
    let start = i;
    if (start - 1 >= 0 && lines[start - 1].trim() === marker(id).trim()) start -= 1;
    const nameMatch = /^\s+name:\s*(.+?)\s*$/.exec(lines[i + 1] ?? '');
    return { start, end, indent: match[1], name: nameMatch === null ? '' : nameMatch[1] };
  }
  return null;
}

/**
 * Insert plugin rows into the first top-level `insert:` block, creating one when
 * the patch file has none (or does not exist yet).
 *
 * The rows adopt the indentation already used by that block's children, so the
 * result reads like the file it was added to and later insertions stay inside
 * the same list.
 *
 * @param {string[]} lines - patch file lines.
 * @param {{id: string, url: string}[]} plugins - rows to add.
 * @returns {string[]} the new lines.
 */
function insertRows(lines, plugins) {
  const blockIndex = lines.findIndex((line) => /^-\s*insert:\s*$/.test(line));

  // Child indentation of an existing block: whatever the first child line uses.
  let indent = '    ';
  if (blockIndex !== -1) {
    for (let i = blockIndex + 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '') continue;
      if (!/^\s/.test(lines[i])) break; // a top-level line ends the block
      const match = /^(\s+)/.exec(lines[i]);
      if (match !== null) indent = match[1];
      break;
    }
  }

  /** @type {string[]} */
  const block = [];
  for (const plugin of plugins) {
    block.push(`${indent}${marker(plugin.id)}`);
    block.push(`${indent}- id: ${plugin.id}`);
    block.push(`${indent}  name: ${plugin.url}`);
  }

  if (blockIndex === -1) {
    const tail = lines.length > 0 && lines[lines.length - 1].trim() !== '' ? [''] : [];
    return [...lines, ...tail, '- insert:', ...block];
  }

  // Children of the insert block are the indented lines that follow it.
  let end = blockIndex + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1;
  return [...lines.slice(0, end), ...block, ...lines.slice(end)];
}

/**
 * Remove a plugin row, including the comment line this installer wrote above it.
 *
 * @param {string[]} lines - patch file lines.
 * @param {string} id - the row id.
 * @returns {{lines: string[], removed: boolean}} the new lines and whether a row was removed.
 */
function removeRow(lines, id) {
  const row = findRow(lines, id);
  if (row === null) return { lines, removed: false };
  return { lines: [...lines.slice(0, row.start), ...lines.slice(row.end + 1)], removed: true };
}

function main() {
  const plugins = discoverPlugins();
  if (plugins.length === 0) {
    console.error('No mountable client plugins found in this checkout.');
    process.exit(1);
  }

  console.log(`repository: ${here}`);
  console.log(`patch file: ${PATCH_FILE}${existsSync(PATCH_FILE) ? '' : ' (does not exist yet — it will be created)'}`);
  console.log('');
  console.log('plugins:');
  for (const plugin of plugins) {
    console.log(`  ${plugin.id}  (${plugin.name})`);
    console.log(`    ${plugin.url}`);
  }
  console.log('');

  const { lines, eol, existed } = readPatchFile();

  if (CHECK) {
    let unwired = 0;
    for (const plugin of plugins) {
      const row = findRow(lines, plugin.id);
      if (row === null) {
        unwired += 1;
        console.log(`  MISSING  ${plugin.id}: no row in ${PATCH_FILE}`);
      } else if (row.name !== plugin.url) {
        unwired += 1;
        console.log(`  STALE    ${plugin.id}: row points at ${row.name}`);
        console.log(`           expected ${plugin.url} (re-run without --check, or with --force, to repoint)`);
      } else {
        console.log(`  ok       ${plugin.id}: wired to ${row.name}`);
      }
    }
    console.log('');
    if (unwired === 0) {
      console.log('all plugins wired');
      process.exit(0);
    }
    console.log(`${String(unwired)} plugin(s) not wired — run: node install.mjs`);
    process.exit(1);
  }

  /** @type {{id: string, url: string}[]} */
  const toAdd = [];
  /** @type {Set<string>} ids already reported as repointed, so they are not printed twice. */
  const repointed = new Set();
  let changed = false;
  let next = lines;

  for (const plugin of plugins) {
    if (UNINSTALL) {
      const result = removeRow(next, plugin.id);
      next = result.lines;
      console.log(`  ${result.removed ? 'removed ' : 'absent  '} ${plugin.id}`);
      changed = changed || result.removed;
      continue;
    }

    const row = findRow(next, plugin.id);
    if (row === null) {
      toAdd.push(plugin);
      continue;
    }
    if (row.name === plugin.url) {
      console.log(`  already  ${plugin.id}: wired to ${row.name}`);
      continue;
    }
    if (!FORCE) {
      console.log(`  warn     ${plugin.id}: row points at ${row.name}`);
      console.log(`           left alone; re-run with --force to repoint it at this checkout`);
      continue;
    }
    next = removeRow(next, plugin.id).lines;
    toAdd.push(plugin);
    repointed.add(plugin.id);
    console.log(`  repoint  ${plugin.id}: ${row.name} -> ${plugin.url}`);
  }

  if (toAdd.length > 0) {
    next = insertRows(next, toAdd);
    for (const plugin of toAdd) {
      if (!repointed.has(plugin.id)) console.log(`  insert   ${plugin.id}: ${plugin.url}`);
    }
    changed = true;
  }

  if (!changed) {
    console.log('');
    console.log(DRY_RUN ? 'dry run: nothing to change' : 'nothing to change');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('');
    console.log('dry run: the patch file would become:');
    console.log(next.join(eol));
    process.exit(0);
  }

  if (!existed) {
    const header = [
      '# Your patch layer for this dsh profile, applied after every bundle layer:',
      '# a top-level YAML array of loader patch entries (id-targeted config',
      '# overrides, disables, and insert lists; `!!js` expressions allowed).',
      '#',
      '# The rows below mount plugins straight from a git checkout by file: URL.',
      '# Written by install.mjs; remove a row (and its comment) to disable a plugin.',
      '',
    ];
    next = [...header, ...next];
  }

  const backup = `${PATCH_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (existsSync(PATCH_FILE)) writeFileSync(backup, readFileSync(PATCH_FILE));
  writeFileSync(PATCH_FILE, next.join(eol));

  // Re-read and confirm the rows landed, so a silent write failure cannot pass.
  const written = readPatchFile().lines;
  const broken = plugins.filter((plugin) => {
    const row = findRow(written, plugin.id);
    return UNINSTALL ? row !== null : row === null || row.name !== plugin.url;
  });
  console.log('');
  if (broken.length > 0) {
    console.error(`FAILED to write the expected rows: ${broken.map((plugin) => plugin.id).join(', ')}`);
    if (existsSync(backup)) console.error(`previous file kept at ${backup}`);
    process.exit(1);
  }
  if (existsSync(backup)) console.log(`backup: ${backup}`);
  console.log(`wrote ${PATCH_FILE}`);
  console.log('');
  console.log('The web profile uses patchReload: live, so no server restart is needed.');
  console.log('Reload the GUI page (Ctrl+Shift+R) to pick up the change.');
}

main();
