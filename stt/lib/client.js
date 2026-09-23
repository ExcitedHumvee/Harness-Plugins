/**
 * Browser half of the DSH STT plugin.
 *
 * Adds a microphone button to the composer's trailing controls (the row the send
 * button lives in) that records the microphone and transcribes it with a local
 * faster-whisper sidecar over HTTP. The transcript is inserted into the composer
 * at the caret, so dictation lands where the user was typing.
 *
 * Design notes:
 *
 * - **Offline by construction.** Recording happens in the page, transcription in
 *   `server/stt_server.py` on 127.0.0.1, and the weights live in `stt/.models`.
 *   No audio — and no text — leaves the machine.
 * - **The meter is the point.** A dictation button that silently records nothing
 *   is useless, so a live input-level meter is always on screen while the
 *   microphone is open: a pill beside the button (bars + elapsed seconds), a full
 *   meter with a dBFS figure and a peak hold in the panel, and a standalone
 *   *Test microphone* mode that opens the mic without recording. If the level
 *   never rises above the noise floor the pill says **No audio** instead of
 *   letting you talk into a dead input.
 * - **The audio graph is primed inside the click.** Browsers start an
 *   `AudioContext` suspended unless it is created during a user gesture, and the
 *   permission prompt can outlive that gesture; a context created afterwards
 *   would leave the analyser reading silence forever. The context is therefore
 *   created and `resume()`d synchronously in the click handler, and re-resumed
 *   from the meter loop if the browser suspends it later.
 * - **Insertion degrades loudly, never silently.** The caret insert rides the
 *   composer's own paste command when the slot hands it over; otherwise the
 *   plugin writes into the editor's DOM (Lexical's `contenteditable`) through
 *   its own input pipeline, then falls back to replacing the draft, then to the
 *   clipboard — and always says which one it did, next to the button, not only
 *   inside the panel.
 * - **One clip, one request.** Push-to-talk: click to record, click again to stop
 *   and transcribe. The browser sends the container it recorded (webm/opus in
 *   Chromium, ogg/opus or mp4 elsewhere); the sidecar demuxes it with PyAV. A
 *   recording cap (default 120s) stops a forgotten session.
 * - **Nothing is sent on render.** The microphone is only opened by a user click,
 *   and the stream is closed as soon as the recording ends.
 *
 * @module dsh-stt/client
 */

window.__ModuleLoader__.load({
  id: "dsh-stt",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { Tooltip } = require("@deepseek-ai/dsh-client-ui-primitives");

    /** Dictionary namespace owned by this plugin. */
    const NS = "stt";

    /** Loopback address of the faster-whisper sidecar (see server/stt_server.py). */
    const DEFAULT_BASE = "http://127.0.0.1:8124";

    /** localStorage keys. */
    const BASE_KEY = "dsh-stt.base";
    const LANGUAGE_KEY = "dsh-stt.language";
    const TASK_KEY = "dsh-stt.task";
    const MODE_KEY = "dsh-stt.mode";
    const VAD_KEY = "dsh-stt.vad";
    const SILENCE_KEY = "dsh-stt.silence";
    const CAP_KEY = "dsh-stt.cap";
    const DEVICE_KEY = "dsh-stt.device";

    /** Container candidates, best first. Opus in WebM is what Chromium records. */
    const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];

    /** Level threshold (RMS of the waveform around its centre) for "not silence". */
    const SILENCE_RMS = 0.012;

    /** How many bars the meter draws. */
    const METER_BARS = 14;

    /** Level multiplier for the display: speech RMS sits around 0.02-0.2. */
    const LEVEL_GAIN = 4;

    /** Seconds of flat input before the UI says no audio is arriving. */
    const SILENT_WARN_SECONDS = 2;

    /** How long a success note stays on screen. */
    const NOTE_TTL_MS = 7000;

    // ── styles ───────────────────────────────────────────────────────────────
    // One scoped stylesheet, keyed by plugin id so a reload cannot duplicate it.
    const css = `
.dsh-stt{position:relative;display:inline-flex;align-items:center;gap:6px;flex:none}
.dsh-stt__trigger{position:relative;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary)}
.dsh-stt__trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-stt__trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.dsh-stt__trigger[disabled]{cursor:default;opacity:.55}
.dsh-stt__glyph{position:relative;z-index:1;display:inline-flex}
.dsh-stt--recording .dsh-stt__trigger,.dsh-stt--testing .dsh-stt__trigger{color:var(--dsw-alias-state-error-primary,#d33);border-color:currentColor}
.dsh-stt--working .dsh-stt__trigger{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.dsh-stt--error .dsh-stt__trigger{color:var(--dsw-alias-state-error-primary,#d33);border-color:currentColor}
.dsh-stt__spin{animation:dsh-stt-spin 1s linear infinite}
@keyframes dsh-stt-spin{to{transform:rotate(360deg)}}
.dsh-stt__pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;height:24px;padding:0 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l2,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;white-space:nowrap;max-width:200px;min-width:0;overflow:hidden}
.dsh-stt__pill--warn{color:var(--dsw-alias-state-error-primary,#d33);border-color:currentColor}
.dsh-stt__pill--ok{color:var(--dsw-alias-state-success-primary)}
.dsh-stt__dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#d33);flex:none;animation:dsh-stt-blink 1.1s ease-in-out infinite}
@keyframes dsh-stt-blink{50%{opacity:.25}}
.dsh-stt__bars{display:inline-flex;align-items:flex-end;gap:1.5px;height:14px;flex:none}
.dsh-stt__bar{width:2.5px;height:14px;border-radius:1px;background:currentColor;transform-origin:bottom center;opacity:.25}
.dsh-stt__label{overflow:hidden;text-overflow:ellipsis}
.dsh-stt__panel{position:absolute;right:0;bottom:calc(100% + 8px);z-index:60;box-sizing:border-box;width:340px;max-height:70vh;overflow:auto;padding:12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;text-align:left}
.dsh-stt__title{color:var(--dsw-alias-label-primary);font-weight:500;margin-bottom:8px}
.dsh-stt__row{display:flex;align-items:center;gap:8px;min-height:26px}
.dsh-stt__status{padding:6px 8px;margin-bottom:8px;border-radius:8px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.08));color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:11px;line-height:16px}
.dsh-stt__group{padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l3)}
.dsh-stt__group:first-of-type{border-top:0;padding-top:0}
.dsh-stt__hint{margin-top:2px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:11px;line-height:16px}
.dsh-stt input[type=text],.dsh-stt input[type=number],.dsh-stt select{box-sizing:border-box;height:26px;padding:0 6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2,transparent);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;font-family:inherit;font-size:12px}
.dsh-stt select{max-width:190px}
.dsh-stt textarea{box-sizing:border-box;width:100%;min-height:56px;padding:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2,transparent);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;font-family:inherit;font-size:12px;resize:vertical}
.dsh-stt__button{box-sizing:border-box;height:26px;padding:0 10px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,transparent);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;font-family:inherit;font-size:12px}
.dsh-stt__button:disabled{cursor:default;opacity:.55}
.dsh-stt__meter{display:flex;align-items:center;gap:8px}
.dsh-stt__meterTrack{position:relative;flex:1;height:10px;border-radius:999px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.14));overflow:hidden}
.dsh-stt__meterFill{position:absolute;inset:0 auto 0 0;width:0;background:var(--dsw-alias-state-success-primary,#2a2);transition:width .06s linear}
.dsh-stt__meterPeak{position:absolute;top:0;bottom:0;width:2px;background:var(--dsw-alias-label-primary);opacity:.7}
.dsh-stt__meterValue{width:52px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dsh-stt__diag{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:11px;line-height:16px}
.dsh-stt__diagKey{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.dsh-stt__diagValue{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsh-stt a{color:inherit}
`;

    // ── settings ─────────────────────────────────────────────────────────────
    /**
     * Read one saved string setting.
     * @param key - localStorage key.
     * @param fallback - value used when unset.
     * @returns the stored string or the fallback.
     */
    function readString(key, fallback) {
      try {
        const saved = window.localStorage.getItem(key);
        if (typeof saved === "string") return saved;
      } catch {
        /* storage unavailable */
      }
      return fallback;
    }

    /**
     * Persist one setting, ignoring a storage that refuses writes.
     * @param key - localStorage key.
     * @param value - value to store.
     */
    function writeString(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* storage unavailable: the setting applies for this session only */
      }
    }

    /**
     * Resolve the sidecar base URL: saved setting first, then the default.
     * @returns {string} base URL without a trailing slash.
     */
    function readBase() {
      const saved = readString(BASE_KEY, "").trim();
      return saved === "" ? DEFAULT_BASE : saved.replace(/\/+$/, "");
    }

    /**
     * The language to ask for: a saved ISO code, or `auto` to let Whisper detect.
     * @returns {string} lower-case code or "auto".
     */
    function readLanguage() {
      const raw = readString(LANGUAGE_KEY, "auto").trim().toLowerCase();
      return /^[a-z]{2,3}$/.test(raw) ? raw : "auto";
    }

    /**
     * The task: `transcribe` keeps the source language, `translate` renders English.
     * @returns {string} the saved task.
     */
    function readTask() {
      return readString(TASK_KEY, "transcribe") === "translate" ? "translate" : "transcribe";
    }

    /**
     * Where a finished transcript goes.
     * @returns {string} one of caret | replace | copy.
     */
    function readMode() {
      const saved = readString(MODE_KEY, "caret");
      return saved === "replace" || saved === "copy" ? saved : "caret";
    }

    /**
     * Whether the sidecar's voice-activity filter is requested.
     * @returns {boolean} the saved setting.
     */
    function readVad() {
      return readString(VAD_KEY, "1") !== "0";
    }

    /**
     * Seconds of silence after which recording stops by itself; 0 disables it.
     * @returns {number} clamped to 0..30.
     */
    function readSilence() {
      const parsed = Number.parseFloat(readString(SILENCE_KEY, "0"));
      if (!Number.isFinite(parsed)) return 0;
      return Math.min(30, Math.max(0, parsed));
    }

    /**
     * Hard cap on one recording, in seconds.
     * @returns {number} clamped to 5..900.
     */
    function readCap() {
      const parsed = Number.parseFloat(readString(CAP_KEY, "120"));
      if (!Number.isFinite(parsed)) return 120;
      return Math.min(900, Math.max(5, parsed));
    }

    /**
     * The saved microphone device id, or "" for the system default.
     * @returns {string} a device id.
     */
    function readDevice() {
      return readString(DEVICE_KEY, "").trim();
    }

    // ── pure helpers ─────────────────────────────────────────────────────────
    /**
     * Pick the best container the browser can actually record.
     *
     * @param Recorder - the MediaRecorder constructor in scope.
     * @returns {string} a MIME type, or "" to let the browser choose.
     */
    function pickMime(Recorder) {
      const supported = Recorder?.isTypeSupported;
      if (typeof supported !== "function") return "";
      for (const candidate of MIME_CANDIDATES) {
        try {
          if (supported.call(Recorder, candidate)) return candidate;
        } catch {
          /* an exotic implementation: keep looking */
        }
      }
      return "";
    }

    /**
     * Normalise a transcript: collapse the whitespace Whisper scatters around.
     *
     * @param text - the raw transcript.
     * @returns {string} the text to insert; empty when there was no speech.
     */
    function cleanupText(text) {
      return String(text ?? "")
        .replace(/\s+/g, " ")
        .replace(/\s+([.,!?;:])/g, "$1")
        .trim();
    }

    /**
     * Append a transcript to an existing draft without gluing words together.
     *
     * @param current - the draft already in the composer.
     * @param addition - the transcript.
     * @returns {string} the new draft.
     */
    function appendToDraft(current, addition) {
      const draft = String(current ?? "");
      if (draft.trim() === "") return addition;
      if (/\s$/.test(draft)) return `${draft}${addition}`;
      return `${draft} ${addition}`;
    }

    /**
     * Turn raw time-domain samples into a level.
     *
     * A byte of 128 is the waveform's centre, so the samples are re-centred
     * before the RMS and the peak are taken. Both are 0..1.
     *
     * @param samples - `Uint8Array` from `getByteTimeDomainData`.
     * @returns {{rms: number, peak: number}} the level of this frame.
     */
    function computeLevel(samples) {
      if (samples === undefined || samples === null || samples.length === 0) return { rms: 0, peak: 0 };
      let sum = 0;
      let peak = 0;
      for (const value of samples) {
        const delta = (value - 128) / 128;
        sum += delta * delta;
        const magnitude = delta < 0 ? -delta : delta;
        if (magnitude > peak) peak = magnitude;
      }
      return { rms: Math.sqrt(sum / samples.length), peak };
    }

    /**
     * The bar heights of the meter, as fill fractions in 0..1.
     *
     * @param level - the smoothed level.
     * @param count - how many bars to draw.
     * @returns {number[]} one fraction per bar, left to right.
     */
    function meterBars(level, count = METER_BARS) {
      const scaled = Math.min(1, Math.max(0, level * LEVEL_GAIN)) * count;
      return Array.from({ length: count }, (_, index) => Math.min(1, Math.max(0, scaled - index)));
    }

    /**
     * A level in dBFS, for a number a human can compare between runs.
     *
     * @param level - the linear level.
     * @returns {number} dBFS, floored at -100.
     */
    function levelToDb(level) {
      const safe = Math.max(level, 1e-5);
      return Math.max(-100, Math.round(20 * Math.log10(safe)));
    }

    /**
     * The composer's editor element: a Lexical `contenteditable` with
     * `role="textbox"`.
     *
     * @param doc - the document to search (injectable for tests).
     * @returns the editor element, or null when there is none.
     */
    function findComposerEditor(doc) {
      if (doc === undefined || doc === null || typeof doc.querySelectorAll !== "function") return null;
      /** @type {any[]} */
      const candidates = Array.from(doc.querySelectorAll('[role="textbox"]')).filter(
        (node) =>
          node?.isContentEditable === true ||
          node?.contentEditable === "true" ||
          node?.getAttribute?.("contenteditable") === "true",
      );
      if (candidates.length === 0) return null;
      // The composer sits at the bottom of the conversation; panels and menus also
      // contain textboxes, so those are only a last resort.
      const outside = candidates.filter((node) => node.closest?.('[role="dialog"], [role="menu"]') == null);
      const pool = outside.length > 0 ? outside : candidates;
      const lexical = pool.filter((node) => node.hasAttribute?.("data-lexical-editor") === true);
      const chosen = lexical.length > 0 ? lexical : pool;
      return chosen[chosen.length - 1];
    }

    /**
     * Read the composer text out of the editor's DOM.
     *
     * @param doc - the document to search.
     * @returns {string} the text, or "" when there is no editor.
     */
    function domDraft(doc) {
      const editor = findComposerEditor(doc);
      if (editor === null) return "";
      const text = editor.innerText ?? editor.textContent ?? "";
      return typeof text === "string" ? text : "";
    }

    /**
     * The current draft, from whichever handle reached this occupant.
     *
     * @param handles - the slot props (and their optional composer handles).
     * @param doc - the document to fall back to.
     * @returns {string} the draft text.
     */
    function readDraftFrom(handles, doc) {
      const sources = [handles?.keyboard?.snapshot, handles?.input?.snapshot, handles?.inputActions?.state];
      for (const source of sources) {
        const snapshot = typeof source?.get === "function" ? source.get() : source;
        if (snapshot !== undefined && snapshot !== null && typeof snapshot.draft === "string") return snapshot.draft;
      }
      return domDraft(doc);
    }

    /**
     * Write text into the composer through the editor's own input pipeline.
     *
     * The last resort, and the one that makes the plugin work when the slot does
     * not hand a plugin the composer handle: the resident editor is a Lexical
     * `contenteditable`, and Lexical applies an `execCommand("insertText")` as a
     * normal edit (it arrives as `beforeinput`/`input`). The edit is only believed
     * when the DOM text actually changed, so a browser that accepts the command
     * and does nothing cannot fake success.
     *
     * @param text - the text to insert.
     * @param doc - the document to write into.
     * @param replace - replace the whole draft instead of inserting at the caret.
     * @returns {boolean} whether the text landed.
     */
    function insertIntoComposer(text, doc, replace = false) {
      const editor = findComposerEditor(doc);
      if (editor === null) return false;
      const textOf = (node) => {
        const value = node.innerText ?? node.textContent ?? "";
        return typeof value === "string" ? value : "";
      };
      try {
        editor.focus?.({ preventScroll: true });
      } catch {
        try {
          editor.focus?.();
        } catch {
          /* focus is best-effort: the insert below decides */
        }
      }

      const before = textOf(editor);
      try {
        if (typeof doc.execCommand === "function") {
          if (replace) doc.execCommand("selectAll", false);
          doc.execCommand("insertText", false, text);
          if (textOf(editor) !== before) return true;
        }
      } catch {
        /* fall through to the synthetic event */
      }

      try {
        const Ctor = doc.defaultView?.InputEvent ?? window.InputEvent;
        if (typeof Ctor === "function") {
          const event = new Ctor("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true, composed: true });
          editor.dispatchEvent(event);
          if (textOf(editor) !== before) return true;
        }
      } catch {
        /* nothing else to try */
      }
      return false;
    }

    /**
     * Put the transcript into the composer, degrading one step at a time.
     *
     * @param text - the cleaned transcript.
     * @param handles - `keyboard` / `inputActions` from the slot props.
     * @param mode - caret | replace | copy.
     * @param doc - the document, for the DOM fallback.
     * @returns {string} the path taken: caret | replace | dom | copy.
     */
    function placeText(text, handles, mode, doc = typeof document === "undefined" ? null : document) {
      if (mode === "copy") return "copy";
      const keyboard = handles?.keyboard;
      const inputActions = handles?.inputActions;
      const phase = keyboard?.snapshot?.phase;
      const busy = typeof phase === "string" && phase !== "plain";

      if (!busy && typeof keyboard?.paste === "function") {
        if (mode === "replace" && typeof inputActions?.setDraft === "function") {
          inputActions.setDraft(text);
          return "replace";
        }
        keyboard.paste(text);
        return "caret";
      }
      if (!busy && typeof inputActions?.setDraft === "function") {
        if (mode === "replace") {
          inputActions.setDraft(text);
          return "replace";
        }
        inputActions.setDraft(appendToDraft(readDraftFrom(handles, doc), text));
        return "caret";
      }
      if (!busy && insertIntoComposer(text, doc, mode === "replace")) return "dom";
      return "copy";
    }

    /** Format seconds as m:ss for the recording pill. */
    function clock(seconds) {
      const total = Math.max(0, Math.floor(seconds));
      const minutes = Math.floor(total / 60);
      return `${String(minutes)}:${String(total % 60).padStart(2, "0")}`;
    }

    /** Microphone glyph. */
    function MicGlyph({ size = 15 }) {
      return jsxs("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        "aria-hidden": true,
        children: [
          jsx("rect", { x: "6", y: "2", width: "4", height: "7.2", rx: "2", fill: "currentColor" }),
          jsx("path", {
            d: "M3.6 7.4a4.4 4.4 0 0 0 8.8 0M8 11.9V14M6 14h4",
            stroke: "currentColor",
            "stroke-width": "1.3",
            "stroke-linecap": "round",
          }),
        ],
      });
    }

    /** Stop glyph shown while recording. */
    function StopGlyph({ size = 15 }) {
      return jsx("svg", { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true, children: jsx("rect", { x: "3.5", y: "3.5", width: "9", height: "9", rx: "2", fill: "currentColor" }) });
    }

    /** Indeterminate spinner shown while the sidecar is transcribing. */
    function SpinGlyph({ size = 15 }) {
      return jsxs("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        className: "dsh-stt__spin",
        "aria-hidden": true,
        children: jsx("path", { d: "M8 2.2a5.8 5.8 0 1 1-5.6 4.4", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" }),
      });
    }

    /** The live input-level bars, used both in the pill and in the panel. */
    function LevelBars({ level, bars = METER_BARS, className = "dsh-stt__bars" }) {
      return jsx("span", {
        className,
        "aria-hidden": true,
        children: meterBars(level, bars).map((fill, index) =>
          jsx("span", {
            key: String(index),
            className: "dsh-stt__bar",
            "data-fill": fill.toFixed(2),
            style: { opacity: String(0.22 + fill * 0.78), transform: `scaleY(${String(0.35 + fill * 0.65)})` },
          }),
        ),
      });
    }

    /** A labelled slider-like bar with a peak mark and a dBFS readout. */
    function LevelMeter({ level, peak, label }) {
      const percent = Math.min(100, Math.round(Math.min(1, level * LEVEL_GAIN) * 100));
      const peakPercent = Math.min(100, Math.round(Math.min(1, peak * LEVEL_GAIN) * 100));
      return jsxs("div", {
        className: "dsh-stt__meter",
        children: [
          jsx("span", { className: "dsh-stt__diagKey", children: label }),
          jsxs("span", {
            className: "dsh-stt__meterTrack",
            role: "meter",
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": percent,
            "aria-label": label,
            children: [
              jsx("span", { className: "dsh-stt__meterFill", style: { width: `${String(percent)}%` } }),
              jsx("span", { className: "dsh-stt__meterPeak", style: { left: `${String(peakPercent)}%` } }),
            ],
          }),
          jsx("span", { className: "dsh-stt__meterValue", children: `${String(levelToDb(level))} dB` }),
        ],
      });
    }

    /**
     * The composer button: meters, records, transcribes, inserts.
     *
     * @param props - slot props: the composer handles plus the locale `t`.
     */
    function SttButton(props) {
      const { t } = props;
      const [phase, setPhase] = react.useState("idle"); // idle | recording | testing | working | error
      const [note, setNote] = react.useState(null);
      const [warning, setWarning] = react.useState(null);
      const [level, setLevel] = react.useState(0);
      const [peak, setPeak] = react.useState(0);
      const [elapsed, setElapsed] = react.useState(0);
      const [captured, setCaptured] = react.useState(0);
      const [open, setOpen] = react.useState(false);
      const [health, setHealth] = react.useState(null);
      const [transcript, setTranscript] = react.useState("");
      const [insertPath, setInsertPath] = react.useState(null);
      const [lastUpload, setLastUpload] = react.useState(null);
      const [devices, setDevices] = react.useState([]);
      const [base, setBase] = react.useState(readBase);
      const [language, setLanguage] = react.useState(readLanguage);
      const [task, setTask] = react.useState(readTask);
      const [mode, setMode] = react.useState(readMode);
      const [vad, setVad] = react.useState(readVad);
      const [silence, setSilence] = react.useState(readSilence);
      const [cap, setCap] = react.useState(readCap);
      const [device, setDevice] = react.useState(readDevice);

      const streamRef = react.useRef(null);
      const recorderRef = react.useRef(null);
      const chunksRef = react.useRef([]);
      const bytesRef = react.useRef(0);
      const mimeRef = react.useRef("");
      const abortRef = react.useRef(null);
      const rafRef = react.useRef(0);
      const meterRef = react.useRef(null);
      const audioCtxRef = react.useRef(null);
      const silenceSinceRef = react.useRef(0);
      const capTimerRef = react.useRef(0);
      const noteTimerRef = react.useRef(0);
      const startedAtRef = react.useRef(0);
      const elapsedRef = react.useRef(-1);
      const levelRef = react.useRef(0);
      const peakRef = react.useRef(0);
      const runRef = react.useRef(0);

      /** Settings the recording path reads at stop time, without stale closures. */
      const settingsRef = react.useRef(null);
      settingsRef.current = { base, language, task, vad, silence, cap, mode, device };
      const handlesRef = react.useRef(null);
      handlesRef.current = { keyboard: props.keyboard, inputActions: props.inputActions, input: props.input };

      /** Clear a transient note and its timer. */
      const clearNote = react.useCallback(() => {
        if (noteTimerRef.current !== 0) {
          window.clearTimeout(noteTimerRef.current);
          noteTimerRef.current = 0;
        }
        setNote(null);
      }, []);

      /**
       * Show a note, and retire the successful ones on their own.
       * @param text - the message.
       * @param sticky - keep it until the next action (errors, warnings).
       */
      const showNote = react.useCallback(
        (text, sticky = false) => {
          if (noteTimerRef.current !== 0) {
            window.clearTimeout(noteTimerRef.current);
            noteTimerRef.current = 0;
          }
          setNote(text);
          if (!sticky) {
            noteTimerRef.current = window.setTimeout(() => {
              noteTimerRef.current = 0;
              setNote(null);
            }, NOTE_TTL_MS);
          }
        },
        [],
      );

      /** Copy text to the clipboard; false when the browser refuses. */
      const copy = react.useCallback(async (text) => {
        try {
          if (typeof window.navigator?.clipboard?.writeText !== "function") return false;
          await window.navigator.clipboard.writeText(text);
          return true;
        } catch {
          return false;
        }
      }, []);

      /**
       * Stop the level meter and release the audio graph.
       *
       * The context is closed rather than kept for the next recording: it is
       * cheap to recreate, and the next recording recreates it inside its own
       * click gesture, which is the one place a browser is guaranteed not to
       * hand back a suspended context.
       */
      const stopMeter = react.useCallback(() => {
        if (rafRef.current !== 0 && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(rafRef.current);
        }
        rafRef.current = 0;
        const meter = meterRef.current;
        meterRef.current = null;
        if (meter !== null) {
          try {
            meter.source.disconnect();
          } catch {
            /* already detached */
          }
        }
        const ctx = audioCtxRef.current;
        audioCtxRef.current = null;
        if (ctx !== null) {
          try {
            ctx.close?.();
          } catch {
            /* already closed */
          }
        }
        setLevel(0);
        levelRef.current = 0;
      }, []);

      /** Release the microphone; a stream left open keeps the browser's mic light on. */
      const stopStream = react.useCallback(() => {
        const stream = streamRef.current;
        streamRef.current = null;
        if (stream === null) return;
        try {
          for (const track of stream.getTracks()) track.stop();
        } catch {
          /* an exotic stream implementation */
        }
      }, []);

      /**
       * Create (or reuse) the AudioContext, inside the click gesture.
       *
       * A context created after an `await` can start suspended, and a suspended
       * context makes the analyser read pure silence — which is exactly the
       * "is it even receiving audio?" failure this meter exists to rule out.
       */
      const primeAudioContext = react.useCallback(() => {
        const Ctor = window.AudioContext ?? window.webkitAudioContext;
        if (typeof Ctor !== "function") return null;
        try {
          const existing = audioCtxRef.current;
          if (existing !== null && existing.state !== "closed") {
            void existing.resume?.();
            return existing;
          }
          const ctx = new Ctor();
          audioCtxRef.current = ctx;
          void ctx.resume?.();
          return ctx;
        } catch {
          return null;
        }
      }, []);

      react.useEffect(
        () => () => {
          if (capTimerRef.current !== 0) window.clearTimeout(capTimerRef.current);
          if (noteTimerRef.current !== 0) window.clearTimeout(noteTimerRef.current);
          capTimerRef.current = 0;
          noteTimerRef.current = 0;
          stopMeter(); // closes the audio context as well
          stopStream();
          if (abortRef.current !== null) abortRef.current.abort();
        },
        [stopMeter, stopStream],
      );

      /** Ask the sidecar for its state; used by the panel and after a failure. */
      const probe = react.useCallback(async () => {
        try {
          const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
          const payload = await response.json();
          setHealth(payload);
          return payload;
        } catch {
          setHealth(null);
          return null;
        }
      }, [base]);

      react.useEffect(() => {
        if (open) probe();
      }, [open, probe]);

      /** List the audio inputs, so a wrong device is one click away from fixed. */
      react.useEffect(() => {
        if (!open) return undefined;
        let cancelled = false;
        void (async () => {
          try {
            const media = window.navigator?.mediaDevices;
            if (typeof media?.enumerateDevices !== "function") return;
            const list = await media.enumerateDevices();
            if (cancelled || !Array.isArray(list)) return;
            setDevices(
              list
                .filter((entry) => entry?.kind === "audioinput")
                .map((entry, index) => ({ id: String(entry.deviceId ?? ""), label: String(entry.label ?? "") || `Input ${String(index + 1)}` })),
            );
          } catch {
            /* enumeration is a convenience; recording still works without it */
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [open]);

      /** Apply a finished transcript: insert it, then say where it went. */
      const deliver = react.useCallback(
        (text) => {
          const path = placeText(text, handlesRef.current, settingsRef.current.mode);
          setInsertPath(path);
          if (path === "copy") {
            void copy(text).then((copied) => showNote(copied ? t("status.copied") : t("status.copiedManual"), !copied));
            return;
          }
          if (path === "replace") showNote(t("status.replaced"));
          else if (path === "dom") showNote(t("status.domInserted"));
          else showNote(t("status.inserted"));
        },
        [copy, showNote, t],
      );

      /** Transcribe the recorded blob and hand the text to the composer. */
      const finish = react.useCallback(async () => {
        const run = runRef.current;
        const chunks = chunksRef.current;
        const bytes = bytesRef.current;
        chunksRef.current = [];
        bytesRef.current = 0;
        const type = (chunks[0] && chunks[0].type) || mimeRef.current || "audio/webm";
        const silent = peakRef.current < SILENCE_RMS;
        stopStream();
        setWarning(null);

        if (chunks.length === 0) {
          setPhase("error");
          setLastUpload({ bytes, status: 0, error: t("error.emptyRecording") });
          showNote(silent ? t("error.silentMic") : t("error.emptyRecording"), true);
          return;
        }

        const current = settingsRef.current;
        setPhase("working");
        showNote(t("status.transcribing"));
        const controller = new AbortController();
        abortRef.current = controller;
        const startedAt = Date.now();

        try {
          const blob = new window.Blob(chunks, { type });
          const response = await fetch(`${current.base}/transcribe`, {
            method: "POST",
            headers: {
              "content-type": type,
              "x-dsh-stt-mime": type,
              "x-dsh-stt-language": current.language,
              "x-dsh-stt-task": current.task,
              "x-dsh-stt-vad": current.vad ? "1" : "0",
            },
            body: blob,
            signal: controller.signal,
          });
          if (!response.ok) {
            let detail = `HTTP ${String(response.status)}`;
            try {
              const payload = await response.json();
              if (payload?.detail) detail = String(payload.detail);
              else if (payload?.error) detail = String(payload.error);
              else if (payload?.status) detail = t(`engine.${payload.status}`).replace("{model}", String(payload.model ?? ""));
            } catch {
              /* a non-JSON error body */
            }
            setLastUpload({ bytes: blob.size, status: response.status, elapsed: (Date.now() - startedAt) / 1000, error: detail });
            throw new Error(detail);
          }
          const payload = await response.json();
          if (runRef.current !== run) return;
          const text = cleanupText(payload?.text ?? "");
          const elapsedSeconds = (Date.now() - startedAt) / 1000;
          setLastUpload({ bytes: blob.size, status: response.status, elapsed: elapsedSeconds, language: payload?.language, detected: payload?.duration });
          setTranscript(text);
          if (text === "") {
            setPhase("error");
            showNote(silent ? t("error.silentMic") : t("error.noSpeech"), true);
            return;
          }
          await deliver(text);
          if (runRef.current === run) setPhase("idle");
        } catch (error) {
          if (runRef.current !== run) return;
          const message = error instanceof Error ? error.message : String(error);
          if (message === "cancelled" || (error instanceof Error && error.name === "AbortError")) {
            setPhase("idle");
            clearNote();
            return;
          }
          setPhase("error");
          const healthNow = await probe();
          showNote(healthNow === null ? t("error.offline") : message, true);
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
        }
      }, [clearNote, deliver, probe, showNote, stopStream, t]);

      /** End the recording; `onstop` then transcribes whatever was captured. */
      const stopRecording = react.useCallback(() => {
        const recorder = recorderRef.current;
        if (recorder === null) return;
        recorderRef.current = null;
        if (capTimerRef.current !== 0) {
          window.clearTimeout(capTimerRef.current);
          capTimerRef.current = 0;
        }
        try {
          if (recorder.state !== "inactive") recorder.stop();
          else void finish();
        } catch {
          void finish();
        }
      }, [finish]);

      /** Close the microphone without transcribing anything (test mode too). */
      const stopTest = react.useCallback(() => {
        runRef.current += 1;
        stopMeter();
        stopStream();
        setPhase("idle");
        setWarning(null);
        clearNote();
      }, [clearNote, stopMeter, stopStream]);

      /**
       * Watch the input level: draws the meter, warns on a dead input, and stops
       * the recording after a configured stretch of silence.
       */
      const startMeter = react.useCallback(
        (stream) => {
          const ctx = audioCtxRef.current;
          if (ctx === null) {
            setWarning(t("note.meterUnavailable"));
            return;
          }
          try {
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.5;
            source.connect(analyser);
            meterRef.current = { source, analyser, samples: new Uint8Array(analyser.fftSize) };
            startedAtRef.current = Date.now();
            elapsedRef.current = -1;
            setElapsed(0);
            setCaptured(0);
            peakRef.current = 0;
            setPeak(0);
            silenceSinceRef.current = 0;
            setWarning(null);

            const loop = () => {
              const meter = meterRef.current;
              if (meter === null) return;
              const context = audioCtxRef.current;
              if (context !== null && context.state === "suspended") void context.resume?.();

              meter.analyser.getByteTimeDomainData(meter.samples);
              const { rms, peak: framePeak } = computeLevel(meter.samples);
              const previous = levelRef.current;
              const smoothed = rms > previous ? rms : previous * 0.72 + rms * 0.28;
              levelRef.current = smoothed;
              setLevel(smoothed);
              if (framePeak > peakRef.current) {
                peakRef.current = framePeak;
                setPeak(framePeak);
              }

              const seconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
              if (seconds !== elapsedRef.current) {
                elapsedRef.current = seconds;
                setElapsed(seconds);
              }

              const isRecording = recorderRef.current !== null;
              const dead = peakRef.current < SILENCE_RMS;
              if (seconds >= SILENT_WARN_SECONDS && dead) setWarning(t("note.silent"));
              else if (!dead) setWarning(null);

              const timeout = settingsRef.current.silence;
              if (isRecording && timeout > 0 && seconds >= SILENT_WARN_SECONDS) {
                if (rms >= SILENCE_RMS) {
                  silenceSinceRef.current = 0;
                } else if (silenceSinceRef.current === 0) {
                  silenceSinceRef.current = Date.now();
                } else if (Date.now() - silenceSinceRef.current >= timeout * 1000) {
                  showNote(t("note.autoStop"));
                  stopRecording();
                  return; // the meter is torn down by finish()
                }
              }
              rafRef.current = window.requestAnimationFrame(loop);
            };
            rafRef.current = window.requestAnimationFrame(loop);
          } catch {
            // A browser that refuses the audio graph still records; the meter is
            // the only thing lost, and the pill says so.
            setWarning(t("note.meterUnavailable"));
            stopMeter();
          }
        },
        [showNote, stopMeter, stopRecording, t],
      );

      /** Open the microphone and start recording. */
      const startRecording = react.useCallback(async () => {
        const media = window.navigator?.mediaDevices;
        const Recorder = window.MediaRecorder;
        if (typeof media?.getUserMedia !== "function" || typeof Recorder !== "function") {
          setPhase("error");
          showNote(t("error.unsupported"), true);
          return;
        }

        clearNote();
        setTranscript("");
        setInsertPath(null);
        setLastUpload(null);
        // Inside the gesture: see primeAudioContext.
        primeAudioContext();

        try {
          const stream = await media.getUserMedia(recordingConstraints(settingsRef.current.device));
          const mime = pickMime(Recorder);
          const recorder = mime === "" ? new Recorder(stream) : new Recorder(stream, { mimeType: mime });
          mimeRef.current = mime;
          chunksRef.current = [];
          bytesRef.current = 0;
          streamRef.current = stream;
          recorderRef.current = recorder;
          runRef.current += 1;

          recorder.ondataavailable = (event) => {
            const data = event?.data;
            if (data === undefined || data === null) return;
            if (typeof data.size === "number" && data.size === 0) return;
            chunksRef.current.push(data);
            bytesRef.current += typeof data.size === "number" ? data.size : 0;
            setCaptured(bytesRef.current);
          };
          recorder.onstop = () => {
            stopMeter();
            void finish();
          };
          recorder.onerror = () => {
            stopMeter();
            stopStream();
            recorderRef.current = null;
            setPhase("error");
            setLastUpload({ bytes: bytesRef.current, status: 0, error: t("error.recorder") });
            showNote(t("error.recorder"), true);
          };

          recorder.start(250);
          setPhase("recording");
          startMeter(stream);

          const limit = settingsRef.current.cap;
          capTimerRef.current = window.setTimeout(() => {
            showNote(t("note.cap").replace("{s}", String(limit)));
            stopRecording();
          }, limit * 1000);
        } catch (error) {
          stopStream();
          const message = error instanceof Error ? error.message : String(error);
          setPhase("error");
          showNote(/denied|dismiss|not allowed/i.test(message) ? t("error.permission") : message, true);
        }
      }, [clearNote, finish, primeAudioContext, showNote, startMeter, stopRecording, stopStream, t]);

      /**
       * Test mode: open the microphone and meter it, without recording or
       * transcribing. The fastest way to answer "is it receiving audio?".
       */
      const startTest = react.useCallback(async () => {
        const media = window.navigator?.mediaDevices;
        if (typeof media?.getUserMedia !== "function") {
          setPhase("error");
          showNote(t("error.unsupported"), true);
          return;
        }
        clearNote();
        primeAudioContext();
        try {
          const stream = await media.getUserMedia(recordingConstraints(settingsRef.current.device));
          streamRef.current = stream;
          recorderRef.current = null;
          runRef.current += 1;
          setPhase("testing");
          startMeter(stream);
        } catch (error) {
          stopStream();
          const message = error instanceof Error ? error.message : String(error);
          setPhase("error");
          showNote(/denied|dismiss|not allowed/i.test(message) ? t("error.permission") : message, true);
        }
      }, [clearNote, primeAudioContext, showNote, startMeter, stopStream, t]);

      /** Cancel an in-flight transcription. */
      const cancel = react.useCallback(() => {
        runRef.current += 1; // invalidate the running sequence
        if (abortRef.current !== null) {
          abortRef.current.abort();
          abortRef.current = null;
        }
        setPhase("idle");
        clearNote();
      }, [clearNote]);

      const onClick = () => {
        if (phase === "recording") stopRecording();
        else if (phase === "testing") stopTest();
        else if (phase === "working") cancel();
        else void startRecording();
      };

      const onTestToggle = () => {
        if (phase === "testing") stopTest();
        else if (phase !== "recording" && phase !== "working") void startTest();
      };

      const label = phase === "recording"
        ? t("action.stop")
        : phase === "testing"
          ? t("action.stopTest")
          : phase === "working"
            ? t("action.cancel")
            : t("action.record");
      const className = `dsh-stt${phase === "recording" ? " dsh-stt--recording" : ""}${phase === "testing" ? " dsh-stt--testing" : ""}${phase === "working" ? " dsh-stt--working" : ""}${phase === "error" ? " dsh-stt--error" : ""}`;
      const live = phase === "recording" || phase === "testing";
      const pillText = live
        ? warning === null
          ? `${clock(elapsed)} · ${captured > 0 ? `${String(Math.max(1, Math.round(captured / 1024)))} KB` : t("status.listening")}`
          : warning
        : phase === "working"
          ? t("status.transcribing")
          : note;

      return jsxs("div", {
        className,
        children: [
          jsx("style", { "data-plugin-css": "dsh-stt", children: css }),
          pillText === null
            ? null
            : jsxs("span", {
                className: `dsh-stt__pill${warning !== null && live ? " dsh-stt__pill--warn" : ""}${phase === "idle" && note !== null ? " dsh-stt__pill--ok" : ""}`,
                role: "status",
                "aria-live": "polite",
                children: [
                  live ? jsx("span", { className: "dsh-stt__dot" }) : null,
                  jsx(LevelBars, { level: live ? level : 0 }),
                  jsx("span", { className: "dsh-stt__label", title: pillText, children: pillText }),
                ],
              }),
          jsx(Tooltip, {
            label,
            side: "top",
            delayMs: 400,
            disabled: open,
            children: jsx("button", {
              type: "button",
              className: "dsh-stt__trigger",
              "aria-label": label,
              "aria-pressed": phase === "recording",
              "aria-expanded": open,
              onClick,
              onContextMenu: (event) => {
                event.preventDefault();
                setOpen((value) => !value);
              },
              children: jsx("span", {
                className: "dsh-stt__glyph",
                children: live ? jsx(StopGlyph, {}) : phase === "working" ? jsx(SpinGlyph, {}) : jsx(MicGlyph, {}),
              }),
            }),
          }),
          open
            ? jsx(SttPanel, {
                t,
                health,
                note,
                warning,
                phase,
                transcript,
                level,
                peak,
                elapsed,
                captured,
                insertPath,
                lastUpload,
                devices,
                base,
                language,
                task,
                mode,
                vad,
                silence,
                cap,
                device,
                handles: handlesRef.current,
                onSave: (next) => {
                  setBase(next.base);
                  setLanguage(next.language);
                  setTask(next.task);
                  setMode(next.mode);
                  setVad(next.vad);
                  setSilence(next.silence);
                  setCap(next.cap);
                  setDevice(next.device);
                  writeString(BASE_KEY, next.base);
                  writeString(LANGUAGE_KEY, next.language);
                  writeString(TASK_KEY, next.task);
                  writeString(MODE_KEY, next.mode);
                  writeString(VAD_KEY, next.vad ? "1" : "0");
                  writeString(SILENCE_KEY, String(next.silence));
                  writeString(CAP_KEY, String(next.cap));
                  writeString(DEVICE_KEY, next.device);
                  probe();
                },
                onProbe: probe,
                onTest: onTestToggle,
                onCopy: async () => {
                  const copied = await copy(transcript);
                  showNote(copied ? t("status.copied") : t("status.copiedManual"), !copied);
                },
                onClose: () => setOpen(false),
              })
            : null,
        ],
      });
    }

    /**
     * The getUserMedia constraints for one recording: the chosen input, with the
     * speech-friendly processing that browsers apply well.
     *
     * @param deviceId - the saved device id, or "" for the system default.
     * @returns the constraint object.
     */
    function recordingConstraints(deviceId) {
      /** @type {Record<string, unknown>} */
      const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (typeof deviceId === "string" && deviceId !== "") audio.deviceId = { exact: deviceId };
      return { audio };
    }

    /**
     * Settings popover: engine, microphone and meter, insertion, recognition,
     * the last transcript, and the diagnostics needed to explain a silent run.
     */
    function SttPanel(props) {
      const {
        t, health, note, warning, phase, transcript, level, peak, elapsed, captured, insertPath, lastUpload,
        devices, base, language, task, mode, vad, silence, cap, device, handles, onSave, onProbe, onTest, onCopy, onClose,
      } = props;
      const [baseDraft, setBaseDraft] = react.useState(base);
      const [languageDraft, setLanguageDraft] = react.useState(language);
      const [taskDraft, setTaskDraft] = react.useState(task);
      const [modeDraft, setModeDraft] = react.useState(mode);
      const [vadDraft, setVadDraft] = react.useState(vad);
      const [silenceDraft, setSilenceDraft] = react.useState(String(silence));
      const [capDraft, setCapDraft] = react.useState(String(cap));
      const [deviceDraft, setDeviceDraft] = react.useState(device);

      const engine = health === null
        ? t("engine.offline")
        : t(`engine.${health.status}`).replace("{model}", String(health.model ?? ""));
      const live = phase === "recording" || phase === "testing";
      const status = phase === "working"
        ? t("status.transcribing")
        : warning !== null && live
          ? warning
          : note ?? (live ? t("status.listening") : engine);
      const options = devices.some((entry) => entry.id === deviceDraft)
        ? devices
        : deviceDraft === ""
          ? devices
          : [{ id: deviceDraft, label: t("panel.deviceMissing") }, ...devices];

      return jsxs("div", {
        className: "dsh-stt__panel",
        role: "dialog",
        "aria-label": t("panel.title"),
        children: [
          jsx("div", { className: "dsh-stt__title", children: t("panel.title") }),
          jsx("div", { className: "dsh-stt__status", children: note === null || live ? status : `${engine} — ${status}` }),

          jsxs("div", {
            className: "dsh-stt__group",
            children: [
              jsx("div", { className: "dsh-stt__label", style: { marginBottom: "4px" }, children: t("panel.mic") }),
              jsxs("div", {
                className: "dsh-stt__row",
                children: [
                  jsx("span", { className: "dsh-stt__label", children: t("panel.device") }),
                  jsxs("select", {
                    value: deviceDraft,
                    onChange: (event) => setDeviceDraft(event.target.value),
                    children: [
                      jsx("option", { value: "", children: t("panel.deviceDefault") }),
                      ...options.map((entry) => jsx("option", { value: entry.id, children: entry.label }, entry.id)),
                    ],
                  }),
                ],
              }),
              jsx("div", { className: "dsh-stt__hint", children: t("panel.deviceNote") }),
              jsx("div", { style: { margin: "6px 0" }, children: jsx(LevelMeter, { level: live ? level : 0, peak, label: t("panel.meter") }) }),
              jsxs("div", {
                className: "dsh-stt__row",
                children: [
                  jsx("button", {
                    type: "button",
                    className: "dsh-stt__button",
                    onClick: onTest,
                    disabled: phase === "recording" || phase === "working",
                    children: phase === "testing" ? t("panel.stopTest") : t("panel.test"),
                  }),
                  jsx("span", { className: "dsh-stt__hint", children: live ? clock(elapsed) : t("panel.testNote") }),
                ],
              }),
            ],
          }),

          jsxs("div", {
            className: "dsh-stt__group",
            children: [
              jsxs("div", {
                className: "dsh-stt__row",
                children: [
                  jsx("span", { className: "dsh-stt__label", children: t("panel.mode") }),
                  jsxs("select", {
                    value: modeDraft,
                    onChange: (event) => setModeDraft(event.target.value),
                    children: [
                      jsx("option", { value: "caret", children: t("panel.modeCaret") }),
                      jsx("option", { value: "replace", children: t("panel.modeReplace") }),
                      jsx("option", { value: "copy", children: t("panel.modeCopy") }),
                    ],
                  }),
                ],
              }),
              jsx("div", { className: "dsh-stt__hint", children: t("panel.modeNote") }),
            ],
          }),

          jsxs("div", {
            className: "dsh-stt__group",
            children: [
              jsxs("div", {
                className: "dsh-stt__row",
                children: [
                  jsx("span", { className: "dsh-stt__label", children: t("panel.endpoint") }),
                  jsx("input", {
                    type: "text",
                    value: baseDraft,
                    style: { width: "180px" },
                    onChange: (event) => setBaseDraft(event.target.value),
                  }),
                ],
              }),
              jsx("div", { className: "dsh-stt__hint", children: t("panel.endpointNote") }),

              jsxs("div", {
                className: "dsh-stt__row",
                children: [
                  jsx("span", { className: "dsh-stt__label", children: t("panel.language") }),
                  jsx("input", {
                    type: "text",
                    value: languageDraft,
                    placeholder: t("panel.languageHint"),
                    style: { width: "80px" },
                    onChange: (event) => setLanguageDraft(event.target.value),
                  }),
                ],
              }),
              jsx("div", { className: "dsh-stt__hint", children: t("panel.languageNote") }),

              jsxs("div", {
                className: "dsh-stt__row",
                children: [
                  jsx("span", { className: "dsh-stt__label", children: t("panel.task") }),
                  jsxs("select", {
                    value: taskDraft,
                    onChange: (event) => setTaskDraft(event.target.value),
                    children: [
                      jsx("option", { value: "transcribe", children: t("panel.taskTranscribe") }),
                      jsx("option", { value: "translate", children: t("panel.taskTranslate") }),
                    ],
                  }),
                ],
              }),
              jsx("div", { className: "dsh-stt__hint", children: t("panel.taskNote") }),

              jsxs("div", {
                className: "dsh-stt__row",
                children: [
                  jsx("span", { className: "dsh-stt__label", children: t("panel.vad") }),
                  jsx("input", {
                    type: "checkbox",
                    checked: vadDraft,
                    onChange: (event) => setVadDraft(event.target.checked),
                  }),
                ],
              }),
              jsx("div", { className: "dsh-stt__hint", children: t("panel.vadNote") }),

              jsxs("div", {
                className: "dsh-stt__row",
                children: [
                  jsx("span", { className: "dsh-stt__label", children: t("panel.silence") }),
                  jsx("input", {
                    type: "number",
                    min: "0",
                    max: "30",
                    step: "0.5",
                    value: silenceDraft,
                    style: { width: "80px" },
                    onChange: (event) => setSilenceDraft(event.target.value),
                  }),
                ],
              }),
              jsx("div", { className: "dsh-stt__hint", children: t("panel.silenceNote") }),

              jsxs("div", {
                className: "dsh-stt__row",
                children: [
                  jsx("span", { className: "dsh-stt__label", children: t("panel.cap") }),
                  jsx("input", {
                    type: "number",
                    min: "5",
                    max: "900",
                    step: "5",
                    value: capDraft,
                    style: { width: "80px" },
                    onChange: (event) => setCapDraft(event.target.value),
                  }),
                ],
              }),
              jsx("div", { className: "dsh-stt__hint", children: t("panel.capNote") }),
            ],
          }),

          jsxs("div", {
            className: "dsh-stt__group",
            children: [
              jsx("div", { className: "dsh-stt__label", style: { marginBottom: "4px" }, children: t("panel.transcript") }),
              jsx("textarea", { readOnly: true, value: transcript, placeholder: t("panel.transcriptHint") }),
              jsx("div", { className: "dsh-stt__hint", children: t("panel.transcriptNote") }),
            ],
          }),

          jsxs("div", {
            className: "dsh-stt__group",
            children: [
              jsx("div", { className: "dsh-stt__label", style: { marginBottom: "4px" }, children: t("panel.diagnostics") }),
              jsxs("div", {
                className: "dsh-stt__diag",
                children: [
                  jsx("span", { className: "dsh-stt__diagKey", children: t("panel.diagHandles") }),
                  jsx("span", { className: "dsh-stt__diagValue", children: describeHandles(handles, t) }),
                  jsx("span", { className: "dsh-stt__diagKey", children: t("panel.diagDevice") }),
                  jsx("span", { className: "dsh-stt__diagValue", children: deviceLabel(devices, device, t) }),
                  jsx("span", { className: "dsh-stt__diagKey", children: t("panel.diagPeak") }),
                  jsx("span", { className: "dsh-stt__diagValue", children: `${String(levelToDb(peak))} dB` }),
                  jsx("span", { className: "dsh-stt__diagKey", children: t("panel.diagCaptured") }),
                  jsx("span", { className: "dsh-stt__diagValue", children: captured === 0 ? t("panel.diagNone") : `${String(Math.round(captured / 1024))} KB` }),
                  jsx("span", { className: "dsh-stt__diagKey", children: t("panel.diagUpload") }),
                  jsx("span", {
                    className: "dsh-stt__diagValue",
                    children: lastUpload === null
                      ? t("panel.diagNone")
                      : `HTTP ${String(lastUpload.status)} · ${String(Math.round((lastUpload.bytes ?? 0) / 1024))} KB${lastUpload.elapsed === undefined ? "" : ` · ${lastUpload.elapsed.toFixed(2)}s`}${lastUpload.error === undefined ? "" : ` · ${lastUpload.error}`}`,
                  }),
                  jsx("span", { className: "dsh-stt__diagKey", children: t("panel.diagInsert") }),
                  jsx("span", { className: "dsh-stt__diagValue", children: insertPath === null ? t("panel.diagNone") : describeInsert(insertPath, t) }),
                  jsx("span", { className: "dsh-stt__diagKey", children: t("panel.diagEngine") }),
                  jsx("span", { className: "dsh-stt__diagValue", children: engine }),
                  jsx("span", { className: "dsh-stt__diagKey", children: t("panel.diagCache") }),
                  jsx("span", { className: "dsh-stt__diagValue", children: String(health?.cache ?? t("panel.diagNone")) }),
                ],
              }),
            ],
          }),

          jsxs("div", {
            className: "dsh-stt__row",
            style: { marginTop: "10px" },
            children: [
              jsx("button", {
                type: "button",
                className: "dsh-stt__button",
                onClick: () => {
                  const seconds = Number.parseFloat(silenceDraft);
                  const limit = Number.parseFloat(capDraft);
                  const tag = languageDraft.trim().toLowerCase();
                  onSave({
                    base: baseDraft.trim() === "" ? base : baseDraft.trim().replace(/\/+$/, ""),
                    language: /^[a-z]{2,3}$/.test(tag) ? tag : "auto",
                    task: taskDraft === "translate" ? "translate" : "transcribe",
                    mode: modeDraft === "replace" || modeDraft === "copy" ? modeDraft : "caret",
                    vad: vadDraft === true,
                    silence: Number.isFinite(seconds) ? Math.min(30, Math.max(0, seconds)) : 0,
                    cap: Number.isFinite(limit) ? Math.min(900, Math.max(5, limit)) : 120,
                    device: deviceDraft,
                  });
                },
                children: t("panel.save"),
              }),
              jsx("button", { type: "button", className: "dsh-stt__button", onClick: onProbe, children: t("panel.check") }),
              jsx("button", {
                type: "button",
                className: "dsh-stt__button",
                disabled: transcript === "",
                onClick: onCopy,
                children: t("panel.copy"),
              }),
              jsx("span", { style: { flex: "1" } }),
              jsx("button", { type: "button", className: "dsh-stt__button", onClick: onClose, children: t("panel.close") }),
            ],
          }),
        ],
      });
    }

    /**
     * Which composer handles reached this occupant — the first thing to check
     * when a transcript does not land where it should.
     *
     * @param handles - the slot props.
     * @param t - the locale lookup.
     * @returns {string} a short human summary.
     */
    function describeHandles(handles, t) {
      const parts = [];
      if (typeof handles?.keyboard?.paste === "function") parts.push("keyboard.paste");
      if (typeof handles?.inputActions?.setDraft === "function") parts.push("inputActions.setDraft");
      return parts.length === 0 ? t("panel.diagHandlesNo") : `${t("panel.diagHandlesYes")}: ${parts.join(", ")}`;
    }

    /** The label of the configured input device. */
    function deviceLabel(devices, device, t) {
      if (device === "") return t("panel.deviceDefault");
      const found = devices.find((entry) => entry.id === device);
      return found === undefined ? t("panel.deviceMissing") : found.label;
    }

    /** A human phrase for the insertion path that was taken. */
    function describeInsert(path, t) {
      if (path === "caret") return t("status.inserted");
      if (path === "dom") return t("status.domInserted");
      if (path === "replace") return t("status.replaced");
      return t("status.copied");
    }

    /** English strings; the Chinese dictionary mirrors these keys exactly. */
    const en = {
      "action.record": "Dictate with faster-whisper (offline)",
      "action.stop": "Stop recording and transcribe",
      "action.stopTest": "Stop the microphone test",
      "action.cancel": "Cancel transcription",
      "panel.title": "Speech to text",
      "panel.mic": "Microphone",
      "panel.device": "Input",
      "panel.deviceDefault": "System default",
      "panel.deviceMissing": "Saved device (not connected)",
      "panel.deviceNote": "Device names appear after the browser has microphone permission once.",
      "panel.test": "Test microphone",
      "panel.stopTest": "Stop test",
      "panel.testNote": "Opens the mic and meters it without recording anything.",
      "panel.meter": "Level",
      "panel.endpoint": "Sidecar URL",
      "panel.endpointNote": "Loopback only. Nothing is uploaded anywhere else.",
      "panel.language": "Language",
      "panel.languageHint": "auto",
      "panel.languageNote": "\u201cauto\u201d detects the language per clip; a code such as en or de is faster and steadier.",
      "panel.task": "Task",
      "panel.taskTranscribe": "Transcribe",
      "panel.taskTranslate": "Translate to English",
      "panel.taskNote": "Translate renders any language as English text.",
      "panel.vad": "Silence filter",
      "panel.vadNote": "Drop silence before decoding. Leave it on for dictation.",
      "panel.mode": "Insert",
      "panel.modeCaret": "At the cursor",
      "panel.modeReplace": "Replace the draft",
      "panel.modeCopy": "Copy to clipboard",
      "panel.modeNote": "At the cursor uses the composer's own paste command, then the editor itself; a busy composer is copied instead.",
      "panel.silence": "Stop after silence (s)",
      "panel.silenceNote": "0 disables it. Otherwise recording stops itself after that much quiet.",
      "panel.cap": "Recording cap (s)",
      "panel.capNote": "A forgotten recording stops here.",
      "panel.transcript": "Last transcript",
      "panel.transcriptHint": "The transcript appears here.",
      "panel.transcriptNote": "Select the text to copy it by hand if the clipboard is blocked.",
      "panel.diagnostics": "Diagnostics",
      "panel.diagHandles": "Composer handles",
      "panel.diagHandlesYes": "received",
      "panel.diagHandlesNo": "none \u2014 the editor fallback is used",
      "panel.diagDevice": "Device",
      "panel.diagPeak": "Peak seen",
      "panel.diagCaptured": "Captured",
      "panel.diagUpload": "Last request",
      "panel.diagInsert": "Inserted via",
      "panel.diagEngine": "Engine",
      "panel.diagCache": "Weights",
      "panel.diagNone": "\u2014",
      "panel.copy": "Copy",
      "panel.save": "Save",
      "panel.check": "Check engine",
      "panel.close": "Close",
      "engine.ready": "Ready ({model})",
      "engine.loading": "Loading {model}\u2026",
      "engine.starting": "Starting {model}\u2026",
      "engine.error": "Engine error ({model})",
      "engine.offline": "Sidecar not reachable \u2014 run stt/server/start.ps1",
      "status.listening": "Listening\u2026",
      "status.testing": "Metering the microphone\u2026",
      "status.transcribing": "Transcribing\u2026",
      "status.inserted": "Inserted at the cursor.",
      "status.domInserted": "Inserted into the composer.",
      "status.replaced": "Replaced the draft.",
      "status.copied": "Copied to the clipboard.",
      "status.copiedManual": "The clipboard is blocked \u2014 copy the transcript from the panel.",
      "note.autoStop": "Stopped after silence.",
      "note.cap": "Recording cap of {s}s reached.",
      "note.silent": "No audio \u2014 check the input device",
      "note.meterUnavailable": "The browser will not provide an audio meter here; recording still works.",
      "error.permission": "Microphone permission was refused. Allow it for this page and try again.",
      "error.unsupported": "This browser cannot record audio (no MediaRecorder or getUserMedia).",
      "error.emptyRecording": "Nothing was recorded \u2014 hold on a moment longer next time.",
      "error.silentMic": "The microphone delivered silence. Pick another input in the panel, or check the system input level.",
      "error.noSpeech": "No speech was found in that clip.",
      "error.recorder": "The recorder failed. Check the microphone and try again.",
      "error.offline": "Sidecar not reachable. Start it with stt/server/start.ps1 (or start.sh).",
    };

    /** Simplified Chinese mirror of `en`. */
    const zh = {
      "action.record": "\u8bed\u97f3\u8f93\u5165\uff08faster-whisper\uff0c\u79bb\u7ebf\uff09",
      "action.stop": "\u505c\u6b62\u5f55\u97f3\u5e76\u8f6c\u5199",
      "action.stopTest": "\u505c\u6b62\u9ea6\u514b\u98ce\u6d4b\u8bd5",
      "action.cancel": "\u53d6\u6d88\u8f6c\u5199",
      "panel.title": "\u8bed\u97f3\u8f6c\u6587\u5b57",
      "panel.mic": "\u9ea6\u514b\u98ce",
      "panel.device": "\u8f93\u5165\u8bbe\u5907",
      "panel.deviceDefault": "\u7cfb\u7edf\u9ed8\u8ba4",
      "panel.deviceMissing": "\u5df2\u4fdd\u5b58\u7684\u8bbe\u5907\uff08\u672a\u8fde\u63a5\uff09",
      "panel.deviceNote": "\u6d4f\u89c8\u5668\u6388\u4e88\u9ea6\u514b\u98ce\u6743\u9650\u540e\u624d\u4f1a\u663e\u793a\u8bbe\u5907\u540d\u79f0\u3002",
      "panel.test": "\u6d4b\u8bd5\u9ea6\u514b\u98ce",
      "panel.stopTest": "\u505c\u6b62\u6d4b\u8bd5",
      "panel.testNote": "\u4ec5\u6253\u5f00\u9ea6\u514b\u98ce\u5e76\u663e\u793a\u7535\u5e73\uff0c\u4e0d\u5f55\u97f3\u3002",
      "panel.meter": "\u7535\u5e73",
      "panel.endpoint": "\u670d\u52a1\u5730\u5740",
      "panel.endpointNote": "\u4ec5\u672c\u673a\u56de\u73af\u5730\u5740\uff0c\u4e0d\u4f1a\u4e0a\u4f20\u5230\u4efb\u4f55\u5176\u4ed6\u5730\u65b9\u3002",
      "panel.language": "\u8bed\u8a00",
      "panel.languageHint": "auto",
      "panel.languageNote": "\u201cauto\u201d \u6bcf\u6bb5\u81ea\u52a8\u68c0\u6d4b\uff1b\u586b\u5199 en\u3001de \u7b49\u4ee3\u7801\u66f4\u5feb\u4e5f\u66f4\u7a33\u3002",
      "panel.task": "\u4efb\u52a1",
      "panel.taskTranscribe": "\u8f6c\u5199",
      "panel.taskTranslate": "\u8bd1\u4e3a\u82f1\u6587",
      "panel.taskNote": "\u201c\u8bd1\u4e3a\u82f1\u6587\u201d\u4f1a\u628a\u4efb\u4f55\u8bed\u8a00\u8f6c\u6210\u82f1\u6587\u6587\u672c\u3002",
      "panel.vad": "\u9759\u97f3\u8fc7\u6ee4",
      "panel.vadNote": "\u89e3\u7801\u524d\u53bb\u6389\u9759\u97f3\uff0c\u542c\u5199\u65f6\u5efa\u8bae\u5f00\u542f\u3002",
      "panel.mode": "\u63d2\u5165\u65b9\u5f0f",
      "panel.modeCaret": "\u5149\u6807\u5904",
      "panel.modeReplace": "\u66ff\u6362\u8349\u7a3f",
      "panel.modeCopy": "\u590d\u5236\u5230\u526a\u8d34\u677f",
      "panel.modeNote": "\u201c\u5149\u6807\u5904\u201d\u4f18\u5148\u7528\u8f93\u5165\u6846\u81ea\u8eab\u7684\u7c98\u8d34\u547d\u4ee4\uff0c\u518d\u56de\u9000\u5230\u7f16\u8f91\u5668\u672c\u8eab\uff1b\u8f93\u5165\u6846\u5f99\u5fd9\u65f6\u6539\u4e3a\u590d\u5236\u3002",
      "panel.silence": "\u9759\u97f3\u540e\u505c\u6b62\uff08\u79d2\uff09",
      "panel.silenceNote": "0 \u8868\u793a\u5173\u95ed\uff1b\u5426\u5219\u5b89\u9759\u8fbe\u5230\u8be5\u65f6\u957f\u540e\u81ea\u52a8\u505c\u6b62\u3002",
      "panel.cap": "\u5f55\u97f3\u4e0a\u9650\uff08\u79d2\uff09",
      "panel.capNote": "\u5fd8\u8bb0\u505c\u6b62\u7684\u5f55\u97f3\u4f1a\u5728\u6b64\u5904\u81ea\u52a8\u7ed3\u675f\u3002",
      "panel.transcript": "\u4e0a\u6b21\u8f6c\u5199",
      "panel.transcriptHint": "\u8f6c\u5199\u7ed3\u679c\u4f1a\u51fa\u73b0\u5728\u8fd9\u91cc\u3002",
      "panel.transcriptNote": "\u82e5\u526a\u8d34\u677f\u88ab\u963b\u6b62\uff0c\u53ef\u5728\u6b64\u624b\u52a8\u9009\u4e2d\u590d\u5236\u3002",
      "panel.diagnostics": "\u8bca\u65ad",
      "panel.diagHandles": "\u8f93\u5165\u6846\u63a5\u53e3",
      "panel.diagHandlesYes": "\u5df2\u63a5\u6536",
      "panel.diagHandlesNo": "\u672a\u63a5\u6536 \u2014 \u4f7f\u7528\u7f16\u8f91\u5668\u56de\u9000",
      "panel.diagDevice": "\u8bbe\u5907",
      "panel.diagPeak": "\u5cf0\u503c",
      "panel.diagCaptured": "\u5df2\u6355\u83b7",
      "panel.diagUpload": "\u6700\u8fd1\u8bf7\u6c42",
      "panel.diagInsert": "\u63d2\u5165\u9014\u5f84",
      "panel.diagEngine": "\u5f15\u64ce",
      "panel.diagCache": "\u6743\u91cd",
      "panel.diagNone": "\u2014",
      "panel.copy": "\u590d\u5236",
      "panel.save": "\u4fdd\u5b58",
      "panel.check": "\u68c0\u67e5\u5f15\u64ce",
      "panel.close": "\u5173\u95ed",
      "engine.ready": "\u5c31\u7eea\uff08{model}\uff09",
      "engine.loading": "\u6b63\u5728\u52a0\u8f7d {model}\u2026",
      "engine.starting": "\u6b63\u5728\u542f\u52a8 {model}\u2026",
      "engine.error": "\u5f15\u64ce\u9519\u8bef\uff08{model}\uff09",
      "engine.offline": "\u65e0\u6cd5\u8fde\u63a5\u670d\u52a1 \u2014 \u8bf7\u8fd0\u884c stt/server/start.ps1",
      "status.listening": "\u6b63\u5728\u5f55\u97f3\u2026",
      "status.testing": "\u6b63\u5728\u76d1\u542c\u9ea6\u514b\u98ce\u2026",
      "status.transcribing": "\u6b63\u5728\u8f6c\u5199\u2026",
      "status.inserted": "\u5df2\u63d2\u5165\u5230\u5149\u6807\u5904\u3002",
      "status.domInserted": "\u5df2\u63d2\u5165\u8f93\u5165\u6846\u3002",
      "status.replaced": "\u5df2\u66ff\u6362\u8349\u7a3f\u3002",
      "status.copied": "\u5df2\u590d\u5236\u5230\u526a\u8d34\u677f\u3002",
      "status.copiedManual": "\u526a\u8d34\u677f\u4e0d\u53ef\u7528 \u2014 \u8bf7\u5728\u9762\u677f\u4e2d\u624b\u52a8\u590d\u5236\u8f6c\u5199\u6587\u672c\u3002",
      "note.autoStop": "\u5b89\u9759\u540e\u5df2\u81ea\u52a8\u505c\u6b62\u3002",
      "note.cap": "\u5df2\u8fbe\u5230 {s} \u79d2\u5f55\u97f3\u4e0a\u9650\u3002",
      "note.silent": "\u65e0\u97f3\u9891 \u2014 \u8bf7\u68c0\u67e5\u8f93\u5165\u8bbe\u5907",
      "note.meterUnavailable": "\u6b64\u6d4f\u89c8\u5668\u65e0\u6cd5\u63d0\u4f9b\u97f3\u9891\u7535\u5e73\u8868\uff0c\u4f46\u5f55\u97f3\u4ecd\u53ef\u7528\u3002",
      "error.permission": "\u9ea6\u514b\u98ce\u6743\u9650\u88ab\u62d2\u7edd\u3002\u8bf7\u4e3a\u672c\u9875\u5f00\u653e\u6743\u9650\u540e\u91cd\u8bd5\u3002",
      "error.unsupported": "\u6b64\u6d4f\u89c8\u5668\u65e0\u6cd5\u5f55\u97f3\uff08\u7f3a\u5c11 MediaRecorder \u6216 getUserMedia\uff09\u3002",
      "error.emptyRecording": "\u6ca1\u6709\u5f55\u5230\u5185\u5bb9 \u2014 \u4e0b\u6b21\u8bf7\u591a\u7b49\u4e00\u4f1a\u513f\u3002",
      "error.silentMic": "\u9ea6\u514b\u98ce\u53ea\u4f20\u6765\u9759\u97f3\u3002\u8bf7\u5728\u9762\u677f\u4e2d\u6539\u9009\u8f93\u5165\u8bbe\u5907\uff0c\u6216\u68c0\u67e5\u7cfb\u7edf\u8f93\u5165\u97f3\u91cf\u3002",
      "error.noSpeech": "\u8fd9\u6bb5\u97f3\u9891\u4e2d\u6ca1\u6709\u8bc6\u522b\u5230\u8bed\u97f3\u3002",
      "error.recorder": "\u5f55\u97f3\u5668\u51fa\u9519\u3002\u8bf7\u68c0\u67e5\u9ea6\u514b\u98ce\u540e\u91cd\u8bd5\u3002",
      "error.offline": "\u65e0\u6cd5\u8fde\u63a5\u670d\u52a1\u3002\u8bf7\u7528 stt/server/start.ps1\uff08\u6216 start.sh\uff09\u542f\u52a8\u3002",
    };

    // ── plugin body ──────────────────────────────────────────────────────────
    /** Required services: the slot registry and the locale dictionary registry. */
    const inject = ["slots", "locale"];

    /**
     * Client plugin body: register the locale dictionaries and the composer
     * occupant.
     *
     * `conversation.input.right` is the composer's trailing control row — the
     * seat the model picker, context meter and send button share. `order: 9`
     * keeps the microphone to the left of the other trailing controls.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "stt: dictionaries");
      ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register(
          {
            name: "conversation.input.right",
            id: "stt",
            order: 9,
            locale: NS,
          },
          SttButton,
        ),
      );
    }

    exports.SttButton = SttButton;
    exports.SttPanel = SttPanel;
    exports.apply = apply;
    exports.inject = inject;
    exports.__test = {
      pickMime,
      cleanupText,
      appendToDraft,
      computeLevel,
      meterBars,
      levelToDb,
      findComposerEditor,
      domDraft,
      readDraftFrom,
      insertIntoComposer,
      placeText,
      recordingConstraints,
      clock,
      readBase,
      readLanguage,
      readTask,
      readMode,
      readSilence,
      readCap,
      readDevice,
      DEFAULT_BASE,
      SILENCE_RMS,
      METER_BARS,
    };
    return module.exports;
  },
});
