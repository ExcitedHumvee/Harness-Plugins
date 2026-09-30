/**
 * Locate the build-specific symbols the rebrand patch anchors on.
 *
 * The frontend bundle is minified production output: every local name is a
 * short, content-hash-dependent identifier (`cC`, `G_`, `l`, `$6`, `K6`). A
 * patch that hardcodes those names works for exactly one build and then refuses
 * to run — loudly, but uselessly — the next time DSH upgrades the frontend.
 *
 * This module resolves them from the bundle instead, using signals the minifier
 * cannot rename away:
 *
 *   1. **The package's public export map.** The bundle ends with a map that
 *      binds exported names to local ones —
 *      `…,FISH_LOGO_PATH:K6,FISH_LOGO_VIEWBOX:lo,…,FishLogo:G_,…`. The exported
 *      names are part of the package's API and survive minification, so the
 *      whale path, the viewBox, and both logo components are all reachable
 *      through it. That is the primary signal.
 *   2. **Structural shape.** The components are matched by their props
 *      (`{size,className}` and `{size,className,includeMark}`) and confirmed by
 *      what their bodies reference, so a match is never taken on shape alone.
 *   3. **Brand geometry.** The whale path, the "DeepSeek" lettering, and the
 *      "DS" badge glyphs are artwork, not identifiers — their bytes are stable
 *      across builds and are what tell us which function is the lockup.
 *
 * The distinction matters because the patcher must find the *unpatched* build.
 * After patching, the components it wrote no longer match the signatures the
 * original used, so resolution failing is itself a signal — see
 * `isAlreadyPatched`, which is checked first.
 *
 * @module dsh-rebrand/bundle-symbols
 */

/** The whale path starts with this prefix; artwork bytes are stable across builds. */
const WHALE_PREFIX = 'M22.9168 1.43018C22.6713 1.31018';
/** The badge's "D" glyph path is unique by its distinctive prefix. */
const DS_BADGE_PREFIX = 'M132.848 8.93205H134.08V16.137';
/** First path of the "DeepSeek" lettering. */
const WORDMARK_LETTERING_PREFIX = 'M68.416 18.2447H67.0501V16.1272H68.416';
/** Marks the wordmark this patcher writes. */
const PATCHED_MARKER = 'children:"HARNESS"';

/** The export-map names the package publishes, and so the anchors we can trust. */
const EXPORTS = {
  path: 'FISH_LOGO_PATH',
  viewbox: 'FISH_LOGO_VIEWBOX',
  fishLogo: 'FishLogo',
  wordmark: 'BrandWordmark',
};

/** Count non-overlapping literal occurrences. */
function count(haystack, needle) {
  let n = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    n += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return n;
}

/**
 * Index of the delimiter matching the one at `open`, string-literal aware.
 *
 * @param source - the bundle text.
 * @param open - index of the opening delimiter.
 * @param opener - the opening character.
 * @param closer - the matching closing character.
 * @returns the index of the matching closing delimiter.
 */
function findClosing(source, open, opener, closer) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${opener}${closer} starting at ${String(open)}`);
}

/**
 * Read the bundle's export map: exported name → local identifier.
 *
 * The map is the object literal that binds the package's API; entries look like
 * `FISH_LOGO_PATH:K6` and `FishLogo:G_`. Keys are never minified, which is what
 * makes this the durable signal.
 *
 * Scanning is bounded to the export-map region so a `Name:local` pair appearing
 * in ordinary code cannot be mistaken for an export.
 *
 * @param source - the bundle text.
 * @param name - the exported name to resolve.
 * @returns the local identifier, or null when the export is absent.
 */
function exportedLocal(source, name) {
  const anchor = source.indexOf(name);
  if (anchor === -1) return null;
  const match = new RegExp(`${name}\\s*:\\s*([A-Za-z_$][\\w$]*)`).exec(source.slice(anchor));
  return match === null ? null : match[1];
}

/**
 * Slice a `function NAME(...) { ... }` declaration out of the bundle.
 *
 * Brace balancing over the body is string-literal aware, because the bundle
 * carries `{`/`}` inside SVG path data and quoted text.
 *
 * @param source - the bundle text.
 * @param start - index of the `function` keyword.
 * @returns {{source: string, end: number}|null} the declaration and its end offset.
 */
function functionAt(source, start) {
  const paramsOpen = source.indexOf('(', start);
  if (paramsOpen === -1) return null;
  let paramsClose;
  try {
    paramsClose = findClosing(source, paramsOpen, '(', ')');
  } catch {
    return null;
  }
  const bodyOpen = source.indexOf('{', paramsClose + 1);
  if (bodyOpen === -1) return null;
  let bodyClose;
  try {
    bodyClose = findClosing(source, bodyOpen, '{', '}');
  } catch {
    return null;
  }
  return { source: source.slice(start, bodyClose + 1), end: bodyClose + 1 };
}

/**
 * Find the one component whose props match `signature` and whose body satisfies
 * `predicate`.
 *
 * Matching on shape alone is not enough: the props pattern is generic, so the
 * body is required to reference the thing we are looking for. Ambiguity is an
 * error, never a coin flip.
 *
 * @param source - the bundle text.
 * @param signature - regular expression matching the declared parameter list.
 * @param predicate - receives the body source; true when this is the component.
 * @param what - a label for error messages.
 * @returns {{name: string, params: string[], source: string, start: number, end: number}} the match.
 */
function findComponent(source, signature, predicate, what) {
  const matches = [];
  const pattern = new RegExp(signature.source, 'g');
  let match = pattern.exec(source);
  while (match !== null) {
    const start = match.index;
    const span = functionAt(source, start);
    if (span !== null && predicate(span.source)) {
      matches.push({ name: match[1], params: match.slice(2), source: span.source, start, end: span.end });
    }
    pattern.lastIndex = start + match[0].length;
    match = pattern.exec(source);
  }

  if (matches.length === 0) throw new Error(`anchor missing: ${what}`);
  if (matches.length > 1) {
    throw new Error(
      `anchor not unique: ${what} — ${String(matches.length)} candidates (${matches.map((m) => m.name).join(', ')})`,
    );
  }
  return matches[0];
}

/**
 * Extract the JSX runtime identifier from a component body.
 *
 * The bundle imports the runtime under one minified name and calls it as
 * `X.jsx(` / `X.jsxs(`. The name changes per build, so it is derived from a
 * component we already identified rather than assumed.
 *
 * @param body - a component body expected to call the runtime.
 * @returns the runtime identifier.
 */
function jsxRuntimeOf(body) {
  const match = /\b([A-Za-z_$][\w$]*)\.jsxs?\(/.exec(body);
  if (match === null) throw new Error('anchor missing: JSX runtime call inside the wordmark component');
  return match[1];
}

/**
 * Whether this bundle already carries the patch.
 *
 * Checked before resolution, because a patched bundle no longer matches the
 * original signatures. The marker is the wordmark this patcher writes, anchored
 * on the export-mapped component so an unrelated `HARNESS` string cannot
 * trigger it.
 *
 * @param source - the bundle text.
 * @returns {boolean} true when the patch is already applied.
 */
export function isAlreadyPatched(source) {
  const local = exportedLocal(source, EXPORTS.wordmark);
  if (local === null) return false;
  const start = source.search(new RegExp(`function\\s+${local}\\s*\\(`));
  if (start === -1) return false;
  const span = functionAt(source, start);
  return span !== null && span.source.includes(PATCHED_MARKER);
}

/**
 * Resolve every build-specific symbol the patch needs.
 *
 * @param source - the bundle text, unpatched.
 * @returns {{
 *   jsx: string,
 *   fishLogoName: string,
 *   wordmarkName: string,
 *   viewboxLocal: string,
 *   pathLocal: string,
 *   whalePrefix: string,
 *   letteringPrefix: string,
 *   badgePrefix: string,
 *   wordmarkDefsPrefix: string,
 *   wordmarkLetteringAnchor: string,
 * }} the resolved symbols.
 */
export function resolveBundleSymbols(source) {
  if (!source.includes(WHALE_PREFIX)) {
    throw new Error(
      'anchor missing: whale path — this frontend build has no DeepSeek whale lockup to rebrand',
    );
  }

  const pathLocal = exportedLocal(source, EXPORTS.path);
  if (pathLocal === null) throw new Error(`anchor missing: export ${EXPORTS.path}`);
  const viewboxLocal = exportedLocal(source, EXPORTS.viewbox);
  if (viewboxLocal === null) throw new Error(`anchor missing: export ${EXPORTS.viewbox}`);

  // The whale path is the value of FISH_LOGO_PATH. Its binding shape
  // (`K6="M22.9168…`) puts the local name immediately before the literal.
  const pathBinding = new RegExp('([A-Za-z_$][\\w$]*)\\s*=\\s*"' + escapeRegExp(WHALE_PREFIX));
  const bindingMatch = pathBinding.exec(source);
  if (bindingMatch === null) {
    throw new Error(`anchor missing: the literal assigned to ${EXPORTS.path} (${pathLocal})`);
  }

  // FISH_LOGO_VIEWBOX is an object literal, usually declared beside the path in
  // the same `const a={...},b="..."` statement.
  const viewboxMatch = new RegExp(
    '([A-Za-z_$][\\w$]*)\\s*=\\s*\\{\\s*width\\s*:\\s*[\\d.]+\\s*,\\s*height\\s*:\\s*[\\d.]+\\s*\\}',
  ).exec(source);
  if (viewboxMatch === null) throw new Error(`anchor missing: the object assigned to ${EXPORTS.viewbox}`);
  if (viewboxMatch[1] !== viewboxLocal) {
    throw new Error(
      `anchor mismatch: ${EXPORTS.viewbox} resolves to ${viewboxLocal} but the geometry literal binds ${viewboxMatch[1]}`,
    );
  }

  // The bare logo: props {size,className}, body drawing FISH_LOGO_PATH.
  const fish = findComponent(
    source,
    /function\s+([A-Za-z_$][\w$]*)\s*\(\{\s*size\s*:\s*([\w$]+)\s*=\s*24\s*,\s*className\s*:\s*([\w$]+)\s*\}\)/,
    (body) => body.includes('d:' + pathLocal) || body.includes(`d:${pathLocal}`),
    `the ${EXPORTS.fishLogo} component drawing ${EXPORTS.path}`,
  );

  // The lockup: props {size,className,includeMark}, body drawing the lettering.
  const wordmark = findComponent(
    source,
    /function\s+([A-Za-z_$][\w$]*)\s*\(\{\s*size\s*:\s*([\w$]+)\s*=\s*24\s*,\s*className\s*:\s*([\w$]+)\s*,\s*includeMark\s*:\s*([\w$]+)\s*=\s*!0\s*\}\)/,
    (body) => body.includes(WORDMARK_LETTERING_PREFIX),
    `the ${EXPORTS.wordmark} component drawing the DeepSeek lettering`,
  );

  // The export map must agree with the structural match.
  const exportedFish = exportedLocal(source, EXPORTS.fishLogo);
  if (exportedFish !== null && exportedFish !== fish.name) {
    throw new Error(
      `anchor mismatch: ${EXPORTS.fishLogo} exports ${exportedFish} but the matching component is ${fish.name}`,
    );
  }
  const exportedWordmark = exportedLocal(source, EXPORTS.wordmark);
  if (exportedWordmark !== null && exportedWordmark !== wordmark.name) {
    throw new Error(
      `anchor mismatch: ${EXPORTS.wordmark} exports ${exportedWordmark} but the matching component is ${wordmark.name}`,
    );
  }

  if (count(source, WHALE_PREFIX) !== 1) {
    throw new Error(`anchor ambiguous: whale path appears ${String(count(source, WHALE_PREFIX))} times`);
  }
  if (count(source, WORDMARK_LETTERING_PREFIX) !== 1) {
    throw new Error(
      `anchor ambiguous: DeepSeek lettering appears ${String(count(source, WORDMARK_LETTERING_PREFIX))} times`,
    );
  }
  if (count(source, DS_BADGE_PREFIX) !== 1) {
    throw new Error(`anchor ambiguous: DS badge glyph appears ${String(count(source, DS_BADGE_PREFIX))} times`);
  }

  const jsx = jsxRuntimeOf(wordmark.source);
  if (!fish.source.includes(`${jsx}.jsx(`)) {
    throw new Error(`anchor mismatch: ${EXPORTS.fishLogo} does not use the same JSX runtime as ${EXPORTS.wordmark}`);
  }

  const wordmarkDefsPrefix = `${jsx}.jsxs("defs",{children:[${jsx}.jsx("clipPath"`;
  if (count(source, wordmarkDefsPrefix) !== 1) {
    throw new Error(
      `anchor missing: the wordmark <defs> clip paths (${String(count(source, wordmarkDefsPrefix))} occurrence(s))`,
    );
  }

  return {
    jsx,
    fishLogoName: fish.name,
    wordmarkName: wordmark.name,
    // The exact declared parameter lists, so the patcher can find the original
    // declarations without assuming the minifier's parameter names.
    fishSignature: `function ${fish.name}({size:${fish.params[0]}=24,className:${fish.params[1]}})`,
    wordmarkSignature:
      `function ${wordmark.name}({size:${wordmark.params[0]}=24,className:${wordmark.params[1]},` +
      `includeMark:${wordmark.params[2]}=!0})`,
    viewboxLocal: viewboxMatch[1],
    pathLocal: bindingMatch[1],
    whalePrefix: WHALE_PREFIX,
    letteringPrefix: WORDMARK_LETTERING_PREFIX,
    badgePrefix: DS_BADGE_PREFIX,
    wordmarkDefsPrefix,
    wordmarkLetteringAnchor: `${jsx}.jsx("path",{d:"${WORDMARK_LETTERING_PREFIX}`,
  };
}

/**
 * Resolve only what a *patched* bundle still needs identified.
 *
 * After the patch runs, the two components no longer match their original
 * signatures and `resolveBundleSymbols` correctly refuses to resolve them. The
 * verifier still has to read the result, so it needs the surviving local names —
 * the JSX runtime (from either written component) and the two constant locals
 * (from the export map, which survives the patch).
 *
 * @param source - the bundle text, patched.
 * @returns {{jsx: string, viewboxLocal: string, pathLocal: string}} the surviving symbols.
 */
export function resolvePatchedSymbols(source) {
  const fishLocal = exportedLocal(source, EXPORTS.fishLogo);
  const wordmarkLocal = exportedLocal(source, EXPORTS.wordmark);
  const named = [fishLocal, wordmarkLocal].filter((name) => name !== null);
  if (named.length === 0) throw new Error('anchor missing: neither logo component is exported');

  let jsx = null;
  for (const name of named) {
    const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
    if (start === -1) continue;
    const span = functionAt(source, start);
    if (span === null) continue;
    const match = /\b([A-Za-z_$][\w$]*)\.jsxs?\(/.exec(span.source);
    if (match !== null) {
      jsx = match[1];
      break;
    }
  }
  if (jsx === null) throw new Error('anchor missing: JSX runtime call inside a patched logo component');

  const viewboxLocal = exportedLocal(source, EXPORTS.viewbox);
  if (viewboxLocal === null) throw new Error(`anchor missing: export ${EXPORTS.viewbox}`);
  const pathLocal = exportedPathLocal(source);
  if (pathLocal === null) throw new Error(`anchor missing: export ${EXPORTS.path}`);

  return { jsx, viewboxLocal, pathLocal };
}

/**
 * The local holding the neutral glyph, which by design is no longer the whale
 * path literal and so cannot be found by geometry.
 *
 * @param source - the bundle text.
 * @returns the local identifier, or null.
 */
function exportedPathLocal(source) {
  const name = EXPORTS.path;
  const anchor = source.indexOf(name);
  if (anchor === -1) return null;
  const direct = new RegExp(`${name}\\s*:\\s*([A-Za-z_$][\\w$]*)`).exec(source.slice(anchor));
  if (direct !== null) return direct[1];
  // A patched bundle may have had the export map's local inlined away; fall back
  // to the declaration that now holds the neutral glyph.
  const neutral = new RegExp('([A-Za-z_$][\\w$]*)\\s*=\\s*"' + escapeRegExp(NEUTRAL_PATH_PREFIX)).exec(source);
  return neutral === null ? null : neutral[1];
}

/** First bytes of the neutral glyph the patcher writes; used to re-find its local. */
const NEUTRAL_PATH_PREFIX = 'M8 0.5 9.85 6.15 15.5 8';

/** Escape a literal for embedding in a regular expression. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export {
  WHALE_PREFIX,
  DS_BADGE_PREFIX,
  WORDMARK_LETTERING_PREFIX,
  PATCHED_MARKER,
  count,
  findClosing,
  escapeRegExp,
};
