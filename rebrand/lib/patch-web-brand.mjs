/**
 * Rebrand the DSH web frontend bundle: remove the DeepSeek whale logo and the
 * "DeepSeek" wordmark, and render the "HARNESS" wordmark in their place.
 *
 * The bundle is minified production output on a single line, so the patch is
 * written against exact byte anchors rather than line numbers or formatting.
 * Every step asserts its anchor before touching anything, refuses to run when an
 * anchor is missing or ambiguous, writes only after all replacements succeed,
 * and re-checks the result. Nothing is guessed.
 *
 * Two independent call sites carry the brand mark, exported as `FishLogo` and
 * `BrandWordmark`:
 *
 *   `FishLogo` — the bare whale glyph.
 *   `BrandWordmark` — the full lockup: the word "DeepSeek" as outlined paths,
 *      then the whale, then a rounded badge whose two glyph paths spell "DS"
 *      (drawn with an inverted fill over the badge).
 *
 * Both are replaced. The `FISH_LOGO_PATH` / `FISH_LOGO_VIEWBOX` exports keep
 * their names (other code imports them) but now describe a neutral generic
 * glyph, so no consumer can render the whale.
 *
 * Every minified identifier involved — the JSX runtime, both component names,
 * the two constant locals — is resolved from the bundle at patch time by
 * `bundle-symbols.mjs`, not hardcoded. The build this was originally derived
 * from (`@deepseek-ai/dsh-web-frontend@0.1.5-rc.3`) used `d`, `cC`, `uC`, `Mr`,
 * `$6`; the next one used `l`, `G_`, `K_`, `lo`, `K6`. Anchoring on those names
 * is what made the patch refuse to run after an upgrade, so the names are now
 * discovered and only the brand *geometry* — which is artwork and stable — is
 * pinned.
 *
 * Usage:
 *   node rebrand/lib/patch-web-brand.mjs [--check] [--all] [--dist=DIR]
 *
 * Run `node rebrand/apply-rebrand.mjs` instead to patch the shell files
 * (title, manifest, favicon) in the same pass and verify the result.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  DS_BADGE_PREFIX,
  PATCHED_MARKER,
  WHALE_PREFIX,
  WORDMARK_LETTERING_PREFIX,
  count,
  findClosing,
  isAlreadyPatched,
  resolveBundleSymbols,
  resolvePatchedSymbols,
} from './bundle-symbols.mjs';
import { ensureBackup, frontendInstalls, installAt } from './resolve-frontend.mjs';

const CHECK_ONLY = process.argv.includes('--check');
const ALL = process.argv.includes('--all');
const DIST_ARG = process.argv.find((arg) => arg.startsWith('--dist='));

/**
 * Replace one whole `function NAME(...) {...}` declaration, found by its exact
 * declared parameter list and terminated by brace balancing over the BODY.
 *
 * The parameter list is skipped before balancing starts, because default
 * parameter values are object/array literals (`{size:t=24}`) whose braces would
 * otherwise be mistaken for the function body. Brace balancing is then
 * string-literal aware: the bundle carries `{` and `}` inside SVG path data and
 * quoted text, so a naive depth counter would stop in the wrong place.
 *
 * @param source - the bundle text.
 * @param signature - the exact `function NAME(params)` prefix, including `function `.
 * @param replacement - the replacement declaration.
 * @returns the patched source.
 */
function replaceFunction(source, signature, replacement) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`anchor missing: ${signature.slice(0, 60)}…`);
  if (source.indexOf(signature, start + 1) !== -1) {
    throw new Error(`anchor not unique: ${signature.slice(0, 60)}…`);
  }

  // Skip the parameter list: from the signature's opening paren to its match.
  const paramsOpen = source.indexOf('(', start);
  const paramsClose = findClosing(source, paramsOpen, '(', ')');
  const bodyOpen = source.indexOf('{', paramsClose + 1);
  if (bodyOpen === -1) throw new Error(`anchor missing function body: ${signature.slice(0, 60)}…`);

  const bodyClose = findClosing(source, bodyOpen, '{', '}');
  return source.slice(0, start) + replacement + source.slice(bodyClose + 1);
}

/**
 * Neutral generic glyph used wherever the whale used to be: a four-point spark.
 * Deliberately not brand-like, so no consumer renders DeepSeek artwork.
 */
const NEUTRAL_GLYPH = {
  viewbox: { width: 16, height: 16 },
  path:
    'M8 0.5 9.85 6.15 15.5 8 9.85 9.85 8 15.5 6.15 9.85 0.5 8 6.15 6.15Z',
};

/** The wordmark rendered in place of the DeepSeek lockup: just the word HARNESS. */
function harnessWordmarkReplacement(symbols) {
  return (
    `function ${symbols.wordmarkName}({size:t=24,className:r}){return ${symbols.jsx}.jsx("span",` +
    '{className:r,style:{fontSize:t*0.68,fontWeight:600,letterSpacing:"0.14em",lineHeight:1,whiteSpace:"nowrap"},children:"HARNESS"})}'
  );
}

/** The bare-logo component, rendering the neutral glyph instead of the whale. */
function fishLogoReplacement(symbols) {
  return (
    `function ${symbols.fishLogoName}({size:t=24,className:r}){return ${symbols.jsx}.jsx("svg",` +
    `{width:t,height:t,className:r,viewBox:"0 0 16 16",fill:"none","aria-hidden":true,children:${symbols.jsx}.jsx("path",{d:"` +
    NEUTRAL_GLYPH.path +
    '",fill:"currentColor"})})}'
  );
}

/**
 * Patch one bundle's text.
 *
 * Pure: it never touches the disk, so callers can patch and verify in memory
 * before deciding whether to write. Throws when a precondition fails, which is
 * the loud outcome a genuinely unrecognizable build is supposed to produce.
 *
 * @param original - the bundle source.
 * @returns {{status: 'already-patched'|'patched', source: string, before: number, after: number}} the result.
 */
export function patchBundleText(original) {
  let source = original;

  // ── preconditions ─────────────────────────────────────────────────────────
  if (isAlreadyPatched(source)) {
    return { status: 'already-patched', source, before: original.length, after: original.length };
  }

  // Every minified name this build uses, discovered rather than assumed.
  const symbols = resolveBundleSymbols(source);

  for (const [label, needle, expected] of [
    ['whale path', symbols.whalePrefix, 1],
    ['wordmark lettering', symbols.letteringPrefix, 1],
    ['DS badge glyph', symbols.badgePrefix, 1],
    ['wordmark defs', symbols.wordmarkDefsPrefix, 1],
  ]) {
    const found = count(source, needle);
    if (found !== expected) {
      throw new Error(
        `precondition failed: ${label} expected ${String(expected)} occurrence(s), found ${String(found)} — ` +
          'this frontend build is not the one the patch was written against; see rebrand/README.md',
      );
    }
  }
  // The wordmark lockup's first element is the lettering's D. Anchoring on the
  // surrounding `X.jsx("path",{d:"` prefix avoids matching an `M68.416` that
  // occurs inside the whale path's own data.
  if (count(source, symbols.wordmarkLetteringAnchor) !== 1) {
    throw new Error('precondition failed: wordmark lettering first path not uniquely anchored');
  }

  // ── 1. FISH_LOGO_VIEWBOX: keep the export name, drop the mark geometry ────
  const viewboxPattern = new RegExp(
    `const ([A-Za-z_$][\\w$]*)=\\{width:\\d+(?:\\.\\d+)?,height:\\d+(?:\\.\\d+)?\\}`,
  );
  const viewboxMatch = viewboxPattern.exec(source);
  if (viewboxMatch === null) throw new Error('anchor missing: FISH_LOGO_VIEWBOX declaration');
  if (viewboxMatch[1] !== symbols.viewboxLocal) {
    throw new Error(
      `anchor mismatch: expected the viewBox const ${symbols.viewboxLocal}, found ${viewboxMatch[1]}`,
    );
  }
  source =
    source.slice(0, viewboxMatch.index) +
    `const ${symbols.viewboxLocal}={width:${String(NEUTRAL_GLYPH.viewbox.width)},height:${String(NEUTRAL_GLYPH.viewbox.height)}}` +
    source.slice(viewboxMatch.index + viewboxMatch[0].length);

  // ── 2. FISH_LOGO_PATH: keep the export name, drop the whale path ──────────
  const pathPrefix = `${symbols.pathLocal}="`;
  const whaleStart = source.indexOf(pathPrefix + symbols.whalePrefix);
  if (whaleStart === -1) throw new Error(`anchor missing: ${symbols.pathLocal} FISH_LOGO_PATH assignment`);
  // The literal runs to the closing quote of the declaration it starts.
  const whalePathEnd = source.indexOf('"', whaleStart + pathPrefix.length);
  if (whalePathEnd === -1) throw new Error('anchor missing: end of FISH_LOGO_PATH literal');
  source =
    source.slice(0, whaleStart) +
    pathPrefix +
    NEUTRAL_GLYPH.path +
    '"' +
    source.slice(whalePathEnd + 1); // +1 skips the closing quote

  // ── 3. FishLogo component: render the neutral glyph ───────────────────────
  source = replaceFunction(source, symbols.fishSignature, fishLogoReplacement(symbols));

  // ── 4. BrandWordmark: render the word only ────────────────────────────────
  source = replaceFunction(source, symbols.wordmarkSignature, harnessWordmarkReplacement(symbols));

  // ── postconditions ────────────────────────────────────────────────────────
  if (source.includes(WHALE_PREFIX)) throw new Error('postcondition failed: whale path still present');
  if (source.includes(WORDMARK_LETTERING_PREFIX)) {
    throw new Error('postcondition failed: DeepSeek lettering still present');
  }
  if (source.includes(DS_BADGE_PREFIX)) throw new Error('postcondition failed: DS badge still present');
  if (source.includes(symbols.wordmarkDefsPrefix)) {
    throw new Error('postcondition failed: wordmark clip paths still present');
  }
  if (!source.includes(PATCHED_MARKER)) throw new Error('postcondition failed: HARNESS wordmark missing');
  if (count(source, `const ${symbols.viewboxLocal}={width:16,height:16}`) !== 1) {
    throw new Error('postcondition failed: FISH_LOGO_VIEWBOX not rewritten');
  }

  return { status: 'patched', source, before: original.length, after: source.length };
}

/**
 * Patch one discovered install: read the bundle, patch it in memory, and write
 * only when something changed.
 *
 * @param {{dist: string, bundle: string|null}} install - a discovered install.
 * @param {{checkOnly?: boolean}} [options] - report without writing.
 * @returns {{path: string, status: string, detail: string}} a one-line result.
 */
export function patchInstall(install, options = {}) {
  const checkOnly = options.checkOnly ?? false;
  const bundle = install.bundle;
  if (bundle === null || bundle === undefined) {
    return {
      path: install.dist,
      status: 'skipped',
      detail: 'no index-*.js bundle found in dist/assets (pass DSH_WEB_FRONTEND_BUNDLE)',
    };
  }
  const result = patchBundleText(readFileSync(bundle, 'utf8'));
  if (result.status === 'already-patched') {
    return { path: bundle, status: 'already-patched', detail: 'nothing to do' };
  }
  const delta = result.before - result.after;
  if (checkOnly) {
    return {
      path: bundle,
      status: 'would-patch',
      detail: `${String(result.before)} -> ${String(result.after)} bytes (-${String(delta)})`,
    };
  }
  const backup = ensureBackup(bundle);
  writeFileSync(bundle, result.source);
  return {
    path: bundle,
    status: 'patched',
    detail: `${String(result.before)} -> ${String(result.after)} bytes (-${String(delta)}); backup ${backup}`,
  };
}

function main() {
  const distArg = DIST_ARG === undefined ? null : DIST_ARG.slice('--dist='.length);
  const installs = frontendInstalls();
  if (installs.length === 0 && distArg === null) {
    console.error('No @deepseek-ai/dsh-web-frontend install found.');
    console.error('Set DSH_HOME, or point at one directly with --dist=DIR or DSH_WEB_FRONTEND_BUNDLE=FILE.');
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
      const result = patchInstall(install, { checkOnly: CHECK_ONLY });
      console.log(`${result.status.padEnd(16)} ${result.path}`);
      console.log(`${' '.repeat(16)} ${result.detail}`);
    } catch (error) {
      failed = true;
      console.error(`failed           ${install.bundle ?? install.dist}`);
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

// Run only when invoked as a script; the verifier imports this module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  NEUTRAL_GLYPH,
  WHALE_PREFIX,
  WORDMARK_LETTERING_PREFIX,
  DS_BADGE_PREFIX,
  PATCHED_MARKER,
  count,
  findClosing,
  isAlreadyPatched,
  resolveBundleSymbols,
  resolvePatchedSymbols,
  replaceFunction,
};
