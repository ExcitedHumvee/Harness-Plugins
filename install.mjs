/**
 * Wire the DSH plugins in this checkout into a profile.
 *
 * There are two ways to mount a plugin, and this script does the one you ask for:
 *
 *   node install.mjs              install as bundles (the normal path)
 *   node install.mjs --wire       mount straight from this checkout by file: URL
 *   node install.mjs --check      report the current state, write nothing
 *   node install.mjs --uninstall  remove whatever this repository installed
 *
 * ## Bundles (default)
 *
 * Each plugin here is an npm package whose manifest declares `dsh.bundle`, so the
 * supported install is the one DSH itself provides:
 *
 *   dsh plugin --profile web add <this-checkout>/sound-alerts
 *
 * That is a thin forwarder to pnpm in the profile directory. It links the checkout
 * (or, for a git spec, fetches and copies it), records the dependency, and appends
 * the package to `dsh.profile.bundles` because the package declares `dsh.bundle`.
 * DSH then applies the package's own `cordis.patch.yml` as a layer at boot, which
 * is what mounts the plugin. Nothing here writes plugin rows by hand.
 *
 * This mode delegates to that command. It needs pnpm on PATH; when pnpm is
 * missing it prints the exact commands to run instead, rather than inventing a
 * private install layout that pnpm would later reconcile away.
 *
 * ## `--wire` (development)
 *
 * The alternative mounts a plugin's host entry directly out of this checkout:
 *
 *   - id: sound-alerts
 *     name: file:///…/sound-alerts/lib/index.js
 *
 * That is how these plugins started out, and it is genuinely useful while editing
 * them: a `file:` row in the *profile's* patch file is covered by
 * `patchReload: live`, so a host-half edit reloads without reinstalling. It is not
 * the distribution form — it depends on this checkout's absolute path — so treat
 * it as the development switch and use bundles for anything real.
 *
 * ## Why the two modes have to clean up after each other
 *
 * A bundle's patch mounts a row with the plugin's own id, and `--wire` writes a
 * row with the same id. Cordis refuses a duplicate id outright (`duplicate loader
 * entry id`), and a *renamed* second row is refused too, by client-modules:
 * `package <name> resolves from multiple active Loader sources`. Either way the
 * profile will not boot. So both directions strip the other one's rows and
 * dependencies before writing, which makes switching modes safe in either order.
 *
 * Usage:
 *   node install.mjs                              install every plugin here as a bundle
 *   node install.mjs --check                      report wiring, write nothing
 *   node install.mjs --wire                       mount from this checkout by file: URL
 *   node install.mjs --uninstall                  remove this repository's wiring
 *   node install.mjs --profile=web                profile to change (default: web)
 *   node install.mjs --dsh-home=DIR               DSH home (default: $DSH_HOME or ~/.dsh)
 *   node install.mjs --patch-file=FILE            patch layer to edit (--wire/--uninstall)
 *   node install.mjs --force                      repoint rows that name a different path
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
const WIRE = flag('wire');
const UNINSTALL = flag('uninstall');
const FORCE = flag('force');
const PROFILE = arg('profile') ?? 'web';
const DSH_HOME = arg('dsh-home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PATCH_FILE = resolve(arg('patch-file') ?? join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml'));
const PROFILE_DIR = dirname(PATCH_FILE);

/** A row `--wire` owns; the marker makes removal and re-runs unambiguous. */
const marker = (id) => `# ${id} - mounted from this checkout by install.mjs --wire; delete this row to disable.`;
/** The comment the older installer wrote, still recognised so upgrades can clean it up. */
const legacyMarker = (id) => `# ${id} - installed by this repository's install.mjs; delete this row to disable.`;

/** The row id each plugin mounts under — the same id its bundle patch uses. */
const ROW_ID = {
  'sound-alerts': 'sound-alerts',
  rebrand: 'rebrand',
};

/**
 * Discover the installable plugins in this checkout: every top-level directory
 * whose package declares a DSH capability.
 *
 * @returns {{id: string, dir: string, entry: string, url: string, name: string, isBundle: boolean}[]} discovered plugins.
 */
function discoverPlugins() {
  /** @type {{id: string, dir: string, entry: string, url: string, name: string, isBundle: boolean}[]} */
  const plugins = [];
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'scripts') continue;
    const dir = join(here, entry.name);
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;

    /** @type {{name?: string, main?: string, exports?: Record<string, string>, dsh?: {client?: {platform?: string}, bundle?: {patch?: string}}}} */
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      console.error(`skipping ${entry.name}: package.json is not valid JSON`);
      continue;
    }

    const isBundle = pkg.dsh?.bundle?.patch !== undefined;
    const isClient = pkg.dsh?.client?.platform === 'web';
    if (!isBundle && !isClient) continue;

    const relative = pkg.exports?.['.'] ?? pkg.main ?? 'lib/index.js';
    const hostEntry = join(dir, relative);
    if (!existsSync(hostEntry)) {
      console.error(`skipping ${entry.name}: host entry not found at ${hostEntry}`);
      continue;
    }

    plugins.push({
      id: ROW_ID[entry.name] ?? entry.name,
      dir,
      entry: hostEntry,
      url: pathToFileURL(hostEntry).href,
      name: pkg.name ?? entry.name,
      isBundle,
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
 * spans from the `- id:` line through its `name:` line. A blank line left behind
 * by a removed row counts as spacer, not content.
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
    while (end + 1 < lines.length && (lines[end + 1].trim() === '' ? false : /^\s+/.test(lines[end + 1]))) end += 1;
    let start = i;
    for (const candidate of [marker(id), legacyMarker(id)]) {
      if (start - 1 >= 0 && lines[start - 1].trim() === candidate.trim()) {
        start -= 1;
        break;
      }
    }
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
 * result reads like the file it was added to and later insertions stay inside the
 * same list.
 *
 * @param {string[]} lines - patch file lines.
 * @param {{id: string, url: string}[]} plugins - rows to add.
 * @returns {string[]} the new lines.
 */
function insertRows(lines, plugins) {
  const blockIndex = lines.findIndex((line) => /^-\s*insert:\s*$/.test(line));

  let indent = '    ';
  if (blockIndex !== -1) {
    for (let i = blockIndex + 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '') continue;
      if (!/^\s/.test(lines[i])) break;
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
    // A fresh profile's patch file is the header plus a bare `[]`: the empty
    // document these rows exist to fill in. Appending past it would leave two
    // top-level nodes, which the loader's parser rejects outright ("end of the
    // stream or a document separator is expected") and the profile stops booting.
    // So the empty root is replaced, not kept.
    const emptyIndex = lines.findIndex((line) => isEmptyRootArray(line));
    if (emptyIndex !== -1) {
      return [...lines.slice(0, emptyIndex), '- insert:', ...block, ...lines.slice(emptyIndex + 1)];
    }
    const tail = lines.length > 0 && lines[lines.length - 1].trim() !== '' ? [''] : [];
    return [...lines, ...tail, '- insert:', ...block];
  }

  let end = blockIndex + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1;
  return [...lines.slice(0, end), ...block, ...lines.slice(end)];
}

/**
 * Remove a plugin row, including the comment this script (or the older one) wrote
 * directly above it.
 *
 * Only the row's own marker comment goes with it: a blank line, a non-marker
 * comment, or a top-level line ends the sweep. That keeps a hand-written note or
 * the profile header above the row intact.
 *
 * @param {string[]} lines - patch file lines.
 * @param {string} id - the row id.
 * @returns {{lines: string[], removed: boolean}} the new lines and whether a row was removed.
 */
function removeRow(lines, id) {
  const row = findRow(lines, id);
  if (row === null) return { lines, removed: false };

  let start = row.start;
  while (start - 1 >= 0 && (lines[start - 1].trim() === marker(id).trim() || lines[start - 1].trim() === legacyMarker(id).trim())) {
    start -= 1;
  }
  return { lines: [...lines.slice(0, start), ...lines.slice(row.end + 1)], removed: true };
}

/**
 * Is this line a bare, empty top-level YAML array (`[]`)?
 *
 * The inverse of {@link dropEmptyInsertBlocks}: that one restores `[]` when the
 * last row leaves, this one clears it when the first row arrives. A profile that
 * has never mounted a plugin carries exactly this line, and writing an `insert:`
 * list after it would produce a second top-level node.
 *
 * @param {string} line - patch file line.
 * @returns {boolean} true when the line is an empty top-level array.
 */
function isEmptyRootArray(line) {
  return /^\[\s*\]\s*$/.test(line);
}

/**
 * Drop an `insert:` block that no longer has any children, together with a run of
 * comment lines that exists only to introduce it.
 *
 * After the last plugin row is uninstalled the block is an empty `insert:` list
 * with a stranded comment above it. A YAML `- insert: []` is valid but reads as
 * debris, and the profile header sits above a blank line, so a comment run
 * directly above the block is the block's own legend and goes with it.
 *
 * @param {string[]} lines - patch file lines.
 * @returns {string[]} the cleaned lines.
 */
function dropEmptyInsertBlocks(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*-\s*insert:\s*$/.test(lines[index])) continue;
    let end = index + 1;
    while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1;
    // "Empty" means no child rows — comment lines are not children.
    if (lines.slice(index + 1, end).some((line) => line.trim() !== '' && !/^\s*#/.test(line))) continue;

    let start = index;
    while (start - 1 >= 0 && /^\s*#/.test(lines[start - 1])) start -= 1;
    const next = [...lines.slice(0, start), ...lines.slice(end)];
    return dropEmptyInsertBlocks(next);
  }

  // Collapse the blank runs the removals leave behind.
  const collapsed = [];
  for (const line of lines) {
    if (line.trim() === '' && collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === '') continue;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === '') collapsed.pop();
  return collapsed;
}

/**
 * Back the patch file up before the first write of this run.
 *
 * @returns {string|null} the backup path, or null when there was nothing to back up.
 */
function backupPatchFile() {
  if (!existsSync(PATCH_FILE)) return null;
  const backup = `${PATCH_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  writeFileSync(backup, readFileSync(PATCH_FILE));
  return backup;
}

/**
 * Report the bundle side: which packages this checkout declares, and whether the
 * profile already records them as dependencies (and therefore as layers).
 *
 * @param {{name: string}[]} plugins - discovered plugins.
 * @returns {{missing: string[], recorded: string[], bundles: string[]}} the bundle state.
 */
function bundleState(plugins) {
  const manifestPath = join(PROFILE_DIR, 'package.json');
  if (!existsSync(manifestPath)) return { missing: plugins.map((plugin) => plugin.name), recorded: [], bundles: [] };
  /** @type {{dependencies?: Record<string, string>, dsh?: {profile?: {bundles?: string[]}}}} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { missing: plugins.map((plugin) => plugin.name), recorded: [], bundles: [] };
  }
  const dependencies = Object.keys(manifest.dependencies ?? {});
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  return {
    missing: plugins.filter((plugin) => !dependencies.includes(plugin.name)).map((plugin) => plugin.name),
    recorded: plugins.filter((plugin) => dependencies.includes(plugin.name)).map((plugin) => plugin.name),
    bundles,
  };
}

/**
 * Drop this repository's bundle entries from the profile manifest.
 *
 * Used by `--wire` and `--uninstall` so a bundle row and a `file:` row cannot
 * coexist — a duplicate row id stops the profile from booting.
 *
 * @param {{name: string}[]} plugins - discovered plugins.
 * @returns {string[]} the package names that were removed.
 */
function removeBundleEntries(plugins) {
  const manifestPath = join(PROFILE_DIR, 'package.json');
  if (!existsSync(manifestPath)) return [];
  /** @type {{dependencies?: Record<string, string>, dsh?: {profile?: {bundles?: string[]}}}} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
  const names = plugins.map((plugin) => plugin.name);
  const removed = [];
  for (const name of names) {
    if (manifest.dependencies?.[name] !== undefined) {
      delete manifest.dependencies[name];
      removed.push(name);
    }
  }
  const bundles = manifest.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) {
    manifest.dsh.profile.bundles = bundles.filter((name) => !names.includes(name));
  }
  if (removed.length === 0) return [];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  return removed;
}

/**
 * Whether `pnpm` is on PATH.
 *
 * @returns {boolean} true when pnpm can be spawned.
 */
function hasPnpm() {
  const probe = spawnSync('pnpm', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return probe.status === 0;
}

/**
 * Absolute path of the installed DSH CLI entry point, or null when DSH is not
 * resolvable from the profile.
 *
 * The launcher is invoked as `node <this file>` rather than through the `dsh`
 * command shim. That is not a stylistic choice: on Windows the shim runs through
 * `cmd.exe`, and a checkout path containing a space (`…/Harness Plugins/…`) is
 * split into two arguments by the time pnpm sees it. Spawning Node directly has
 * no shell to mangle the path, and it works on every platform.
 *
 * @returns {string|null} the CLI entry point.
 */
function dshEntry() {
  const candidates = [
    join(PROFILE_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

/** The command a user would run to install one plugin as a bundle. */
const addCommand = (plugin) => `dsh plugin --profile ${PROFILE} add "${plugin.dir}"`;

/**
 * Install every plugin as a bundle by delegating to `dsh plugin`.
 *
 * @param {{id: string, dir: string, name: string, isBundle: boolean}[]} plugins - discovered plugins.
 * @returns {number} the process exit code.
 */
function installBundles(plugins) {
  const bundles = plugins.filter((plugin) => plugin.isBundle);
  const notBundles = plugins.filter((plugin) => !plugin.isBundle);
  for (const plugin of notBundles) {
    console.error(`  skip  ${plugin.id}: ${plugin.name} declares no dsh.bundle — it can only be mounted with --wire`);
  }
  if (bundles.length === 0) return 1;

  if (!hasPnpm()) {
    console.log('');
    console.log('pnpm is not on PATH, and `dsh plugin` is a pnpm forwarder.');
    console.log('Either enable pnpm (`corepack enable pnpm`), or install each plugin yourself:');
    console.log('');
    for (const plugin of bundles) console.log(`  ${addCommand(plugin)}`);
    console.log('');
    console.log('Or install from GitHub through a plugin marketplace UI instead (Settings → Plugins).');
    return 1;
  }

  // A `file:` row with the same id as a bundle's row stops the profile from
  // booting, so clear every one of this repository's own rows first — including
  // a client-only plugin's, which no bundle would otherwise displace.
  const { lines } = readPatchFile();
  let next = lines;
  let peeled = false;
  for (const plugin of plugins) {
    const result = removeRow(next, plugin.id);
    next = result.lines;
    if (result.removed) {
      console.log(`  unwire  ${plugin.id}: removed this repository's file:-URL row`);
      peeled = true;
    }
  }
  if (peeled) {
    const backup = backupPatchFile();
    writeFileSync(PATCH_FILE, finalizePatchText(dropEmptyInsertBlocks(next)));
    if (backup !== null) console.log(`  backup  ${backup}`);
  }

  let exitCode = 0;
  const entry = dshEntry();

  // A space in the checkout path cannot survive DSH's own Windows forwarding:
  // `dsh plugin` spawns pnpm through `cmd.exe`, which splits the argument, and
  // pnpm then reports `Failed to resolve the latest version of repos\Harness`.
  // The fix is a space-free link, and it has to be *permanent* — pnpm records the
  // link target as the dependency, so a temporary one would leave the profile
  // pointing at a path that no longer exists.
  let viaJunction = false;
  const linkRoot = join(DSH_HOME, '.dsh-plugin-links');
  if (/ /.test(here)) {
    console.log('');
    console.log("note: this checkout's path contains a space, which DSH cannot forward to pnpm on Windows.");
    if (entry === null) {
      console.log('      Point dsh at a path without spaces, e.g.:');
      console.log(`        dsh plugin --profile ${PROFILE} add "<path without spaces>/${bundles[0].id}"`);
      return 1;
    }
    try {
      mkdirSync(linkRoot, { recursive: true });
      for (const plugin of plugins) {
        const link = join(linkRoot, plugin.id);
        rmSync(link, { recursive: true, force: true });
        symlinkSync(plugin.dir, link, process.platform === 'win32' ? 'junction' : 'dir');
      }
      viaJunction = true;
      console.log(`      installing through a persistent link at ${linkRoot}`);
      console.log('      (kept on purpose: the profile dependency records this path, so deleting it breaks the plugin)');
    } catch (error) {
      console.error(`      could not create the link: ${error instanceof Error ? error.message : String(error)}`);
      console.log('      clone this repository to a path without spaces and run this script from there instead.');
      return 1;
    }
  }

  for (const plugin of bundles) {
    const spec = viaJunction ? join(linkRoot, plugin.id) : plugin.dir;
    console.log('');
    console.log(`==> ${addCommand({ ...plugin, dir: spec })}`);
    const result = entry === null
      ? { error: new Error('the dsh CLI entry point was not found'), status: null }
      : spawnSync(process.execPath, [entry, 'plugin', '--profile', PROFILE, 'add', spec], { stdio: 'inherit' });
    if (result.error !== undefined || result.status !== 0) {
      exitCode = result.status ?? 1;
      console.error(`  FAILED to install ${plugin.name}`);
      if (entry === null) console.error('  the dsh CLI entry point could not be found under the DSH home');
    }
  }

  const state = bundleState(bundles);
  console.log('');
  if (state.missing.length === 0) console.log(`all ${String(bundles.length)} plugin(s) recorded as profile bundles`);
  else console.error(`not recorded: ${state.missing.join(', ')}`);
  console.log('');
  console.log('Bundles compose at boot, so restart the DSH web server (re-run `dsh web`), then reload the GUI page.');
  return exitCode === 0 && state.missing.length === 0 ? 0 : 1;
}

/**
 * Reduce cleaned lines to the text to write.
 *
 * A patch file that holds only comments parses as `null`, and DSH rejects a
 * non-array top level (`must be a top-level YAML array of loader patch
 * entries`), so removing the last row has to leave `[]` rather than a header.
 *
 * @param {string[]} lines - the lines to write.
 * @returns {string} the file text.
 */
function finalizePatchText(lines) {
  const meaningful = lines.filter((line) => line.trim() !== '' && !/^\s*#/.test(line));
  if (meaningful.length === 0) return `[]\n`;
  return `${lines.join('\n')}\n`;
}

function main() {
  const plugins = discoverPlugins();
  if (plugins.length === 0) {
    console.error('No installable plugins found in this checkout.');
    process.exit(1);
  }

  console.log(`repository: ${here}`);
  console.log(`profile:    ${PROFILE_DIR}`);
  console.log('');
  console.log('plugins:');
  for (const plugin of plugins) {
    console.log(`  ${plugin.id}  (${plugin.name})${plugin.isBundle ? '  [bundle]' : '  [client only]'}`);
  }
  console.log('');

  if (CHECK) {
    const state = bundleState(plugins);
    for (const plugin of plugins) {
      const wired = findRow(readPatchFile().lines, plugin.id);
      const installed = state.recorded.includes(plugin.name);
      const layer = state.bundles.includes(plugin.name);
      if (installed && layer) console.log(`  ok       ${plugin.id}: bundle ${plugin.name} is a profile layer`);
      else if (installed) console.log(`  STALE    ${plugin.id}: dependency recorded but not in dsh.profile.bundles`);
      else if (wired !== null) console.log(`  dev      ${plugin.id}: mounted by file: URL (${wired.name})`);
      else console.log(`  MISSING  ${plugin.id}: not installed — run: node install.mjs`);
    }
    console.log('');
    console.log(state.missing.length === 0 ? 'all plugins installed' : `${String(state.missing.length)} plugin(s) not installed — run: node install.mjs`);
    process.exit(state.missing.length === 0 ? 0 : 1);
  }

  if (!WIRE && !UNINSTALL) {
    process.exit(installBundles(plugins));
  }

  const { lines, existed } = readPatchFile();
  let next = lines;
  let changed = false;

  // Both remaining modes reject the bundle form: leaving it in place would put a
  // duplicate row id in front of the loader.
  if (WIRE) {
    const removed = removeBundleEntries(plugins);
    for (const name of removed) {
      console.log(`  unbundle ${name}: removed from profile dependencies and layers`);
      changed = true;
    }
  }

  /** @type {{id: string, url: string}[]} */
  const toAdd = [];

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
      console.log('           left alone; re-run with --force to repoint it at this checkout');
      continue;
    }
    next = removeRow(next, plugin.id).lines;
    toAdd.push(plugin);
    console.log(`  repoint  ${plugin.id}: ${row.name} -> ${plugin.url}`);
  }

  if (UNINSTALL) {
    const removed = removeBundleEntries(plugins);
    for (const name of removed) {
      console.log(`  unbundle ${name}: removed from profile dependencies and layers`);
      changed = true;
    }
  }

  if (toAdd.length > 0) {
    next = insertRows(next, toAdd);
    for (const plugin of toAdd) console.log(`  insert   ${plugin.id}: ${plugin.url}`);
    changed = true;
  }

  if (!changed) {
    console.log('');
    console.log('nothing to change');
    process.exit(0);
  }

  if (!existed && !UNINSTALL) {
    next = [
      '# Your patch layer for this dsh profile, applied after every bundle layer:',
      '# a top-level YAML array of loader patch entries (id-targeted config',
      '# overrides, disables, and insert lists; `!!js` expressions allowed).',
      '#',
      '# The rows below mount plugins straight from a git checkout by file: URL.',
      '# Written by install.mjs --wire; remove a row (and its comment) to disable a plugin.',
      '',
      ...next,
    ];
  }

  const backup = backupPatchFile();
  writeFileSync(PATCH_FILE, finalizePatchText(dropEmptyInsertBlocks(next)));
  if (backup !== null) console.log('');
  if (backup !== null) console.log(`backup: ${backup}`);

  // Re-read and confirm the intended state, so a silent write failure cannot pass.
  const written = readPatchFile().lines;
  const broken = plugins.filter((plugin) => {
    const row = findRow(written, plugin.id);
    return UNINSTALL ? row !== null : row === null || row.name !== plugin.url;
  });
  if (broken.length > 0) {
    console.error(`FAILED to write the expected rows: ${broken.map((plugin) => plugin.id).join(', ')}`);
    if (backup !== null) console.error(`previous file kept at ${backup}`);
    process.exit(1);
  }

  console.log('');
  console.log(`wrote ${PATCH_FILE}`);
  if (!UNINSTALL) {
    console.log('');
    console.log('The profile uses patchReload: live, so a file:-URL row needs no server restart.');
    console.log('Reload the GUI page (Ctrl+Shift+R) to pick up the change.');
    console.log('This is the development mount; use `node install.mjs` for the bundle install.');
  }
}

main();
