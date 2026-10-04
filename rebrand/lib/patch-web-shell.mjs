/**
 * Rebrand the shell artifacts of the DSH web frontend: the page title, the web
 * app manifest, and the favicon.
 *
 * The JavaScript bundle patch (`patch-web-brand.mjs`) removes the wordmark and
 * logo from inside the app; these three files are what the *browser chrome*
 * shows — tab title, install name, bookmark icon — before (and independently of)
 * any JavaScript running. Patching only the bundle leaves "DeepSeek Harness" in
 * the tab and the DeepSeek whale in the favicon, so both halves are needed for a
 * complete rebrand.
 *
 * Unlike the bundle, these files are not minified, so they are rewritten
 * semantically rather than by byte anchor:
 *
 *   `index.html`           the `<title>` (and any `apple-mobile-web-app-title`)
 *   `manifest.webmanifest` the JSON `name` / `short_name`
 *   `favicon*.svg`         replaced wholesale by the neutral mark below
 *
 * The favicon rule covers *every* favicon the shell ships, not just
 * `favicon.svg`: the DSH 0.2 frontend also ships a `favicon-dark.svg` and links
 * it from `index.html` under `media="(prefers-color-scheme: dark)"`, so patching
 * the light file alone leaves the DeepSeek whale in the tab for every user whose
 * system is in dark mode. The neutral mark inverts itself through
 * `prefers-color-scheme`, so the same bytes are correct in both files.
 *
 * Each rewrite is idempotent, each file is backed up to `rebrand/lib/backups/`
 * before its first change, and `--check` reports the plan without writing.
 *
 * Usage:
 *   node rebrand/lib/patch-web-shell.mjs [--check] [--all] [--dist=DIR]
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ensureBackup, frontendInstalls, installAt } from './resolve-frontend.mjs';

const CHECK_ONLY = process.argv.includes('--check');
const ALL = process.argv.includes('--all');
const DIST_ARG = process.argv.find((arg) => arg.startsWith('--dist='));

/** The name the application shows wherever the shipped default said DeepSeek. */
export const APP_NAME = 'Harness';

/**
 * Neutral rounded-square "H" mark used as the favicon.
 *
 * Ported from the form already running in this install: a rounded square that
 * inverts with `prefers-color-scheme`, carrying a single stroked-less "H" path.
 */
export const NEUTRAL_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50" fill="none">
\t<style>
\t\t:root { color-scheme: light dark; }
\t\t.harness-mark-bg { fill: #0b0b0c; }
\t\t.harness-mark-fg { fill: #ffffff; }
\t\t@media (prefers-color-scheme: dark) {
\t\t\t.harness-mark-bg { fill: #f5f5f7; }
\t\t\t.harness-mark-fg { fill: #0b0b0c; }
\t\t}
\t</style>
\t<rect class="harness-mark-bg" x="1" y="1" width="48" height="48" rx="12" />
\t<path class="harness-mark-fg" d="M14 12.5h5.6v10.2h10.8V12.5H36v25h-5.6V27.9H19.6v9.6H14v-25Z" />
</svg>
`;

/** Marks a favicon this patcher already produced. */
const MARK_MARKER = 'harness-mark-bg';

/**
 * Every favicon file a frontend `dist/` ships, in a stable order.
 *
 * Matched by pattern rather than by a fixed list so a future DSH release that
 * adds another colour-scheme variant (a monochrome or high-contrast icon, say)
 * is rebranded by the same pass instead of shipping the whale beside a patched
 * light icon. A missing `dist/` or no matches yields an empty list, which the
 * caller reports rather than guessing a filename.
 *
 * @param {string} dist - a frontend `dist` directory.
 * @returns {string[]} favicon file names, sorted.
 */
export function faviconNames(dist) {
  if (!existsSync(dist)) return [];
  return readdirSync(dist)
    .filter((name) => /^favicon.*\.svg$/.test(name))
    .sort();
}

/**
 * Rewrite `index.html`: the document title and the iOS home-screen title.
 *
 * @param text - the current `index.html`.
 * @returns {{text: string, changes: string[]}} the rewritten HTML and what changed.
 */
export function patchIndexHtml(text) {
  const changes = [];
  let next = text;

  const title = /<title>[\s\S]*?<\/title>/;
  if (title.test(next)) {
    if (!next.includes(`<title>${APP_NAME}</title>`)) {
      const before = title.exec(next)[0];
      next = next.replace(title, `<title>${APP_NAME}</title>`);
      changes.push(`title: ${before} -> <title>${APP_NAME}</title>`);
    }
  } else if (next.includes('</head>')) {
    next = next.replace('</head>', `  <title>${APP_NAME}</title>\n  </head>`);
    changes.push(`title: added <title>${APP_NAME}</title>`);
  } else {
    changes.push('title: no <title> and no </head> — left untouched');
  }

  const apple = /(<meta[^>]*name="apple-mobile-web-app-title"[^>]*content=")[^"]*(")/;
  const appleMatch = apple.exec(next);
  if (appleMatch !== null && appleMatch[0].includes(`content="${APP_NAME}"`) === false) {
    next = next.replace(apple, `$1${APP_NAME}$2`);
    changes.push(`apple-mobile-web-app-title -> ${APP_NAME}`);
  }

  return { text: next, changes };
}

/**
 * Rewrite `manifest.webmanifest`: the install name and short name.
 *
 * @param text - the current manifest JSON.
 * @returns {{text: string, changes: string[]}} the rewritten manifest and what changed.
 */
export function patchManifest(text) {
  const changes = [];
  /** @type {Record<string, unknown>} */
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`manifest is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  for (const key of ['name', 'short_name']) {
    if (manifest[key] !== APP_NAME) {
      changes.push(`${key}: ${JSON.stringify(manifest[key])} -> ${JSON.stringify(APP_NAME)}`);
      manifest[key] = APP_NAME;
    }
  }
  if (changes.length === 0) return { text, changes };
  return { text: `${JSON.stringify(manifest, null, 2)}\n`, changes };
}

/**
 * Patch one discovered install's shell files.
 *
 * @param {{dist: string}} install - a discovered install.
 * @param {{checkOnly?: boolean}} [options] - report without writing.
 * @returns {{path: string, status: string, detail: string}} a one-line result.
 */
export function patchShell(install, options = {}) {
  const checkOnly = options.checkOnly ?? false;
  const files = [
    { name: 'index.html', rewrite: patchIndexHtml },
    { name: 'manifest.webmanifest', rewrite: patchManifest },
  ];

  /** @type {string[]} */
  const details = [];
  /** @type {{file: string, text: string}[]} */
  const writes = [];

  for (const { name, rewrite } of files) {
    const file = join(install.dist, name);
    if (!existsSync(file)) {
      details.push(`${name}: not found (skipped)`);
      continue;
    }
    const before = readFileSync(file, 'utf8');
    const result = rewrite(before);
    if (result.text === before) {
      details.push(`${name}: ${result.changes.length === 0 ? 'already rebranded' : result.changes.join('; ')}`);
      continue;
    }
    details.push(`${name}: ${result.changes.join('; ')}`);
    writes.push({ file, text: result.text });
  }

  const favicons = faviconNames(install.dist);
  if (favicons.length === 0) {
    details.push('favicon*.svg: not found (skipped)');
  }
  for (const name of favicons) {
    const favicon = join(install.dist, name);
    if (readFileSync(favicon, 'utf8').includes(MARK_MARKER)) {
      details.push(`${name}: already the neutral mark`);
    } else {
      details.push(`${name}: whale -> neutral rounded-square H mark`);
      writes.push({ file: favicon, text: NEUTRAL_MARK_SVG });
    }
  }

  const changed = writes.length > 0;
  if (changed && checkOnly === false) {
    for (const write of writes) {
      ensureBackup(write.file);
      writeFileSync(write.file, write.text);
    }
  }

  return {
    path: install.dist,
    status: changed ? (checkOnly ? 'would-patch' : 'patched') : 'already-patched',
    detail: details.join('; '),
  };
}

function main() {
  const distArg = DIST_ARG === undefined ? null : DIST_ARG.slice('--dist='.length);
  const installs = frontendInstalls();
  if (installs.length === 0 && distArg === null) {
    console.error('No @deepseek-ai/dsh-web-frontend install found.');
    console.error('Set DSH_HOME, or point at one directly with --dist=DIR.');
    process.exit(1);
  }

  const targets = distArg === null
    ? (ALL ? installs : installs.slice(0, 1))
    : [installAt(distArg)];

  if (targets.length === 0) {
    console.error(`--dist=… did not match a discovered install. Discovered: ${installs.map((i) => i.dist).join(', ')}`);
    process.exit(1);
  }

  let failed = false;
  for (const install of targets) {
    try {
      const result = patchShell(install, { checkOnly: CHECK_ONLY });
      console.log(`${result.status.padEnd(16)} ${result.path}`);
      console.log(`${' '.repeat(16)} ${result.detail}`);
    } catch (error) {
      failed = true;
      console.error(`failed           ${install.dist}`);
      console.error(`${' '.repeat(16)} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const untouched = installs.filter((install) => !targets.includes(install));
  if (!CHECK_ONLY && untouched.length > 0) {
    console.log('');
    console.log(`note: ${String(untouched.length)} other install(s) left untouched:`);
    for (const install of untouched) console.log(`  ${install.dist}`);
    console.log('      re-run with --all to patch every copy, or --dist=DIR to pick one.');
  }
  process.exit(failed ? 1 : 0);
}

// Run only when invoked as a script; apply-rebrand.mjs imports this module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
