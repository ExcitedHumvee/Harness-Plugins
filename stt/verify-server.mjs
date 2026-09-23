/**
 * End-to-end checks for the DSH STT sidecar — no browser required.
 *
 * `verify-client.mjs` proves the browser half behaves. This proves the other
 * half actually transcribes: it reads `/health`, waits for the weights to load,
 * and — when given a clip — POSTs the audio exactly as the browser half does and
 * reports the transcript.
 *
 * The sidecar is optional: on a machine where setup has not run (or nothing is
 * listening) every check is skipped and the exit code is still 0, so this can sit
 * inside a repository-wide `node verify.mjs` without failing a fresh checkout.
 *
 * Usage:
 *   node stt/verify-server.mjs
 *   node stt/verify-server.mjs --file clip.wav
 *   node stt/verify-server.mjs --file clip.webm --expect "hello world"
 *   node stt/verify-server.mjs --base http://127.0.0.1:9000 --wait 30
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

/** Read `--name=value` or `--name value`; a missing option yields the fallback. */
const arg = (name, fallback) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] !== undefined) return process.argv[index + 1];
  return fallback;
};

const BASE = (arg('base', process.env.DSH_STT_BASE ?? 'http://127.0.0.1:8124')).replace(/\/+$/, '');
const FILE = arg('file', null);
const EXPECT = arg('expect', null);
const WAIT = Number.parseFloat(arg('wait', '60'));
const LANGUAGE = arg('language', 'auto');

/** Extensions the sidecar can demux, keyed to the MIME type the client sends. */
const MIME_BY_EXTENSION = {
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
};

let failures = 0;
let checks = 0;

/**
 * Assert one condition.
 * @param label - what is being asserted.
 * @param condition - the result.
 * @param detail - extra context on failure.
 */
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

/**
 * Fetch JSON with a timeout.
 * @param path - path below the sidecar base.
 * @param timeoutMs - per-request timeout.
 * @returns the parsed body, or null when nothing answered.
 */
async function health(timeoutMs = 4000) {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return await response.json();
  } catch {
    return null;
  }
}

console.log('');
console.log(`sidecar: ${BASE}`);
const first = await health();

if (first === null) {
  console.log('  skip the sidecar is not running — start it with stt/server/start.ps1 (or start.sh)');
  console.log('');
  console.log(`skipped (0 checks run) — nothing failed`);
  process.exit(0);
}

let state = first;
const deadline = Date.now() + WAIT * 1000;
while (state.status !== 'ready' && state.status !== 'error' && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  state = (await health()) ?? state;
}

check('the sidecar answers /health', true);
check('it reports a status', typeof state.status === 'string', JSON.stringify(state.status));
check('it names the faster-whisper model', String(state.model ?? '').startsWith('faster-whisper'), String(state.model));
check('it reports a device', typeof state.device === 'string' && state.device !== '', String(state.device));
check('it reports a compute type', typeof state.computeType === 'string' && state.computeType !== '', String(state.computeType));
check('it reports where the weights live', typeof state.cache === 'string' && state.cache !== '', String(state.cache));
check('the engine is ready', state.status === 'ready', `${String(state.status)} ${String(state.detail ?? '')}`.trim());

if (state.status !== 'ready') {
  console.log('');
  console.log(`${String(failures)} check(s) failed`);
  process.exit(1);
}

if (FILE !== null) {
  const bytes = readFileSync(FILE);
  const mime = MIME_BY_EXTENSION[extname(FILE).toLowerCase()] ?? 'application/octet-stream';
  console.log('');
  console.log(`clip: ${FILE} (${String(bytes.byteLength)} bytes, ${mime})`);

  const started = Date.now();
  const response = await fetch(`${BASE}/transcribe`, {
    method: 'POST',
    headers: {
      'content-type': mime,
      'x-dsh-stt-mime': mime,
      'x-dsh-stt-language': LANGUAGE,
      'x-dsh-stt-task': 'transcribe',
      'x-dsh-stt-vad': '1',
    },
    body: bytes,
    signal: AbortSignal.timeout(300000),
  });
  const payload = await response.json().catch(() => ({}));
  const roundTrip = ((Date.now() - started) / 1000).toFixed(2);

  check('the clip is accepted', response.ok, `HTTP ${String(response.status)} ${String(payload.error ?? '')}`.trim());
  const text = String(payload.text ?? '');
  check('a transcript comes back', text !== '', JSON.stringify(text));
  check('a language comes back', typeof payload.language === 'string' && payload.language !== '', String(payload.language));
  check('the transcript is not empty filler', text.trim().length > 1, JSON.stringify(text));
  if (EXPECT !== null) {
    check(`the transcript contains ${JSON.stringify(EXPECT)}`, text.toLowerCase().includes(EXPECT.toLowerCase()), JSON.stringify(text));
  }
  console.log('');
  console.log(`  transcript: ${JSON.stringify(text)}`);
  console.log(`  language:   ${String(payload.language)} (${String(payload.languageProbability)})`);
  console.log(`  audio:      ${String(payload.duration)}s decoded in ${String(payload.elapsed)}s (x${String(payload.realtimeFactor)} realtime)`);
  console.log(`  round trip: ${roundTrip}s`);
}

console.log('');
if (failures === 0) {
  console.log(`all checks passed (${String(checks)})`);
  process.exit(0);
}
console.log(`${String(failures)} of ${String(checks)} check(s) failed`);
process.exit(1);
