/**
 * Validate the patch layer `install.mjs --wire` writes.
 *
 * `--wire` mounts plugins by hand-writing rows into the profile's patch file, and
 * a fresh profile's patch file is a header comment plus a bare empty array:
 *
 *   # …header…
 *   []
 *
 * Appending an `insert:` list to that leaves **two top-level YAML nodes**, which
 * the Cordis loader's parser rejects outright — "end of the stream or a document
 * separator is expected" — and the profile then stops booting. So the empty root
 * has to be replaced, not kept, and this check exists because that regression is
 * silent: the script exits 0 either way, and the damage only shows on the next
 * boot.
 *
 * Every case runs `install.mjs --wire` against a throwaway patch file under the OS
 * temp directory. It never reads or writes a real DSH profile, and it needs no
 * pnpm: bundle installation is step 6's business, not this.
 *
 * The written text is parsed with the same YAML parser the loader uses, resolved
 * from the DSH install. With no DSH install present this prints `skip` and exits 0,
 * so a fresh clone still verifies cleanly.
 *
 * Usage:
 *   node scripts/check-wire-patch.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');

const HEADER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
];

/** The shapes a patch layer can be in before the first `--wire` run. */
const CASES = [
  { name: 'bare empty array root', initial: [...HEADER, '[]'].join('\n') },
  { name: 'empty array root with a trailing newline', initial: `${[...HEADER, '[]'].join('\n')}\n` },
  { name: 'empty array root with inner spaces', initial: [...HEADER, '[  ]'].join('\n') },
  { name: 'header comments only', initial: HEADER.join('\n') },
  { name: 'existing insert block', initial: [...HEADER, '- insert:', '    - id: seed', '      name: file:///seed.js'].join('\n') },
];

let failures = 0;

/**
 * Record one check, in the shape the other `scripts/check-*.mjs` files use.
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
 * Load the parser the loader uses, looked up in DSH's own install.
 *
 * @returns {Promise<{load: (text: string) => unknown}|null>} the parser, or null when unavailable.
 */
async function loadYaml() {
  const roots = [
    join(DSH_HOME, 'profiles', 'node_modules', 'js-yaml'),
    join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'js-yaml'),
    join(DSH_HOME, 'profiles', 'node_modules', 'yaml'),
  ];
  for (const root of roots) {
    try {
      const mod = await import(pathToFileURL(join(root, 'index.js')).href);
      const parser = mod.default ?? mod;
      if (typeof parser.load === 'function') return parser;
      if (typeof parser.parse === 'function') return { load: (text) => parser.parse(text) };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Run `install.mjs --wire` against one patch file; returns its exit status. */
function runWire(patchFile) {
  // Inherited stdio rather than piped: the DSH file sandbox denies a process that
  // captures another program's output through a pipe, so the written file is read
  // back from disk instead.
  const result = spawnSync(
    process.execPath,
    [join(here, 'install.mjs'), '--wire', `--patch-file=${patchFile}`],
    { stdio: 'inherit', cwd: here },
  );
  return result.status;
}

const yaml = await loadYaml();
if (yaml === null) {
  console.log('  skip  no YAML parser found under $DSH_HOME (install DSH to run this check)');
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-wire-patch-'));
console.log(`patch-layer cases: ${String(CASES.length)}`);
console.log('');

for (let index = 0; index < CASES.length; index += 1) {
  const testCase = CASES[index];
  const profileDir = join(scratch, `profile-${String(index)}`);
  const patchFile = join(profileDir, 'cordis.patch.yml');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(patchFile, testCase.initial);

  console.log(`${testCase.name}:`);
  const status = runWire(patchFile);

  let written;
  try {
    written = readFileSync(patchFile, 'utf8');
  } catch {
    ok('patch file written', false);
    console.log('');
    continue;
  }

  ok('install.mjs --wire exits 0', status === 0, `exit ${String(status)}`);

  let parsed;
  try {
    parsed = yaml.load(written);
    ok('written layer parses', true);
  } catch (error) {
    ok('written layer parses', false, String(error.message).split('\n')[0]);
  }

  if (parsed !== undefined) {
    const rows = Array.isArray(parsed)
      ? parsed.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
      : [];
    ok('layer is a top-level array', Array.isArray(parsed));
    ok('mounts the sound-alerts row', rows.some((row) => row.id === 'sound-alerts'), JSON.stringify(rows.map((row) => row.id)));
    ok('mounts the rebrand row', rows.some((row) => row.id === 'rebrand'), JSON.stringify(rows.map((row) => row.id)));
    // The specific regression: a leftover `[]` beside the insert block.
    ok('no bare [] root survived', !/^\s*\[\s*\]\s*$/m.test(written));
  }

  // A second run must be a byte-for-byte no-op that adds no duplicate row.
  const secondStatus = runWire(patchFile);
  const afterSecond = readFileSync(patchFile, 'utf8');
  const soundAlertsRows = (afterSecond.match(/- id: sound-alerts/g) ?? []).length;
  ok('re-run is idempotent', secondStatus === 0 && afterSecond === written, `exit ${String(secondStatus)}`);
  ok('re-run adds no duplicate row', soundAlertsRows === 1, `${String(soundAlertsRows)} row(s)`);

  console.log('');
}

rmSync(scratch, { recursive: true, force: true });

if (failures > 0) {
  console.log(`${String(failures)} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
