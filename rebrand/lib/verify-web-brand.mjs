/**
 * Verify a rebranded web frontend without booting a browser.
 *
 * `node --check` proves the patched bundle parses; it does not prove the patched
 * logo components still RUN or that they render what we intend. This harness
 * closes that gap: it slices the patched `BrandWordmark` and `FishLogo`
 * declarations plus their shared path constants out of the bundle, evaluates
 * them against a minimal React stub, and asserts on the resulting element trees.
 * It reads the same anchors the patcher writes, so a patcher regression that
 * still parses (wrong replacement, unbalanced JSX) fails here.
 *
 * Like the patcher, every minified name it needs is resolved from the bundle
 * (`bundle-symbols.mjs`) rather than hardcoded, so this harness does not itself
 * have to be re-derived when the frontend build changes.
 *
 * It also checks the shell artifacts (`index.html`, `manifest.webmanifest`,
 * every `favicon*.svg`) for residual brand, and scans the whole bundle for brand
 * geometry and for a user-visible `"DeepSeek` literal.
 *
 * The favicons are verified as a *set* because the shell links more than one:
 * `index.html` selects `favicon.svg` in light mode and `favicon-dark.svg` in
 * dark mode. Checking only the light file is how the whale survived in the tab
 * for dark-mode users after the rest of the rebrand had been applied.
 *
 * Usage:
 *   node rebrand/lib/verify-web-brand.mjs [--all] [--dist=DIR]
 *
 * Import the exported functions to verify text the patcher produced in memory
 * (which is what `apply-rebrand.mjs --check` does).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  NEUTRAL_GLYPH,
  WHALE_PREFIX,
  WORDMARK_LETTERING_PREFIX,
  DS_BADGE_PREFIX,
  count,
  findClosing,
  isAlreadyPatched,
  resolveBundleSymbols,
  resolvePatchedSymbols,
} from './patch-web-brand.mjs';
import { APP_NAME, NEUTRAL_MARK_SVG, faviconNames } from './patch-web-shell.mjs';
import { frontendInstalls, installAt } from './resolve-frontend.mjs';

/**
 * Slice a declaration out of the bundle text by locating its source range.
 *
 * @param source - bundle text.
 * @param signature - exact declaration prefix.
 * @returns the declaration source.
 */
function span(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`verifier: anchor missing: ${signature}`);
  if (signature.startsWith('function ')) {
    const paramsOpen = source.indexOf('(', start);
    const paramsClose = findClosing(source, paramsOpen, '(', ')');
    const bodyOpen = source.indexOf('{', paramsClose + 1);
    const bodyClose = findClosing(source, bodyOpen, '{', '}');
    return source.slice(start, bodyClose + 1);
  }
  // A string-constant declaration: run to the closing quote of its literal.
  const quote = source.indexOf('"', start);
  const end = source.indexOf('"', quote + 1);
  if (quote === -1 || end === -1) throw new Error(`verifier: unterminated literal: ${signature}`);
  return source.slice(start, end + 1);
}

/** Minimal React element factory mirroring the JSX-runtime contract. */
const jsx = (type, props, key) => ({
  $$typeof: 'react.element',
  type,
  key: key ?? null,
  props,
});
const jsxs = jsx;

/**
 * Build the stubbed evaluation scope source holding the patched declarations.
 *
 * The bundle's JSX runtime identifier and the two constant locals are resolved
 * from the patched text, so the generated stub matches whatever names this build
 * happens to use.
 *
 * @param source - patched bundle text.
 * @returns {{code: string}} the generated body.
 */
function scopePlan(source) {
  const symbols = resolvePatchedSymbols(source);
  const fishLocal = exportLocal(source, 'FishLogo');
  const wordmarkLocal = exportLocal(source, 'BrandWordmark');
  const code = [
    // Bind the JSX runtime under the minified name the bundle body uses.
    `const ${symbols.jsx} = jsxRuntime;`,
    // `FISH_LOGO_VIEWBOX` and `FISH_LOGO_PATH` are one declaration list.
    span(source, `const ${symbols.viewboxLocal}={`),
    span(source, `function ${fishLocal}({`),
    span(source, `function ${wordmarkLocal}({`),
    `const { ${symbols.viewboxLocal}: viewbox, ${symbols.pathLocal}: path, ${fishLocal}: fish, ${wordmarkLocal}: wordmark } = { ${symbols.viewboxLocal}, ${symbols.pathLocal}, ${fishLocal}, ${wordmarkLocal} };`,
    'return { viewbox, path, fish, wordmark };',
  ].join('\n');
  return { code };
}

/**
 * The local identifier an exported constant resolves to.
 *
 * @param source - bundle text.
 * @param name - the exported name.
 * @returns the local identifier.
 */
function exportLocal(source, name) {
  const anchor = source.indexOf(name);
  if (anchor === -1) throw new Error(`verifier: export missing: ${name}`);
  const match = new RegExp(`${name}\\s*:\\s*([A-Za-z_$][\\w$]*)`).exec(source.slice(anchor));
  if (match === null) throw new Error(`verifier: export is not bound: ${name}`);
  return match[1];
}

/**
 * Build the stubbed evaluation scope holding the patched declarations.
 * @param source - patched bundle text.
 * @returns {Record<string, unknown>} the scope bindings.
 */
function scopeOf(source) {
  const { code } = scopePlan(source);
  // eslint-disable-next-line no-new-func
  return new Function('jsxRuntime', code)({ jsx, jsxs });
}

/** Collect every literal SVG path `d` value under a node. */
function pathData(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) pathData(child, out);
    return out;
  }
  if (node.props?.d !== undefined) out.push(node.props.d);
  pathData(node.props?.children, out);
  return out;
}

/** Collect every string leaf under a node. */
function strings(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) strings(child, out);
    return out;
  }
  strings(node.props?.children, out);
  return out;
}

/**
 * Verify the JavaScript bundle: residual brand scan plus live evaluation of the
 * two patched logo components.
 *
 * @param source - bundle text.
 * @returns {{label: string, ok: boolean, detail: string}[]} one entry per check.
 */
export function verifyBundle(source) {
  /** @type {{label: string, ok: boolean, detail: string}[]} */
  const checks = [];
  const check = (label, ok, detail = '') => checks.push({ label, ok: Boolean(ok), detail });

  check('whale path is gone', count(source, WHALE_PREFIX) === 0);
  check('DeepSeek lettering is gone', count(source, WORDMARK_LETTERING_PREFIX) === 0);
  check('DS badge glyph is gone', count(source, DS_BADGE_PREFIX) === 0);
  // The `<defs>` clip paths are identified by this build's JSX runtime name when
  // the bundle still has the original components; once patched, that component
  // is gone and there is nothing left to find either way.
  let defsPrefix = null;
  if (!isAlreadyPatched(source)) {
    try {
      defsPrefix = resolveBundleSymbols(source).wordmarkDefsPrefix;
    } catch {
      defsPrefix = null;
    }
  }
  check(
    'wordmark clip paths are gone',
    defsPrefix === null ? true : count(source, defsPrefix) === 0,
  );
  check(
    'no user-visible "DeepSeek" literal remains',
    !/"DeepSeek/.test(source) && !/DeepSeek Harness/.test(source),
  );
  check(
    'package specifiers still intact',
    count(source, '@deepseek-ai/dsh-client-ui-slots') === 1,
    `found ${String(count(source, '@deepseek-ai/dsh-client-ui-slots'))}`,
  );

  let scope;
  try {
    scope = scopeOf(source);
    check('patched declarations evaluate', true);
  } catch (error) {
    check('patched declarations evaluate', false, String(error));
    if (process.env.DSH_VERIFY_DEBUG === '1') {
      console.log('--- generated scope code ---');
      console.log(scopePlan(source).code);
      console.log('--- end ---');
    }
    return checks;
  }

  check(
    'FISH_LOGO_VIEWBOX is the neutral box',
    scope.viewbox.width === NEUTRAL_GLYPH.viewbox.width &&
      scope.viewbox.height === NEUTRAL_GLYPH.viewbox.height,
    JSON.stringify(scope.viewbox),
  );
  check('FISH_LOGO_PATH is the neutral glyph', scope.path === NEUTRAL_GLYPH.path);

  // ── FishLogo ────────────────────────────────────────────────────────────────
  const fish = scope.fish({ size: 24, className: 'brand-mark' });
  const fishPaths = pathData(fish);
  check('FishLogo renders exactly one path', fishPaths.length === 1, String(fishPaths.length));
  check('FishLogo path is not the whale', !fishPaths.some((d) => d.includes('22.9168')));
  check('FishLogo viewBox matches its geometry', fish.props.viewBox === '0 0 16 16', fish.props.viewBox);
  check('FishLogo keeps caller size/class', fish.props.width === 24 && fish.props.className === 'brand-mark');
  check('FishLogo is decorative', fish.props['aria-hidden'] === true);

  // ── BrandWordmark ───────────────────────────────────────────────────────────
  const mark = scope.wordmark({});
  const markStrings = strings(mark);
  check('BrandWordmark renders a single element', mark.type === 'span', String(mark.type));
  check(
    'BrandWordmark spells HARNESS',
    markStrings.length === 1 && markStrings[0] === 'HARNESS',
    JSON.stringify(markStrings),
  );
  check('BrandWordmark exposes no SVG paths', pathData(mark).length === 0);
  check('BrandWordmark scales with size', scope.wordmark({ size: 48 }).props.style.fontSize === 48 * 0.68);
  check(
    'BrandWordmark forwards className',
    scope.wordmark({ className: 'wm' }).props.style !== undefined && mark.props.className === undefined,
  );

  return checks;
}

/**
 * Verify the shell artifacts: tab title, manifest names, favicon mark.
 *
 * @param {{html?: string|null, manifest?: string|null, favicons?: {name: string, text: string|null}[]}} texts - file contents; omit or null to skip.
 * @returns {{label: string, ok: boolean, detail: string}[]} one entry per check.
 */
export function verifyShell(texts) {
  /** @type {{label: string, ok: boolean, detail: string}[]} */
  const checks = [];
  const check = (label, ok, detail = '') => checks.push({ label, ok: Boolean(ok), detail });

  const { html, manifest, favicons } = texts;
  if (typeof html === 'string') {
    check(`index.html title is ${APP_NAME}`, html.includes(`<title>${APP_NAME}</title>`));
    check('index.html has no "DeepSeek"', !/DeepSeek/.test(html));
  }
  if (typeof manifest === 'string') {
    let parsed = null;
    try {
      parsed = JSON.parse(manifest);
    } catch {
      parsed = null;
    }
    check('manifest parses as JSON', parsed !== null);
    if (parsed !== null) {
      check(`manifest name is ${APP_NAME}`, parsed.name === APP_NAME, JSON.stringify(parsed.name));
      check(`manifest short_name is ${APP_NAME}`, parsed.short_name === APP_NAME, JSON.stringify(parsed.short_name));
    }
  }
  for (const { name, text } of favicons ?? []) {
    if (typeof text !== 'string') {
      // Named by the shell but absent from dist/: the icon would 404, so this is
      // a defect rather than something to skip past.
      check(`${name} exists`, false, 'referenced by index.html but not found in the dist directory');
      continue;
    }
    check(`${name} is the neutral mark`, text.includes('harness-mark-bg'));
    check(`${name} has no brand reference`, !/deepseek/i.test(text));
    check(`${name} matches the shipped mark`, text.trim() === NEUTRAL_MARK_SVG.trim());
  }

  return checks;
}

/**
 * Read one install's artifacts and verify them.
 *
 * @param {{dist: string, bundle: string|null}} install - a discovered install.
 * @returns {{label: string, ok: boolean, detail: string}[]} one entry per check.
 */
export function verifyInstall(install) {
  const checks = [];
  if (install.bundle !== null && existsSync(install.bundle)) {
    checks.push(...verifyBundle(readFileSync(install.bundle, 'utf8')));
  }
  const read = (name) => {
    const file = join(install.dist, name);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };
  const html = read('index.html');
  // Every favicon the dist ships *plus* every relative one the shell links by
  // name: a shell pointing at an icon this patcher never wrote must fail here
  // rather than be skipped because the file name did not match the pattern.
  // Absolute URLs are ignored — an externally hosted icon is not ours to verify.
  const linked = [...(html ?? '').matchAll(/href="(?!https?:|\/\/)[^"]*?((?:favicon|icon)[^"/]*\.svg)"/gi)].map((match) => match[1]);
  const names = [...new Set([...faviconNames(install.dist), ...linked])].sort();
  checks.push(
    ...verifyShell({
      html,
      manifest: read('manifest.webmanifest'),
      favicons: names.map((name) => ({ name, text: read(name) })),
    }),
  );
  return checks;
}

/** Print a check list; returns the number of failures. */
function report(title, checks) {
  console.log(title);
  let failures = 0;
  for (const entry of checks) {
    if (entry.ok) {
      console.log(`  ok   ${entry.label}`);
    } else {
      failures += 1;
      console.log(`  FAIL ${entry.label}${entry.detail === '' ? '' : ` — ${entry.detail}`}`);
    }
  }
  return failures;
}

function main() {
  const distArg = process.argv.find((arg) => arg.startsWith('--dist='));
  const installs = frontendInstalls();
  if (installs.length === 0 && distArg === undefined) {
    console.error('No @deepseek-ai/dsh-web-frontend install found.');
    console.error('Set DSH_HOME, or point at one directly with --dist=DIR or DSH_WEB_FRONTEND_BUNDLE=FILE.');
    process.exit(1);
  }
  const targets = distArg === undefined
    ? (process.argv.includes('--all') ? installs : installs.slice(0, 1))
    : [installAt(distArg.slice('--dist='.length))];

  let failures = 0;
  for (const install of targets) {
    console.log(`install: ${install.dist}`);
    failures += report(`bundle: ${install.bundle ?? '(not found)'}`, verifyInstall(install));
    console.log('');
  }

  if (failures === 0) {
    console.log('all checks passed');
    process.exit(0);
  }
  console.log(`${String(failures)} check(s) failed`);
  process.exit(1);
}

// Run only when invoked as a script; apply-rebrand.mjs imports this module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
