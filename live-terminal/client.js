/**
 * Browser half of the live-terminal plugin.
 *
 * Renders a terminal window docked above the message composer. It shows the
 * command the agent is running, streams that command's output as the host
 * records it, and counts a stopwatch for how long the command has been running.
 *
 * Data comes from the plugin's own host half through a read-only JSON route:
 * every terminal command registers as a job with a start time and an output
 * ring, and the host half folds those into one snapshot per session. The window
 * polls that snapshot while a command runs, and once more when one settles, so
 * the output and the final exit status appear together.
 *
 * The stopwatch is derived from the host's `startedAt` on every tick rather
 * than accumulated locally, so it stays correct across a throttled background
 * tab, a reload, or a reconnect. The window is collapse/expand and can be
 * hidden when idle; both choices persist in this browser.
 *
 * @module dsh-live-terminal/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-live-terminal',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;

    const NS = 'live-terminal';
    const ROUTE = '/dsh-live-terminal';
    /** Poll cadence while a command runs; the host ring is the live source. */
    const POLL_ACTIVE_MS = 350;
    /** Poll cadence while idle, to notice a command that starts later. */
    const POLL_IDLE_MS = 1200;

    // ── copy ────────────────────────────────────────────────────────────────
    const en = {
      'title': 'Live terminal',
      'running': 'Running',
      'finished': 'Finished',
      'failed': 'Failed',
      'cancelled': 'Cancelled',
      'waiting': 'Starting…',
      'noCommand': 'No command running',
      'waitingForFirstOutput': 'Waiting for output…',
      'noOutput': 'No output',
      'collapse': 'Collapse this window to its title bar',
      'expand': 'Expand this window to show the output',
      'close': 'Hide this window; it comes back when a new command runs',
      'copy': 'Copy the output of this command',
      'copied': 'Output copied to the clipboard',
      'exitCode': 'exit {code}',
      'hideIdle': 'Hide when idle',
      'showIdle': 'Keep window when idle',
      'elapsed': 'Elapsed',
      'lastResult': 'Last result',
      'backgroundTag': 'background',
      'gear': 'Live terminal settings',
      'runningCommand': 'Running…',
      'panel.title': 'Live terminal',
      'panel.show': 'Show the terminal window',
      'panel.showHint': 'Turn this back on to bring the window back after hiding it.',
      'panel.idle': 'Hide when idle',
      'panel.idleHint': 'Keep the window hidden whenever no command is running.',
      'panel.chatCards': 'Terminal cards in the chat',
      'panel.chatCardsHint': 'Show each command as its own card in the conversation.',
      'panel.clock': 'Show the stopwatch',
      'panel.footer': 'Settings are saved in this browser.',
      'outputOnly': 'Output',
      'showOutput': 'Show the command output',
      'hideOutput': 'Hide the command output',
      'panel.output': 'Show output in the window',
      'panel.outputHint': 'The command and stopwatch always show; turn this off to keep only the title bar.',
      'panel.keepResults': 'Keep finished results in the chat',
      'panel.keepResultsHint': 'Switches the chat transcript to its expanded view, so completed tool cards stay open.',
    };
    const zh = {
      'title': '实时终端',
      'running': '运行中',
      'finished': '已完成',
      'failed': '失败',
      'cancelled': '已取消',
      'waiting': '启动中…',
      'noCommand': '没有正在运行的命令',
      'waitingForFirstOutput': '等待输出…',
      'noOutput': '无输出',
      'collapse': '收起窗口，仅保留标题栏',
      'expand': '展开窗口以显示输出',
      'close': '隐藏窗口；有新命令运行时会自动出现',
      'copy': '复制该命令的输出',
      'copied': '输出已复制到剪贴板',
      'exitCode': '退出码 {code}',
      'hideIdle': '空闲时隐藏',
      'showIdle': '空闲时保留窗口',
      'elapsed': '已用时',
      'lastResult': '上一条结果',
      'backgroundTag': '后台',
      'gear': '实时终端设置',
      'runningCommand': '运行中…',
      'panel.title': '实时终端',
      'panel.show': '显示终端窗口',
      'panel.showHint': '隐藏后重新开启即可恢复窗口。',
      'panel.idle': '空闲时隐藏',
      'panel.idleHint': '没有命令运行时隐藏窗口。',
      'panel.chatCards': '对话中的终端卡片',
      'panel.chatCardsHint': '在对话中为每条命令显示独立卡片。',
      'panel.clock': '显示秒表',
      'panel.footer': '设置保存在此浏览器中。',
      'outputOnly': '输出',
      'showOutput': '显示命令输出',
      'hideOutput': '隐藏命令输出',
      'panel.output': '在窗口中显示输出',
      'panel.outputHint': '命令与秒表始终显示；关闭后只保留标题栏。',
      'panel.keepResults': '在对话中保留已完成结果',
      'panel.keepResultsHint': '将对话切换为展开视图，使已完成的工具卡片保持打开。',
    };

    // ── persisted preferences ───────────────────────────────────────────────
    const PREF_KEY = 'dsh-live-terminal:prefs';

    /** Every tunable preference. `hidden` is the one the header gear toggles. */
    const DEFAULT_PREFS = {
      /** The window is shown at all. */
      hidden: false,
      /** Hide the window whenever no command runs. */
      hiddenWhenIdle: false,
      /** Show the output body under the title bar. */
      showOutput: true,
      /** Show the per-run cards in the chat transcript. */
      chatCards: true,
      /** Show the stopwatch. */
      showClock: true,
    };

    /** @returns {typeof DEFAULT_PREFS} stored preferences with defaults applied. */
    function loadPrefs() {
      try {
        const raw = window.localStorage.getItem(PREF_KEY);
        if (raw === null) return { ...DEFAULT_PREFS };
        const parsed = JSON.parse(raw);
        return {
          hidden: parsed.hidden === true,
          hiddenWhenIdle: parsed.hiddenWhenIdle === true,
          // These default on, so only an explicit `false` turns them off.
          showOutput: parsed.showOutput !== false,
          chatCards: parsed.chatCards !== false,
          showClock: parsed.showClock !== false,
        };
      } catch {
        return { ...DEFAULT_PREFS };
      }
    }

    function savePrefs(prefs) {
      try {
        window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
      } catch {
        // A blocked storage area only costs persistence, never the window.
      }
    }

    // The header gear and the docked window are separate slot entries, so they
    // subscribe to one shared store. Without it, hiding the window from the
    // panel would not reach the mounted window instance.
    const listeners = new Set();
    let currentPrefs = null;
    /** The client plugin context, captured in `apply` for service lookups. */
    let pluginCtx = null;

    /** @returns {object} the shared preferences, loaded from storage once. */
    function readPrefs() {
      if (currentPrefs === null) currentPrefs = loadPrefs();
      return currentPrefs;
    }

    /** @param {object} patch - preference changes to merge, persist, and publish. */
    function writePrefs(patch) {
      currentPrefs = { ...readPrefs(), ...patch };
      savePrefs(currentPrefs);
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A listener that throws must not stop the others from updating.
        }
      }
    }

    /** @param {() => void} listener - called after every preference change. */
    function subscribePrefs(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    /** Subscribe a component to the shared preferences. */
    function usePrefs() {
      const [prefs, setPrefs] = react.useState(readPrefs);
      react.useEffect(() => subscribePrefs(() => setPrefs(readPrefs())), []);
      return prefs;
    }

    // ── formatting ──────────────────────────────────────────────────────────
    /**
     * Format an elapsed duration as a stopwatch reading.
     *
     * @param {number} ms - elapsed milliseconds, negative values clamp to zero.
     * @returns {string} `m:ss.d`, or `h:mm:ss.d` past an hour.
     */
    function formatElapsed(ms) {
      const total = Math.max(0, ms);
      const tenths = Math.floor((total % 1000) / 100);
      const seconds = Math.floor(total / 1000) % 60;
      const minutes = Math.floor(total / 60_000) % 60;
      const hours = Math.floor(total / 3_600_000);
      const pad = (value) => String(value).padStart(2, '0');
      return hours > 0
        ? `${hours}:${pad(minutes)}:${pad(seconds)}.${tenths}`
        : `${minutes}:${pad(seconds)}.${tenths}`;
    }

    /** Map a host job status onto the window's status vocabulary. */
    function statusKey(record) {
      if (record === null) return 'idle';
      if (record.status === 'running' || record.status === 'stopping') return 'running';
      if (record.status === 'completed') return 'finished';
      if (record.status === 'killed') return 'cancelled';
      return 'failed';
    }

    /** Extract an exit code from a settled job's detail, when it carries one. */
    function exitCodeOf(record) {
      if (record?.detail === null || record?.detail === undefined) return null;
      const match = /exit code:\s*(-?\d+)/i.exec(String(record.detail));
      return match === null ? null : Number(match[1]);
    }

    // ── styles ──────────────────────────────────────────────────────────────
    // One scoped stylesheet, keyed by plugin id so a reload cannot duplicate it.
    // Every color is a host theme token, so the window follows light and dark.
    const css = `
.dsh-lt{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width, 920px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px));margin:0 auto 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;overflow:visible}
.dsh-lt__bar{display:flex;align-items:center;gap:8px;min-height:32px;padding:5px 6px 5px 10px}
.dsh-lt__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dsh-lt__dot[data-status=running]{background:var(--dsw-alias-brand-primary);animation:dsh-lt-pulse 1.2s ease-in-out infinite}
.dsh-lt__dot[data-status=finished]{background:var(--dsw-alias-state-success-primary)}
.dsh-lt__dot[data-status=failed]{background:var(--dsw-alias-state-error-primary)}
.dsh-lt__dot[data-status=cancelled]{background:var(--dsw-alias-state-warn-primary)}
@keyframes dsh-lt-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.dsh-lt__dot[data-status=running]{animation:none}}
.dsh-lt__cmdWrap{position:relative;flex:1;min-width:0;display:flex;align-items:center}
.dsh-lt__cmd{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary)}
.dsh-lt__cmd::before{content:"$ ";color:var(--dsw-alias-label-tertiary)}
.dsh-lt__cmdTip{position:absolute;left:0;top:calc(100% + 6px);z-index:70;box-sizing:border-box;max-width:min(760px,80vw);width:max-content;padding:6px 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background-color:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;opacity:0;visibility:hidden;pointer-events:none}
.dsh-lt__cmdWrap:hover .dsh-lt__cmdTip,.dsh-lt__cmdWrap:focus-within .dsh-lt__cmdTip{opacity:1;visibility:visible}
.dsh-lt__meta{display:flex;align-items:center;gap:4px;flex:none}
.dsh-lt__status{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);white-space:nowrap}
.dsh-lt__clock{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;font-size:12px;line-height:18px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-lt__clock[data-status=running]{color:var(--dsw-alias-label-primary)}
.dsh-lt__clock[data-status=failed]{color:var(--dsw-alias-label-error)}
.dsh-lt__clock[data-status=finished]{color:var(--dsw-alias-state-success-primary)}
.dsh-lt__btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:22px;min-width:22px;padding:0 6px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:.5px solid transparent;border-radius:6px;font-family:inherit;font-size:11px;line-height:1}
.dsh-lt__btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-lt__btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.dsh-lt__body{max-height:220px;overflow:auto;padding:8px 10px;border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dsh-lt__out{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}
.dsh-lt__empty{margin-top:2px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dsh-lt-gear{position:relative;display:inline-flex;align-items:center;flex:none}
.dsh-lt-gear__trigger{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px}
.dsh-lt-gear__trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-lt-gear__trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.dsh-lt-gear--off .dsh-lt-gear__trigger{color:var(--dsw-alias-label-tertiary)}
.dsh-lt-set{position:absolute;top:calc(100% + 8px);right:0;z-index:60;box-sizing:border-box;width:290px;padding:12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l1);background-color:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;text-align:left}
.dsh-lt-set__title{color:var(--dsw-alias-label-primary);font-weight:500;margin-bottom:8px}
.dsh-lt-set__group{padding:7px 0;border-top:.5px solid var(--dsw-alias-border-l3)}
.dsh-lt-set__group:first-of-type{border-top:0;padding-top:0}
.dsh-lt-set__row{display:flex;align-items:center;gap:8px;min-height:26px}
.dsh-lt-set__label{flex:1;min-width:0;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-lt-set__hint{margin-top:2px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dsh-lt-set__sep{height:0;margin:4px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-lt-set__foot{margin-top:8px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dsh-lt-set input[type=checkbox]{flex:none;width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh-lt-run{box-sizing:border-box;margin:4px 0 4px 4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2));font-size:12px;overflow:visible}
.dsh-lt-run__bar{display:flex;align-items:center;gap:8px;min-height:28px;padding:4px 10px}
.dsh-lt-run__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dsh-lt-run__dot[data-running=true]{background:var(--dsw-alias-brand-primary);animation:dsh-lt-pulse 1.2s ease-in-out infinite}
.dsh-lt-run__cmd{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-lt-run__cmd::before{content:"$ ";color:var(--dsw-alias-label-tertiary)}
.dsh-lt-run__cmdWrap{position:relative;display:flex;align-items:center;flex:1;min-width:0}
.dsh-lt-run__cmdTip{position:absolute;left:0;top:calc(100% + 6px);z-index:70;box-sizing:border-box;max-width:min(720px,70vw);width:max-content;max-height:40vh;overflow:auto;padding:6px 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background-color:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;opacity:0;visibility:hidden;transition:none;pointer-events:none}
.dsh-lt-run__cmdWrap:hover .dsh-lt-run__cmdTip,.dsh-lt-run__cmdWrap:focus-within .dsh-lt-run__cmdTip{opacity:1;visibility:visible}
.dsh-lt-run__clock{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-primary)}
.dsh-lt-run__tag{flex:none;padding:0 5px;border-radius:4px;background:var(--dsw-alias-fill-l2,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-caption);font-size:10px;line-height:15px}
.dsh-lt-run__out{margin:0;padding:8px 10px;border-top:.5px solid var(--dsw-alias-border-l1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);max-height:224px;overflow:auto}
`;
    const tagId = 'dsh-live-terminal/live-terminal.css';
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null
    ) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-live-terminal';
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ── host transcript setting ─────────────────────────────────────────────
    // The conversation folds completed turns into a collapsed group once a turn
    // ends (`transcriptView: 'detailed'`). That is a HOST chat preference, not
    // this plugin's, so the panel reflects it and can switch it instead of
    // overriding another feature's setting behind the user's back.
    const TRANSCRIPT_NAMESPACE = 'ui-chat';
    const TRANSCRIPT_FIELD = 'transcriptView';
    /** The transcript mode that keeps finished tool cards expanded. */
    const TRANSCRIPT_KEEP_RESULTS = 'verbose';

    /**
     * Read and write the host's `ui-chat` transcript preference.
     *
     * The settings domain forbids cross-plugin value imports, so the service is
     * reached through `ctx.get` and every call is guarded: without the service
     * the control renders disabled rather than crashing the panel.
     *
     * @param ctx - the client plugin context.
     * @returns the current mode and an async setter, or nulls when unavailable.
     */
    function useTranscriptSetting(ctx) {
      const form = typeof ctx?.get === 'function' ? ctx.get('configForms') : undefined;
      const read = () => {
        try {
          const snapshot = form?.get(TRANSCRIPT_NAMESPACE)?.getSnapshot?.();
          return snapshot?.value?.[TRANSCRIPT_FIELD] ?? null;
        } catch {
          return null;
        }
      };
      const [mode, setMode] = react.useState(read);

      react.useEffect(() => {
        const configForm = form?.get?.(TRANSCRIPT_NAMESPACE);
        if (configForm === undefined || typeof configForm.subscribe !== 'function') return undefined;
        setMode(read());
        return configForm.subscribe(() => setMode(read()));
      }, [form]);

      const set = react.useMemo(() => {
        const configForm = form?.get?.(TRANSCRIPT_NAMESPACE);
        if (configForm === undefined || typeof configForm.mutate !== 'function') return null;
        return (value) => {
          configForm.mutate([{ op: 'set', path: [TRANSCRIPT_FIELD], value }]).catch(() => {
            // A rejected write leaves the stored preference in place.
          });
        };
      }, [form]);

      return [mode, set];
    }

    // ── settings ────────────────────────────────────────────────────────────
    /** One labelled switch row in the settings panel. */
    function SettingSwitch({ id, label, hint, checked, onChange }) {
      return h(
        'div',
        { className: 'dsh-lt-set__group' },
        h(
          'div',
          { className: 'dsh-lt-set__row' },
          h('label', { className: 'dsh-lt-set__label', htmlFor: id }, label),
          h('input', {
            id,
            type: 'checkbox',
            role: 'switch',
            checked,
            'aria-checked': checked,
            onChange: (event) => onChange(event.target.checked),
          }),
        ),
        hint === undefined ? null : h('div', { className: 'dsh-lt-set__hint' }, hint),
      );
    }

    /**
     * The settings dashboard, anchored under the header gear.
     *
     * It exists so every state the window can get into is escapable from one
     * always-present control: closing the window, hiding it when idle, and
     * collapsing it are all undone here.
     *
     * @param props - preferences, the patch callback, and the translator.
     */
    function LiveTerminalPanel({ prefs, onPatch, t, transcript, onTranscript }) {
      return h(
        'div',
        { className: 'dsh-lt-set', role: 'dialog', 'aria-label': t('panel.title') },
        h('div', { className: 'dsh-lt-set__title' }, t('panel.title')),
        SettingSwitch({
          id: 'dsh-lt-show',
          label: t('panel.show'),
          hint: t('panel.showHint'),
          checked: prefs.hidden !== true,
          onChange: (value) => onPatch({ hidden: !value }),
        }),
        SettingSwitch({
          id: 'dsh-lt-output',
          label: t('panel.output'),
          hint: t('panel.outputHint'),
          checked: prefs.showOutput !== false,
          onChange: (value) => onPatch({ showOutput: value }),
        }),
        SettingSwitch({
          id: 'dsh-lt-clock',
          label: t('panel.clock'),
          checked: prefs.showClock !== false,
          onChange: (value) => onPatch({ showClock: value }),
        }),
        SettingSwitch({
          id: 'dsh-lt-idle',
          label: t('panel.idle'),
          hint: t('panel.idleHint'),
          checked: prefs.hiddenWhenIdle === true,
          onChange: (value) => onPatch({ hiddenWhenIdle: value }),
        }),
        h('div', { className: 'dsh-lt-set__sep', role: 'presentation' }),
        SettingSwitch({
          id: 'dsh-lt-chat',
          label: t('panel.chatCards'),
          hint: t('panel.chatCardsHint'),
          checked: prefs.chatCards !== false,
          onChange: (value) => onPatch({ chatCards: value }),
        }),
        h(
          'div',
          { className: 'dsh-lt-set__group' },
          h(
            'div',
            { className: 'dsh-lt-set__row' },
            h('label', { className: 'dsh-lt-set__label', htmlFor: 'dsh-lt-keep' }, t('panel.keepResults')),
            h('input', {
              id: 'dsh-lt-keep',
              type: 'checkbox',
              role: 'switch',
              checked: transcript === 'verbose',
              disabled: onTranscript === null,
              onChange: (event) => onTranscript?.(event.target.checked ? 'verbose' : 'detailed'),
            }),
          ),
          h('div', { className: 'dsh-lt-set__hint' }, t('panel.keepResultsHint')),
        ),
        h('div', { className: 'dsh-lt-set__foot' }, t('panel.footer')),
      );
    }

    /** The gear glyph, drawn inline so the plugin ships no icon dependency. */
    function GearGlyph({ open }) {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: open ? { transform: 'rotate(30deg)', transition: 'transform .15s ease' } : undefined,
        },
        h('circle', { cx: 12, cy: 12, r: 3.2 }),
        h('path', {
          d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
        }),
      );
    }

    /**
     * The always-present header control: a gear that opens the settings panel.
     *
     * This is the escape hatch the window previously lacked. It sits in the
     * session header utilities, so it is reachable no matter what the window
     * itself is doing.
     *
     * @param props - header slot props.
     */
    function LiveTerminalGear(props) {
      const t = props?.t ?? ((key) => en[key] ?? key);
      const prefs = usePrefs();
      const [transcriptMode, setTranscript] = useTranscriptSetting(pluginCtx);
      const [open, setOpen] = react.useState(false);
      const rootRef = react.useRef(null);

      // Close on an outside press or Escape, the same as the host's popovers.
      react.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      const active = prefs.hidden !== true;
      return h(
        'span',
        { ref: rootRef, className: 'dsh-lt-gear' + (active ? '' : ' dsh-lt-gear--off') },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-lt-gear__trigger',
            'aria-label': t('gear'),
            title: t('gear'),
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          },
          GearGlyph({ open }),
        ),
        open
          ? LiveTerminalPanel({
              prefs,
              onPatch: writePrefs,
              t,
              transcript: transcriptMode,
              onTranscript: setTranscript,
            })
          : null,
      );
    }

    // ── per-run chat card ───────────────────────────────────────────────────
    /**
     * One terminal card per bash call, rendered in the chat transcript.
     *
     * Registered against the `tool.call.toolview` key `bash`, so each run shows
     * its own command and output in place.
     *
     * The owner props are `phase` plus a stage-specific `block`:
     *
     * - `preparing` / `start`: a `RunningToolCall` — no result yet.
     * - `result`: a `ToolResultNode` carrying `content` and `isError`, with the
     *   paired call at `block.call` (null once the call fell out of the window).
     *
     * Arguments are always read through the block's lazy `PartialArguments`
     * reader (`block.args`), never by re-parsing raw text: the same reader works
     * while the arguments are still streaming in.
     *
     * @param props - tool-call slot props.
     */
    function TerminalRunCard(props) {
      const t = props?.t ?? ((key, values) => {
        let text = en[key] ?? key;
        if (values !== undefined) {
          for (const [name, value] of Object.entries(values)) text = text.replace(`{${name}}`, String(value));
        }
        return text;
      });

      const prefs = usePrefs();
      const phase = props?.phase ?? 'result';
      const block = props?.block ?? null;
      const running = phase !== 'result';

      // Readers are total: an absent field answers undefined, never throws.
      const args = block?.args ?? null;
      const command = args === null ? undefined : args.text('command');
      const description = args === null ? undefined : args.text('description');
      const background = args !== null && args.value('run_in_background') === true;

      const [elapsed, setElapsed] = react.useState(0);
      const startedAt = react.useRef(null);

      react.useEffect(() => {
        if (!running) return undefined;
        if (startedAt.current === null) startedAt.current = Date.now();
        const id = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 100);
        return () => window.clearInterval(id);
      }, [running]);

      const text = react.useMemo(() => {
        if (phase !== 'result' || !Array.isArray(block?.content)) return '';
        return block.content
          .map((entry) => (entry && entry.type === 'text' ? entry.text : ''))
          .join('\n');
      }, [phase, block]);

      // Every hook above runs unconditionally; the exits come after them.
      if (prefs.chatCards === false) return null;

      // A settled call keeps its row even when the command text is gone: the
      // paired call falls out of the loaded window on long sessions, leaving
      // `name` and `args` empty while `content` still holds the output. Hiding
      // that row would drop finished results from the transcript.
      const hasOutput = text.length > 0;
      if (command === undefined && description === undefined && !hasOutput && !running) return null;

      const label = command ?? description ?? (hasOutput ? t('outputOnly') : t('runningCommand'));
      const tipId = `dsh-lt-run-tip-${props?.callId ?? 'x'}`;
      const failed = phase === 'result' && block?.isError === true;

      return h(
        'div',
        {
          className: 'dsh-lt-run',
          'data-running': running ? 'true' : 'false',
          'data-error': failed ? 'true' : 'false',
        },
        h(
          'div',
          { className: 'dsh-lt-run__bar' },
          h('span', { className: 'dsh-lt-run__dot', 'data-running': running ? 'true' : 'false' }),
          // The stored command is often longer than the row, so the full text
          // also appears in a popup on hover or keyboard focus.
          h(
            'span',
            { className: 'dsh-lt-run__cmdWrap' },
            h(
              'span',
              {
                className: 'dsh-lt-run__cmd',
                dir: 'ltr',
                tabIndex: 0,
                'aria-describedby': tipId,
              },
              label,
            ),
            h('span', { className: 'dsh-lt-run__cmdTip', id: tipId, role: 'tooltip' }, label),
          ),
          running && prefs.showClock !== false
            ? h('span', { className: 'dsh-lt-run__clock' }, formatElapsed(elapsed))
            : null,
          background ? h('span', { className: 'dsh-lt-run__tag' }, t('backgroundTag')) : null,
        ),
        hasOutput ? h('pre', { className: 'dsh-lt-run__out', dir: 'ltr' }, text.replace(/\n+$/, '')) : null,
      );
    }

    // ── component ───────────────────────────────────────────────────────────
    /**
     * The one terminal window.
     *
     * Design: a single box. Its title bar always shows the current command, its
     * status, and the stopwatch; its body shows that command's live output only
     * while "Show output" is on. There is no second panel and no pinned
     * previous result — finished output lives in the chat cards.
     *
     * @param props - slot props; `sessionId` identifies this conversation.
     */
    function LiveTerminal(props) {
      const sessionId = props?.sessionId;
      const t = props?.t ?? ((key, values) => {
        let text = en[key] ?? key;
        if (values !== undefined) {
          for (const [name, value] of Object.entries(values)) text = text.replace(`{${name}}`, String(value));
        }
        return text;
      });

      const [snapshot, setSnapshot] = react.useState(null);
      const prefs = usePrefs();
      const [now, setNow] = react.useState(() => Date.now());
      const [copied, setCopied] = react.useState(false);

      const active = snapshot?.active ?? null;
      const running = active !== null;
      const recent = snapshot?.recent ?? [];
      const latest = active ?? recent[0] ?? null;

      // Poll the host snapshot: fast while a command runs, slower when idle.
      react.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
        let cancelled = false;
        let timer = undefined;
        const controller = new AbortController();

        const read = async () => {
          try {
            const response = await fetch(
              `${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`,
              { signal: controller.signal, cache: 'no-store' },
            );
            if (response.ok) {
              const next = await response.json();
              if (!cancelled) setSnapshot(next);
              return next?.active != null;
            }
          } catch {
            // A transient transport failure keeps the last good snapshot.
          }
          return false;
        };

        const loop = async () => {
          const live = await read();
          if (cancelled) return;
          timer = window.setTimeout(loop, live ? POLL_ACTIVE_MS : POLL_IDLE_MS);
        };

        void loop();
        return () => {
          cancelled = true;
          controller.abort();
          if (timer !== undefined) window.clearTimeout(timer);
        };
      }, [sessionId]);

      // Tick the stopwatch only while a command runs.
      react.useEffect(() => {
        if (!running) return undefined;
        const id = window.setInterval(() => setNow(Date.now()), 100);
        return () => window.clearInterval(id);
      }, [running, active?.id]);

      // Clear the "Copied" confirmation.
      react.useEffect(() => {
        if (!copied) return undefined;
        const id = window.setTimeout(() => setCopied(false), 1400);
        return () => window.clearTimeout(id);
      }, [copied]);

      // A fresh command scrolls the output to its tail.
      const bodyRef = react.useRef(null);
      react.useEffect(() => {
        const node = bodyRef.current;
        if (node !== null) node.scrollTop = node.scrollHeight;
      }, [latest?.id, latest?.output]);

      // Every hook above runs unconditionally; presentation exits come after.
      if (latest === null) return null;
      if (prefs.hidden === true) return null;
      if (!running && prefs.hiddenWhenIdle) return null;

      // The host stamps `startedAt`/`finishedAt` with its own clock, which may
      // not match this browser's. Fold the snapshot's `serverTime` into an
      // offset so the stopwatch measures real elapsed time across machines.
      const clockOffset = typeof snapshot?.serverTime === 'number' ? snapshot.serverTime - now : 0;
      const toLocal = (value) => (typeof value === 'number' ? value - clockOffset : null);

      const status = statusKey(latest);
      const startMs = toLocal(latest.startedAt);
      const endMs = running ? now : (toLocal(latest.finishedAt) ?? now);
      const elapsed = startMs === null ? 0 : endMs - startMs;
      const code = exitCodeOf(latest);
      const output = latest.output ?? '';
      const command = latest.command ?? t('noCommand');
      const statusLabel = status === 'running' ? t('running') : t(status);
      // One switch decides whether the body renders at all.
      const showOutput = prefs.showOutput !== false;

      const copy = () => {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
        if (clipboard === undefined) return;
        clipboard.writeText(output).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      };

      const commandTipId = `dsh-lt-tip-${latest.id}`;

      const iconButton = (label, glyph, onClick, extra = {}) =>
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-lt__btn',
            title: label,
            'aria-label': label,
            onClick,
            ...extra,
          },
          glyph,
        );

      return h(
        'section',
        { className: 'dsh-lt', 'data-status': status, 'aria-label': t('title') },
        h(
          'div',
          { className: 'dsh-lt__bar' },
          h('span', { className: 'dsh-lt__dot', 'data-status': status, 'aria-hidden': 'true' }),
          h(
            'span',
            { className: 'dsh-lt__cmdWrap' },
            h(
              'span',
              {
                className: 'dsh-lt__cmd',
                dir: 'ltr',
                tabIndex: 0,
                'aria-describedby': commandTipId,
              },
              command,
            ),
            // The full command as a real popup: instant, wrapped, and capped to
            // the viewport, so a long command is readable on hover or focus.
            h('span', { className: 'dsh-lt__cmdTip', id: commandTipId, role: 'tooltip' }, command),
          ),
          h(
            'span',
            { className: 'dsh-lt__meta' },
            h('span', { className: 'dsh-lt__status' }, statusLabel),
            prefs.showClock === false
              ? null
              : h(
                  'span',
                  {
                    className: 'dsh-lt__clock',
                    'data-status': status,
                    role: 'timer',
                    'aria-label': `${t('elapsed')} ${formatElapsed(elapsed)}`,
                  },
                  formatElapsed(elapsed),
                ),
            output.length > 0 ? iconButton(copied ? t('copied') : t('copy'), copied ? '✓' : '⧉', copy) : null,
            iconButton(
              showOutput ? t('hideOutput') : t('showOutput'),
              showOutput ? '▾' : '▸',
              () => writePrefs({ showOutput: !showOutput }),
              { 'aria-expanded': showOutput },
            ),
            iconButton(t('close'), '×', () => writePrefs({ hidden: true })),
          ),
        ),
        showOutput
          ? h(
              'div',
              { className: 'dsh-lt__body', ref: bodyRef },
              output.length > 0
                ? h('pre', { className: 'dsh-lt__out', dir: 'ltr' }, output)
                : h('div', { className: 'dsh-lt__empty' }, running ? t('waitingForFirstOutput') : t('noOutput')),
              code !== null && !running ? h('div', { className: 'dsh-lt__empty' }, t('exitCode', { code })) : null,
            )
          : null,
      );
    }

    // ── plugin body ─────────────────────────────────────────────────────────
    const inject = ['slots', 'locale'];

    /**
     * Client plugin body: dictionary and the docked window registration.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      pluginCtx = ctx;
      ctx.effect(
        () => () => {
          pluginCtx = null;
        },
        'live-terminal: context handle',
      );
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'live-terminal: dictionaries');
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'live-terminal',
            order: 15,
            locale: NS,
          },
          LiveTerminal,
        ),
      );
      // The always-present escape hatch: a gear that opens the settings panel,
      // so a hidden window is always recoverable.
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'live-terminal-settings',
            order: 3,
            locale: NS,
          },
          LiveTerminalGear,
        ),
      );
      // Each run also gets its own card in the chat transcript, keyed by the
      // wire tool name so a keyed hit replaces the generic bash row.
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          {
            name: 'tool.call.toolview',
            key: 'bash',
            locale: NS,
          },
          TerminalRunCard,
        ),
      );
    }

    exports.LiveTerminal = LiveTerminal;
    exports.TerminalRunCard = TerminalRunCard;
    exports.LiveTerminalGear = LiveTerminalGear;
    exports.LiveTerminalPanel = LiveTerminalPanel;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
