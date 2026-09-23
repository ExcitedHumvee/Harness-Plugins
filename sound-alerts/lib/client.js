/**
 * Browser half of the sound-alerts plugin.
 *
 * Plays a short synthesized cue when one of two things happens, and offers a
 * header control that customizes both:
 *
 * - **Final response completed** — the Session's `running` flag falls from true
 *   to false. The flag is monotonic for a turn, so this edge is the moment the
 *   agent handed the conversation back. A true round trip is required (the flag
 *   must be observed true at least once), which keeps a session that merely
 *   mounts idle, or a history read, from firing a cue.
 * - **Your input is needed** — the current Session gains a pending interaction
 *   (`approval` from ui-approval, `question` / `plan-review` from
 *   ui-user-questions). The alert keys off the interaction's `key`, so a
 *   replacement request alerts again while a re-render of the same request does
 *   not.
 *
 * Both signals are already on the standard Session props, so the plugin watches
 * no transport, subscribes to no event bus, and sends no requests: it is a pure
 * consumer of state the shell already maintains.
 *
 * Sound is synthesized with the Web Audio API, so the plugin ships no audio
 * assets, works offline, and can fade cleanly. Every cue honors the browser's
 * autoplay rule — the AudioContext is created at the first cue and resumed on
 * demand, and Browsers release it after a gesture — and every failure path is
 * swallowed so a missing audio stack can never break the conversation.
 *
 * @module dsh-sound-alerts/client
 */

window.__ModuleLoader__.load({
  id: "dsh-sound-alerts",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { Tooltip } = require("@deepseek-ai/dsh-client-ui-primitives");

    /** Dictionary namespace owned by this plugin. */
    const NS = "sound-alerts";

    // ── styles ───────────────────────────────────────────────────────────────
    // One scoped stylesheet, keyed by plugin id so a reload cannot duplicate it.
    const css = `
.dsh-sound-alerts{position:relative;display:inline-flex;align-items:center;flex:none}
.dsh-sound-alerts__trigger{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary)}
.dsh-sound-alerts__trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-sound-alerts__trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.dsh-sound-alerts--off .dsh-sound-alerts__trigger{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}
.dsh-sound-alerts--cue .dsh-sound-alerts__trigger{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.dsh-sound-alerts__panel{position:absolute;top:calc(100% + 8px);right:0;z-index:60;box-sizing:border-box;width:286px;padding:12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;text-align:left}
.dsh-sound-alerts__title{color:var(--dsw-alias-label-primary);font-weight:500;margin-bottom:8px}
.dsh-sound-alerts__group{padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l3)}
.dsh-sound-alerts__group:first-of-type{border-top:0;padding-top:0}
.dsh-sound-alerts__row{display:flex;align-items:center;gap:8px;min-height:26px}
.dsh-sound-alerts__label{flex:1;min-width:0;color:var(--dsw-alias-label-primary)}
.dsh-sound-alerts__hint{margin-top:2px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dsh-sound-alerts select,.dsh-sound-alerts input[type=number]{box-sizing:border-box;height:26px;padding:0 6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2,transparent);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;font-family:inherit;font-size:12px}
.dsh-sound-alerts select{max-width:150px}
.dsh-sound-alerts input[type=number]{width:58px;font-variant-numeric:tabular-nums}
.dsh-sound-alerts input[type=range]{flex:1;min-width:0;accent-color:var(--dsw-alias-state-success-primary,currentColor)}
.dsh-sound-alerts__value{width:38px;text-align:right;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsh-sound-alerts__actions{display:flex;gap:6px;margin-top:10px}
.dsh-sound-alerts__button{box-sizing:border-box;flex:1;height:28px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,transparent);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;font-family:inherit;font-size:12px}
.dsh-sound-alerts__button:hover{border-color:var(--dsw-alias-border-l1)}
.dsh-sound-alerts__button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.dsh-sound-alerts__footer{margin-top:8px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
`;
    const tagId = "dsh-sound-alerts/sound-alerts.css";
    if (
      typeof document !== "undefined" &&
      document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-sound-alerts";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ── settings ─────────────────────────────────────────────────────────────
    /**
     * Where the preferences live. Browser-local by design: the host registers no
     * settings namespace for this plugin, so there is nothing to sync, and a
     * preference about *this browser's* speakers belongs to this browser.
     */
    const STORAGE_KEY = "dsh-sound-alerts.settings.v1";

    /** The two cues this plugin can play. */
    const CUES = ["turnComplete", "needsInput"];

    /** The roster offered for each cue. `silent` is a first-class choice. */
    const SOUNDS = ["silent", "chime", "ping", "drop", "blip", "double", "pulse"];

    /** Hard bounds for the numeric settings, applied on load and on input. */
    const LIMITS = {
      volume: { min: 0, max: 1 },
      repeat: { min: 1, max: 5 },
      gapMs: { min: 0, max: 1500 },
      minTurnMs: { min: 0, max: 60000 },
    };

    /**
     * Settings shape and defaults. Enabling by default is deliberate: a
     * notification feature nobody notices is a feature nobody has.
     */
    const DEFAULTS = {
      enabled: true,
      volume: 0.5,
      minTurnMs: 1000,
      turnComplete: { sound: "chime", repeat: 1, gapMs: 250 },
      needsInput: { sound: "ping", repeat: 2, gapMs: 180 },
    };

    /**
     * Clamp one numeric setting into its declared range.
     * @param key - a LIMITS key.
     * @param value - candidate value.
     * @returns the clamped number, or the default when the value is not finite.
     */
    function clampNumber(key, value) {
      const limit = LIMITS[key];
      if (typeof value !== "number" || Number.isFinite(value) !== true) {
        return DEFAULTS[key];
      }
      return Math.min(limit.max, Math.max(limit.min, value));
    }

    /**
     * Narrow one cue's settings against the roster and bounds.
     * @param cue - the cue name.
     * @param value - candidate settings.
     * @returns a complete, in-range cue setting.
     */
    function normalizeCue(cue, value) {
      const fallback = DEFAULTS[cue];
      const raw = value !== null && typeof value === "object" ? value : {};
      return {
        sound: SOUNDS.includes(raw.sound) ? raw.sound : fallback.sound,
        repeat: Math.round(clampNumber("repeat", raw.repeat ?? fallback.repeat)),
        gapMs: Math.round(clampNumber("gapMs", raw.gapMs ?? fallback.gapMs)),
      };
    }

    /**
     * Narrow a whole persisted document. Every field is optional and every
     * unknown value falls back, so a stale or hand-edited payload can never
     * produce an unusable configuration.
     * @param raw - parsed storage payload.
     * @returns a complete settings object.
     */
    function normalizeSettings(raw) {
      const source = raw !== null && typeof raw === "object" ? raw : {};
      return {
        enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULTS.enabled,
        volume: clampNumber("volume", source.volume ?? DEFAULTS.volume),
        minTurnMs: Math.round(clampNumber("minTurnMs", source.minTurnMs ?? DEFAULTS.minTurnMs)),
        turnComplete: normalizeCue("turnComplete", source.turnComplete),
        needsInput: normalizeCue("needsInput", source.needsInput),
      };
    }

    /** Read the persisted settings, falling back to defaults on any failure. */
    function loadSettings() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw === null ? normalizeSettings(undefined) : normalizeSettings(JSON.parse(raw));
      } catch {
        return normalizeSettings(undefined);
      }
    }

    /** Persist settings; storage being unavailable is not an error worth surfacing. */
    function saveSettings(settings) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch {
        /* private mode or a full quota: the settings still apply in memory */
      }
    }

    // ── the sound engine ─────────────────────────────────────────────────────
    /**
     * Recipes for the offered sounds. A recipe is a list of notes; every note
     * carries its own offset from the cue's start, so a cue can be a rising or
     * falling interval rather than one repeated blip. Frequencies are chosen in
     * the 600–1400 Hz band where a short tone reads clearly over speech and
     * music without sounding shrill.
     */
    const RECIPES = {
      chime: [
        { at: 0, freq: 1046.5, ms: 150, type: "sine" },
        { at: 90, freq: 783.99, ms: 260, type: "sine" },
      ],
      ping: [{ at: 0, freq: 1174.66, ms: 190, type: "sine" }],
      drop: [
        { at: 0, freq: 659.25, ms: 130, type: "triangle" },
        { at: 80, freq: 493.88, ms: 300, type: "triangle" },
      ],
      blip: [{ at: 0, freq: 880, ms: 90, type: "square" }],
      double: [
        { at: 0, freq: 987.77, ms: 110, type: "sine" },
        { at: 140, freq: 987.77, ms: 110, type: "sine" },
      ],
      pulse: [
        { at: 0, freq: 440, ms: 110, type: "sine" },
        { at: 115, freq: 587.33, ms: 110, type: "sine" },
        { at: 230, freq: 880, ms: 170, type: "sine" },
      ],
    };

    /** Loudest per-note gain, before the user's volume multiplier. */
    const NOTE_PEAK = 0.22;

    /** The live AudioContext, created lazily on the first cue. */
    let audioContext = null;

    /**
     * The shared AudioContext, constructed on first use.
     *
     * A browser may hand back a context that starts suspended until a user
     * gesture; `play` resumes it opportunistically. `window` presence is
     * required because a non-DOM renderer (the plugin's own test harness) has no
     * audio stack at all.
     * @returns the context, or null when audio is unavailable.
     */
    function audio() {
      if (typeof window === "undefined") return null;
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      if (typeof Ctor !== "function") return null;
      if (audioContext === null) {
        try {
          audioContext = new Ctor();
        } catch {
          return null;
        }
      }
      return audioContext;
    }

    /**
     * Schedule one note.
     * @param ctx - the live AudioContext.
     * @param note - the recipe note.
     * @param startAt - context time the note begins.
     * @param volume - the user's volume multiplier.
     */
    function scheduleNote(ctx, note, startAt, volume) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = note.type;
      oscillator.frequency.setValueAtTime(note.freq, startAt);

      const seconds = note.ms / 1000;
      const peak = NOTE_PEAK * volume;
      // A short attack avoids the click a hard start produces; the decay carries
      // the note, so the cue sounds struck rather than gated.
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), startAt + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + seconds);

      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + seconds + 0.03);
    }

    /**
     * Play one cue: its recipe, repeated as configured.
     *
     * The test button calls this directly, so `enabled` is deliberately NOT
     * consulted here — the panel must be able to preview a cue while alerts are
     * switched off. The alert watchers gate on `enabled` instead.
     *
     * @param settings - current settings.
     * @param cue - which cue to play.
     */
    function play(settings, cue) {
      const spec = settings[cue];
      const recipe = RECIPES[spec.sound];
      if (recipe === undefined || settings.volume <= 0) return;
      const ctx = audio();
      if (ctx === null) return;
      try {
        if (ctx.state === "suspended" && typeof ctx.resume === "function") {
          // Not awaited: a cue fired before the first gesture may be dropped by
          // the browser, and that is the correct outcome rather than a stall.
          void ctx.resume();
        }
        const base = ctx.currentTime + 0.02;
        for (let index = 0; index < spec.repeat; index += 1) {
          const repetitionStart = base + (index * spec.gapMs) / 1000;
          for (const note of recipe) {
            scheduleNote(ctx, note, repetitionStart + note.at / 1000, settings.volume);
          }
        }
      } catch {
        /* a torn-down context or a policy rejection must not break the UI */
      }
    }

    // ── watching the Session ─────────────────────────────────────────────────
    /**
     * Track one Session's running flag and cue the completion edge.
     *
     * The alert fires only on a true → false transition that this hook actually
     * observed, and only when the turn lasted at least `minTurnMs`. The floor
     * exists because a turn that ends almost immediately — a rejected prompt, an
     * empty response — is usually something the user is already looking at, and
     * a cue there is noise rather than information.
     *
     * @param session - the standard `useSession` selector hook.
     * @param sessionId - current Session identity.
     * @param settings - current settings.
     * @returns the timestamp the current running stretch began, or null.
     */
    function useCompletionAlert(session, sessionId, settings) {
      const running = session((snapshot) => snapshot.running);
      const runningSince = react.useRef(null);
      const wasRunning = react.useRef(false);
      // The effect reads settings only at the instant a cue fires. Holding the
      // latest value in a ref keeps the effect's dependency list to the signal
      // itself, so editing the volume in the panel cannot replay a cue.
      const latest = react.useRef(settings);
      latest.current = settings;

      react.useEffect(() => {
        // A different Session is a different conversation: reset both the edge
        // memory and the clock so navigation cannot look like a completion.
        runningSince.current = null;
        wasRunning.current = false;
      }, [sessionId]);

      react.useEffect(() => {
        if (running === true) {
          if (runningSince.current === null) runningSince.current = Date.now();
          wasRunning.current = true;
          return;
        }
        const observed = wasRunning.current;
        const startedAt = runningSince.current;
        wasRunning.current = false;
        runningSince.current = null;
        if (!observed || startedAt === null) return;
        if (Date.now() - startedAt < latest.current.minTurnMs) return;
        play(latest.current, "turnComplete");
      }, [running, sessionId]);

      return runningSince;
    }

    /**
     * Cue the moment the agent starts waiting on the user.
     *
     * The pending-interaction snapshot is keyed by Session; the alert fires when
     * the current Session's interaction key changes, so one request alerts once
     * however many times React re-renders the shell.
     *
     * @param pending - the standard `useSessionPendingInteraction` hook.
     * @param sessionId - current Session identity.
     * @param settings - current settings.
     */
    function useInputAlert(pending, sessionId, settings) {
      const interaction = pending((snapshot) => snapshot.get(sessionId));
      const key = interaction === undefined ? null : interaction.key;
      const latest = react.useRef(settings);
      latest.current = settings;

      react.useEffect(() => {
        if (key === null) return;
        play(latest.current, "needsInput");
      }, [key, sessionId]);

      return key;
    }

    // ── glyphs ───────────────────────────────────────────────────────────────
    /**
     * Speaker glyph, with the wave omitted when alerts are off.
     * @param props - whether sound is on and whether a cue is playing.
     * @returns the glyph element.
     */
    function SpeakerGlyph({ on, cue }) {
      return jsxs("svg", {
        width: 16,
        height: 16,
        viewBox: "0 0 16 16",
        "aria-hidden": true,
        fill: "none",
        children: [
          jsx("path", {
            d: "M3 6.1h2.2L8.3 3.4v9.2L5.2 9.9H3z",
            fill: "currentColor",
            opacity: cue ? 1 : 0.9,
          }),
          on &&
            jsx("path", {
              d: "M10.2 5.6a3.6 3.6 0 0 1 0 4.8",
              stroke: "currentColor",
              strokeWidth: 1.3,
              strokeLinecap: "round",
            }),
          on &&
            jsx("path", {
              d: "M12.1 3.7a6.2 6.2 0 0 1 0 8.6",
              stroke: "currentColor",
              strokeWidth: 1.3,
              strokeLinecap: "round",
              opacity: 0.55,
            }),
          !on &&
            jsx("path", {
              d: "M10.4 6.2l3.2 3.6M13.6 6.2l-3.2 3.6",
              stroke: "currentColor",
              strokeWidth: 1.3,
              strokeLinecap: "round",
            }),
        ],
      });
    }

    // ── copy ─────────────────────────────────────────────────────────────────
    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      "control.aria": "提示音设置",
      "control.on": "提示音已开启",
      "control.off": "提示音已关闭",
      "panel.title": "提示音",
      "panel.master": "启用提示音",
      "panel.volume": "音量",
      "panel.minTurn": "最短回合时长",
      "panel.minTurnHint": "回合短于此时长不播放提示音（毫秒）。",
      "panel.complete": "最终回复完成时",
      "panel.input": "需要你操作时",
      "panel.sound": "音效",
      "panel.repeat": "重复",
      "panel.gap": "间隔（毫秒）",
      "panel.test": "试听",
      "panel.reset": "恢复默认",
      "panel.footer": "设置仅保存在此浏览器中，刷新或重启后仍然有效。",
      "sound.silent": "静音",
      "sound.chime": "铃声",
      "sound.ping": "提示音",
      "sound.drop": "下降音",
      "sound.blip": "短促音",
      "sound.double": "双击音",
      "sound.pulse": "三连音",
    };
    /** English dictionary, checked complete against the zh key set. */
    const en = {
      "control.aria": "Alert sound settings",
      "control.on": "Alert sounds are on",
      "control.off": "Alert sounds are off",
      "panel.title": "Alert sounds",
      "panel.master": "Enable alert sounds",
      "panel.volume": "Volume",
      "panel.minTurn": "Minimum turn length",
      "panel.minTurnHint": "Turns shorter than this stay silent, in milliseconds.",
      "panel.complete": "When a final response completes",
      "panel.input": "When your input is needed",
      "panel.sound": "Sound",
      "panel.repeat": "Repeat",
      "panel.gap": "Gap (ms)",
      "panel.test": "Test",
      "panel.reset": "Reset",
      "panel.footer": "Preferences are stored in this browser only and survive a reload.",
      "sound.silent": "Silent",
      "sound.chime": "Chime",
      "sound.ping": "Ping",
      "sound.drop": "Drop",
      "sound.blip": "Blip",
      "sound.double": "Double",
      "sound.pulse": "Triple",
    };

    // ── the control ──────────────────────────────────────────────────────────
    /**
     * One cue's controls: sound choice, repeat count, repetition gap, and a test
     * button that plays exactly what the cue will play.
     *
     * @param props - cue name, its settings, the patch callback, and the translate seat.
     * @returns the group element.
     */
    function CueGroup({ cue, value, onChange, onTest, t }) {
      const label = cue === "turnComplete" ? t("panel.complete") : t("panel.input");
      return jsxs("div", {
        className: "dsh-sound-alerts__group",
        children: [
          jsx("div", { className: "dsh-sound-alerts__label", children: label }),
          jsxs("div", {
            className: "dsh-sound-alerts__row",
            children: [
              jsx("span", { className: "dsh-sound-alerts__label", children: t("panel.sound") }),
              jsx("select", {
                value: value.sound,
                "aria-label": `${label} — ${t("panel.sound")}`,
                onChange: (event) => {
                  onChange({ sound: event.target.value });
                },
                children: SOUNDS.map((sound) =>
                  jsx("option", { value: sound, children: t(`sound.${sound}`) }, sound),
                ),
              }),
            ],
          }),
          jsxs("div", {
            className: "dsh-sound-alerts__row",
            children: [
              jsx("span", { className: "dsh-sound-alerts__label", children: t("panel.repeat") }),
              jsx("input", {
                type: "number",
                min: LIMITS.repeat.min,
                max: LIMITS.repeat.max,
                value: value.repeat,
                "aria-label": `${label} — ${t("panel.repeat")}`,
                onChange: (event) => {
                  onChange({ repeat: Number(event.target.value) });
                },
              }),
              jsx("span", { className: "dsh-sound-alerts__label", children: t("panel.gap") }),
              jsx("input", {
                type: "number",
                min: LIMITS.gapMs.min,
                max: LIMITS.gapMs.max,
                step: 10,
                value: value.gapMs,
                "aria-label": `${label} — ${t("panel.gap")}`,
                onChange: (event) => {
                  onChange({ gapMs: Number(event.target.value) });
                },
              }),
            ],
          }),
          jsxs("div", {
            className: "dsh-sound-alerts__actions",
            children: [
              jsx("button", {
                type: "button",
                className: "dsh-sound-alerts__button",
                onClick: onTest,
                children: t("panel.test"),
              }),
            ],
          }),
        ],
      });
    }

    /**
     * The expanded panel: master switch, volume, the completion-quiet floor, and
     * one control group per cue.
     * @param props - settings, the update callback, a test callback, and the translate seat.
     * @returns the panel element.
     */
    function SoundPanel({ settings, onPatch, onTest, onReset, t }) {
      return jsxs("div", {
        className: "dsh-sound-alerts__panel",
        role: "dialog",
        "aria-label": t("panel.title"),
        children: [
          jsx("div", { className: "dsh-sound-alerts__title", children: t("panel.title") }),
          jsxs("div", {
            className: "dsh-sound-alerts__row",
            children: [
              jsx("label", {
                className: "dsh-sound-alerts__label",
                htmlFor: "dsh-sound-alerts-enabled",
                children: t("panel.master"),
              }),
              jsx("input", {
                id: "dsh-sound-alerts-enabled",
                type: "checkbox",
                checked: settings.enabled,
                onChange: (event) => {
                  onPatch({ enabled: event.target.checked });
                },
              }),
            ],
          }),
          jsxs("div", {
            className: "dsh-sound-alerts__row",
            children: [
              jsx("span", { className: "dsh-sound-alerts__label", children: t("panel.volume") }),
              jsx("input", {
                type: "range",
                min: 0,
                max: 100,
                step: 5,
                value: Math.round(settings.volume * 100),
                "aria-label": t("panel.volume"),
                onChange: (event) => {
                  onPatch({ volume: Number(event.target.value) / 100 });
                },
              }),
              jsx("span", {
                className: "dsh-sound-alerts__value",
                children: `${String(Math.round(settings.volume * 100))}%`,
              }),
            ],
          }),
          jsxs("div", {
            className: "dsh-sound-alerts__row",
            children: [
              jsx("label", {
                className: "dsh-sound-alerts__label",
                htmlFor: "dsh-sound-alerts-min-turn",
                children: t("panel.minTurn"),
              }),
              jsx("input", {
                id: "dsh-sound-alerts-min-turn",
                type: "number",
                min: LIMITS.minTurnMs.min,
                max: LIMITS.minTurnMs.max,
                step: 250,
                value: settings.minTurnMs,
                onChange: (event) => {
                  onPatch({ minTurnMs: Number(event.target.value) });
                },
              }),
            ],
          }),
          jsx("div", { className: "dsh-sound-alerts__hint", children: t("panel.minTurnHint") }),
          jsx(CueGroup, {
            cue: "turnComplete",
            value: settings.turnComplete,
            t,
            onTest: () => {
              onTest("turnComplete");
            },
            onChange: (patch) => {
              onPatch({ turnComplete: { ...settings.turnComplete, ...patch } });
            },
          }),
          jsx(CueGroup, {
            cue: "needsInput",
            value: settings.needsInput,
            t,
            onTest: () => {
              onTest("needsInput");
            },
            onChange: (patch) => {
              onPatch({ needsInput: { ...settings.needsInput, ...patch } });
            },
          }),
          jsxs("div", {
            className: "dsh-sound-alerts__actions",
            children: [
              jsx("button", {
                type: "button",
                className: "dsh-sound-alerts__button",
                onClick: onReset,
                children: t("panel.reset"),
              }),
            ],
          }),
          jsx("div", { className: "dsh-sound-alerts__footer", children: t("panel.footer") }),
        ],
      });
    }

    /**
     * The header occupant: a speaker button that shows whether alerts are armed
     * and opens the customization panel, plus both alert watchers.
     *
     * @param props - standard Session props, the global pending-interaction hook,
     *   and the framework translate seat.
     * @returns the control element.
     */
    function SoundAlerts({ sessionId, useSession, useSessionPendingInteraction, t }) {
      const [settings, setSettings] = react.useState(loadSettings);
      const [open, setOpen] = react.useState(false);
      const [cueing, setCueing] = react.useState(false);
      const rootRef = react.useRef(null);
      const cueTimer = react.useRef(null);

      // Merge a patch, clamp it, and persist. State and storage always move
      // together, so a reload cannot disagree with what is on screen.
      const patch = react.useCallback((delta) => {
        setSettings((current) => {
          const next = normalizeSettings({ ...current, ...delta });
          saveSettings(next);
          return next;
        });
      }, []);

      const flash = react.useCallback(() => {
        setCueing(true);
        if (cueTimer.current !== null) window.clearTimeout(cueTimer.current);
        cueTimer.current = window.setTimeout(() => {
          setCueing(false);
        }, 500);
      }, []);

      react.useEffect(
        () => () => {
          if (cueTimer.current !== null) window.clearTimeout(cueTimer.current);
        },
        [],
      );

      const live = settings.enabled !== false && settings.volume > 0;
      // When muted, hand the watchers a silenced copy rather than skipping the
      // hooks: hooks must run unconditionally, and a zero volume is the same
      // thing to `play` while keeping the call sites identical.
      const audible = live ? settings : { ...settings, volume: 0 };
      useCompletionAlert(useSession, sessionId, audible);
      useInputAlert(useSessionPendingInteraction, sessionId, audible);

      react.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
          document.removeEventListener("pointerdown", onPointerDown);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [open]);

      // Close the panel when the Session goes away: the panel edits a Session
      // control, and a Session-less header has nowhere to anchor it.
      react.useEffect(() => {
        if (sessionId === undefined && open) setOpen(false);
      }, [open, sessionId]);

      if (sessionId === undefined) return null;

      const status = live ? t("control.on") : t("control.off");
      return jsxs("span", {
        ref: rootRef,
        className:
          "dsh-sound-alerts" +
          (live ? "" : " dsh-sound-alerts--off") +
          (cueing ? " dsh-sound-alerts--cue" : ""),
        "data-sound-alerts": live ? "on" : "off",
        children: [
          jsx(Tooltip, {
            label: status,
            side: "bottom",
            delayMs: 300,
            disabled: open,
            children: jsx("button", {
              type: "button",
              className: "dsh-sound-alerts__trigger",
              "aria-label": status,
              "aria-haspopup": "dialog",
              "aria-expanded": open,
              onClick: () => {
                setOpen((value) => !value);
              },
              children: jsx(SpeakerGlyph, { on: live, cue: cueing }),
            }),
          }),
          open &&
            jsx(SoundPanel, {
              settings,
              t,
              onPatch: patch,
              onReset: () => {
                const next = normalizeSettings(undefined);
                saveSettings(next);
                setSettings(next);
              },
              onTest: (cue) => {
                play(settings, cue);
                flash();
              },
            }),
        ],
      });
    }

    // ── plugin body ──────────────────────────────────────────────────────────
    /** Required services: the slot registry and the locale dictionary registry. */
    const inject = ["slots", "locale"];

    /**
     * Client plugin body: register this plugin's copy and the header-utilities
     * occupant.
     *
     * `order: 4` places the control immediately beside the context gauge, which
     * registers at `order: 5`.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "sound-alerts: dictionaries");
      ctx.slots.inject("conversation.session.header.utilities", () =>
        ctx.slots.register(
          {
            name: "conversation.session.header.utilities",
            id: "sound-alerts",
            order: 4,
            locale: NS,
          },
          SoundAlerts,
        ),
      );
    }

    exports.SoundAlerts = SoundAlerts;
    exports.SoundPanel = SoundPanel;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
