/**
 * Locate the installed DSH web frontend on this machine.
 *
 * The rebrand works on the *published* frontend, which ships as built artifacts
 * inside `@deepseek-ai/dsh-web-frontend`. There is no source tree, and the
 * package can live in more than one place at once:
 *
 *   1. `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-web-frontend` — the
 *      copy the profile resolves, and normally the one the running server
 *      serves.
 *   2. `…/npm-cache/_npx/<hash>/node_modules/@deepseek-ai/dsh-web-frontend` —
 *      copies left behind by every `npx @deepseek-ai/dsh` run, one per install
 *      hash.
 *
 * A rebrand applied to only one of those copies looks broken when the other one
 * is the one being served, so this module reports every copy it finds and can
 * identify which copy the running server is actually serving by comparing the
 * served asset against each local file.
 *
 * @module dsh-rebrand/resolve-frontend
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package directory name, relative to a `node_modules` root. */
const PACKAGE = join('@deepseek-ai', 'dsh-web-frontend');

/** Directory holding this module — used for the backup directory. */
const here = dirname(fileURLToPath(import.meta.url));

/** Where pre-patch copies of every patched file are kept. */
export const BACKUPS = join(here, 'backups');

/** The DSH home directory the install uses. */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/**
 * Every `@deepseek-ai/dsh-web-frontend` root that exists on this machine, most
 * likely first: the profile's copy, then npx caches newest-first.
 *
 * @returns {string[]} absolute package roots.
 */
function frontendRoots() {
  const roots = [];
  const profileRoot = join(dshHome(), 'profiles', 'node_modules', PACKAGE);
  if (existsSync(profileRoot)) roots.push(profileRoot);

  const npxRoots = [
    process.env.LOCALAPPDATA === undefined ? null : join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'),
    process.env.APPDATA === undefined ? null : join(process.env.APPDATA, 'npm', '_npx'),
    join(homedir(), '.npm', '_npx'),
  ].filter((root) => root !== null);

  /** @type {{root: string, mtime: number}[]} */
  const cached = [];
  for (const npx of new Set(npxRoots)) {
    if (!existsSync(npx)) continue;
    let entries;
    try {
      entries = readdirSync(npx);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const root = join(npx, entry, 'node_modules', PACKAGE);
      if (!existsSync(root)) continue;
      try {
        cached.push({ root, mtime: statSync(root).mtimeMs });
      } catch {
        /* unreadable entry: skip it rather than failing the whole scan */
      }
    }
  }
  cached.sort((a, b) => b.mtime - a.mtime);
  roots.push(...cached.map((entry) => entry.root));

  // De-duplicate while preserving order (a symlinked profile node_modules can
  // resolve to the same directory as an npx cache entry).
  const seen = new Set();
  return roots.filter((root) => {
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  });
}

/**
 * The JavaScript entry bundle inside a `dist/` directory.
 *
 * The content hash is read out of `index.html` rather than guessed, and a
 * `DSH_WEB_FRONTEND_BUNDLE` override wins over everything. Falls back to the
 * single `assets/index-*.js` when `index.html` is missing or unreadable.
 *
 * @param {string} dist - a frontend `dist` directory.
 * @returns {string|null} absolute path to the bundle, or null when it cannot be determined.
 */
export function bundleIn(dist) {
  const override = process.env.DSH_WEB_FRONTEND_BUNDLE;
  if (override !== undefined && override !== '') return resolve(override);

  const html = join(dist, 'index.html');
  if (existsSync(html)) {
    const text = readFileSync(html, 'utf8');
    const match = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(text);
    if (match !== null) {
      const candidate = join(dist, 'assets', match[1]);
      if (existsSync(candidate)) return candidate;
    }
  }

  const assets = join(dist, 'assets');
  if (!existsSync(assets)) return null;
  const bundles = readdirSync(assets).filter((name) => /^index-.*\.js$/.test(name));
  if (bundles.length === 1) return join(assets, bundles[0]);
  return null;
}

/**
 * Every patchable frontend install, in resolution order.
 *
 * @returns {{dist: string, bundle: string|null, root: string}[]} discovered installs.
 */
export function frontendInstalls() {
  /** @type {{dist: string, bundle: string|null, root: string}[]} */
  const installs = [];

  const fromEnv = process.env.DSH_WEB_FRONTEND_DIST;
  if (fromEnv !== undefined && fromEnv !== '') {
    installs.push({ root: resolve(fromEnv), dist: resolve(fromEnv), bundle: bundleIn(resolve(fromEnv)) });
  } else if (process.env.DSH_WEB_FRONTEND_BUNDLE !== undefined && process.env.DSH_WEB_FRONTEND_BUNDLE !== '') {
    const bundle = resolve(process.env.DSH_WEB_FRONTEND_BUNDLE);
    installs.push({ root: dirname(dirname(bundle)), dist: dirname(dirname(bundle)), bundle });
  }

  for (const root of frontendRoots()) {
    const dist = join(root, 'dist');
    if (!existsSync(join(dist, 'index.html')) && !existsSync(join(dist, 'assets'))) continue;
    installs.push({ root, dist, bundle: bundleIn(dist) });
  }

  const seen = new Set();
  return installs.filter((install) => {
    if (seen.has(install.dist)) return false;
    seen.add(install.dist);
    return true;
  });
}

/**
 * Build an install descriptor for an explicit `dist` directory, so `--dist=DIR`
 * works even for a copy the automatic scan would not have found (a staging
 * directory, another user's install, a different drive).
 *
 * @param {string} dir - a frontend `dist` directory.
 * @returns {{dist: string, bundle: string|null, root: string}} an install descriptor.
 */
export function installAt(dir) {
  const dist = resolve(dir);
  return { root: dirname(dist), dist, bundle: bundleIn(dist) };
}

/**
 * Ask the running GUI which bundle it actually serves, and match that against
 * the local installs.
 *
 * The shell HTML itself is behind browser authentication, but the hashed assets
 * are public, so the probe is: request `/assets/<basename>` for each candidate's
 * own bundle and compare the bytes. Every candidate whose bytes match is provably
 * a copy the server would serve from disk, which is what makes this useful when
 * several installs exist. Copies that happen to be byte-identical all match, and
 * all of them are reported — patching only one of two identical copies would
 * leave the served bytes unchanged if the server reads the other.
 *
 * A server that is not running (or a version mismatch) simply yields `null`: this
 * is a hint, never a requirement.
 *
 * @param {{dist: string, bundle: string|null}[]} installs - discovered installs.
 * @param {number} [timeoutMs] - per-request timeout.
 * @returns {Promise<{dists: string[], servedUrl: string}|null>} the installs serving that asset.
 */
export async function detectServedInstalls(installs, timeoutMs = 2000) {
  const base = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080').replace(/\/$/, '');
  const candidates = installs.filter(
    (install) => install.bundle !== null && existsSync(install.bundle),
  );
  if (candidates.length === 0) return null;

  /** @type {{dist: string, servedUrl: string}[]} */
  const matches = [];
  await Promise.all(
    candidates.map(async (install) => {
      const url = `${base}/assets/${basename(install.bundle)}`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) return;
        const served = Buffer.from(await response.arrayBuffer());
        if (readFileSync(install.bundle).equals(served)) matches.push({ dist: install.dist, servedUrl: url });
      } catch {
        /* not running, or this candidate is not the served one */
      }
    }),
  );
  if (matches.length === 0) return null;
  return { dists: matches.map((entry) => entry.dist), servedUrl: matches[0].servedUrl };
}

/**
 * Copy a file into `rebrand/lib/backups/` once, before the first time it is
 * modified. The backup name embeds the original basename so several installs
 * (and several content hashes) can be kept side by side.
 *
 * @param {string} file - the file about to be patched.
 * @returns {string} path of the pre-patch copy.
 */
export function ensureBackup(file) {
  mkdirSync(BACKUPS, { recursive: true });
  const target = join(BACKUPS, `${basename(file)}.orig-backup`);
  if (!existsSync(target)) copyFileSync(file, target);
  return target;
}

/**
 * SHA-256 of a file's bytes, for reporting which copy is which.
 *
 * @param {string} file - file to hash.
 * @returns {string} lowercase hex digest.
 */
export function fileHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
