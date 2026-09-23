/**
 * Node half of the DSH STT plugin.
 *
 * The UI lives entirely in the browser half; this half exists for two reasons:
 *
 * 1. A package only appears in the entry scan that composes
 *    `window.__DSH_BOOT__` if it is a well-formed Cordis Loader entry, so an
 *    `apply` binding is required for the client half to load at all.
 * 2. It starts the faster-whisper sidecar for you. On load it probes
 *    `http://127.0.0.1:<port>/health`; only when nothing answers does it spawn
 *    `server/stt_server.py` with the plugin's own virtualenv, detached, with
 *    output appended to `server/server.log`. Any HTTP answer — including the
 *    sidecar's `503 {"status":"starting"}` while the weights load — counts as
 *    "already running", so a live profile reload cannot spawn a second model.
 *
 * It deliberately does **not** kill the sidecar when the plugin unloads: the
 * profile re-composes on every patch reload, and a model that has to reload each
 * time is worse than a small idle process. Use `server/stop.ps1`
 * (`server/stop.sh`) to stop it.
 *
 * Environment overrides:
 *
 *     DSH_STT_AUTOSTART=0     never spawn; start the sidecar yourself
 *     DSH_STT_PYTHON=path     interpreter to use (default: <plugin>/.venv/…)
 *     DSH_STT_PORT=8124       port the sidecar listens on
 *     DSH_STT_MODEL=small     weights the sidecar loads
 *     DSH_STT_LOG=path        where the sidecar's output goes
 *
 * @module dsh-stt
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const serverScript = join(pluginRoot, 'server', 'stt_server.py');

/** Sidecar port; must match the client half's default endpoint. */
const PORT = process.env.DSH_STT_PORT ?? '8124';

/** Set once the spawn path has been taken in this process. */
let started = false;

/**
 * Log through the Cordis logger when one is available, else to stdout.
 *
 * @param ctx - the plugin context.
 * @param message - the line to log.
 */
function log(ctx, message) {
  const logger = ctx?.logger;
  if (logger?.info !== undefined) logger.info(`[dsh-stt] ${message}`);
  else console.log(`[dsh-stt] ${message}`);
}

/**
 * The interpreter that owns `faster-whisper`, if the setup script has run.
 *
 * @returns {string|null} absolute path to a python executable, or null.
 */
function findPython() {
  const override = process.env.DSH_STT_PYTHON;
  if (override !== undefined && override !== '') return existsSync(override) ? override : null;

  const candidates =
    process.platform === 'win32'
      ? [join(pluginRoot, '.venv', 'Scripts', 'python.exe')]
      : [join(pluginRoot, '.venv', 'bin', 'python'), join(pluginRoot, '.venv', 'bin', 'python3')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Is anything already serving the sidecar port?
 *
 * Any completed request counts as "up": the sidecar answers `/health` with 503
 * while it is still loading the model, and that is exactly the state where a
 * second spawn would be a mistake.
 *
 * @param timeoutMs - per-request timeout.
 * @returns {Promise<boolean>} true when something answered.
 */
async function isSidecarUp(timeoutMs = 1500) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Host plugin body: make sure the sidecar is running.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  if (started) return;

  if (process.env.DSH_STT_AUTOSTART === '0') {
    log(ctx, 'autostart disabled (DSH_STT_AUTOSTART=0)');
    return;
  }
  if (!existsSync(serverScript)) {
    log(ctx, `sidecar script missing at ${serverScript}`);
    return;
  }

  void (async () => {
    if (await isSidecarUp()) {
      log(ctx, `sidecar already listening on 127.0.0.1:${PORT}`);
      return;
    }

    const python = findPython();
    if (python === null) {
      log(ctx, 'no sidecar virtualenv found — run stt/server/setup.ps1 (or setup.sh) to install faster-whisper');
      return;
    }

    started = true;
    const logFile = process.env.DSH_STT_LOG ?? join(pluginRoot, 'server', 'server.log');
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      const fd = openSync(logFile, 'a');
      const child = spawn(python, [serverScript], {
        cwd: pluginRoot,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, DSH_STT_PORT: PORT },
      });
      child.unref();
      log(ctx, `started sidecar (pid ${String(child.pid ?? '?')}), log: ${logFile}`);
    } catch (error) {
      started = false;
      log(ctx, `could not start the sidecar: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
}
