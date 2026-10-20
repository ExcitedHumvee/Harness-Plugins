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
      'collapse': 'Collapse',
      'expand': 'Expand',
      'close': 'Hide',
      'showLast': 'Show last command',
      'copy': 'Copy',
      'copied': 'Copied',
      'exitCode': 'exit {code}',
      'idleHint': 'Commands appear here while the agent runs them.',
      'keepWhenIdle': 'Keep when idle',
      'dropWhenIdle': 'Hide when idle',
      'elapsed': 'Elapsed',
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
      'collapse': '折叠',
      'expand': '展开',
      'close': '隐藏',
      'showLast': '显示上一条命令',
      'copy': '复制',
      'copied': '已复制',
      'exitCode': '退出码 {code}',
      'idleHint': '智能体运行命令时会显示在这里。',
      'keepWhenIdle': '空闲时保留',
      'dropWhenIdle': '空闲时隐藏',
      'elapsed': '已运行',
    };

    // ── persisted preferences ───────────────────────────────────────────────
    const PREF_KEY = 'dsh-live-terminal:prefs';

    /** @returns {{collapsed: boolean, hiddenWhenIdle: boolean, dismissed: boolean}} */
    function loadPrefs() {
      const fallback = { collapsed: false, hiddenWhenIdle: false, dismissed: false };
      try {
        const raw = window.localStorage.getItem(PREF_KEY);
        if (raw === null) return fallback;
        const parsed = JSON.parse(raw);
        return {
          collapsed: parsed.collapsed === true,
          hiddenWhenIdle: parsed.hiddenWhenIdle === true,
          dismissed: parsed.dismissed === true,
        };
      } catch {
        return fallback;
      }
    }

    function savePrefs(prefs) {
      try {
        window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
      } catch {
        // A blocked storage area only costs persistence, never the window.
      }
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
.dsh-lt{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width, 920px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px));margin:0 auto 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;overflow:hidden}
.dsh-lt__bar{display:flex;align-items:center;gap:8px;min-height:32px;padding:5px 6px 5px 10px}
.dsh-lt__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dsh-lt__dot[data-status=running]{background:var(--dsw-alias-brand-primary);animation:dsh-lt-pulse 1.2s ease-in-out infinite}
.dsh-lt__dot[data-status=finished]{background:var(--dsw-alias-state-success-primary)}
.dsh-lt__dot[data-status=failed]{background:var(--dsw-alias-state-error-primary)}
.dsh-lt__dot[data-status=cancelled]{background:var(--dsw-alias-state-warn-primary)}
@keyframes dsh-lt-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.dsh-lt__dot[data-status=running]{animation:none}}
.dsh-lt__cmd{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary)}
.dsh-lt__cmd::before{content:"$ ";color:var(--dsw-alias-label-tertiary)}
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
.dsh-lt__pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;margin:0 auto 8px;padding:4px 10px;align-self:center;cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;font-family:inherit;font-size:11px;line-height:16px}
.dsh-lt__pill:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dsh-lt__pill:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
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

    // ── component ───────────────────────────────────────────────────────────
    /**
     * The docked terminal window.
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
      const [prefs, setPrefs] = react.useState(loadPrefs);
      const [now, setNow] = react.useState(() => Date.now());
      const [copied, setCopied] = react.useState(false);

      const active = snapshot?.active ?? null;
      const latest = active ?? snapshot?.recent?.[0] ?? null;
      const running = active !== null;

      const updatePrefs = react.useCallback((patch) => {
        setPrefs((current) => {
          const next = { ...current, ...patch };
          savePrefs(next);
          return next;
        });
      }, []);

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

      // A fresh session or a fresh command scrolls the output to its tail.
      const bodyRef = react.useRef(null);
      react.useEffect(() => {
        const node = bodyRef.current;
        if (node !== null) node.scrollTop = node.scrollHeight;
      }, [latest?.id, latest?.output]);

      if (latest === null) {
        // Nothing has run in this session yet: keep the seat quiet.
        return null;
      }

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

      if (prefs.dismissed) {
        return h('button', {
          type: 'button',
          className: 'dsh-lt__pill',
          onClick: () => updatePrefs({ dismissed: false, hiddenWhenIdle: false }),
        }, t('showLast'));
      }

      if (!running && prefs.hiddenWhenIdle) return null;

      const statusLabel = status === 'running' ? t('running') : t(status);
      const output = latest.output ?? '';

      const copy = () => {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
        if (clipboard === undefined) return;
        clipboard.writeText(output).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      };

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
            { className: 'dsh-lt__cmd', title: latest.command ?? '', dir: 'ltr' },
            latest.command ?? t('noCommand'),
          ),
          h(
            'span',
            { className: 'dsh-lt__meta' },
            h('span', { className: 'dsh-lt__status' }, statusLabel),
            h(
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
              prefs.hiddenWhenIdle ? t('keepWhenIdle') : t('dropWhenIdle'),
              prefs.hiddenWhenIdle ? '◉' : '○',
              () => updatePrefs({ hiddenWhenIdle: !prefs.hiddenWhenIdle }),
              { 'aria-pressed': prefs.hiddenWhenIdle },
            ),
            iconButton(
              prefs.collapsed ? t('expand') : t('collapse'),
              prefs.collapsed ? '▸' : '▾',
              () => updatePrefs({ collapsed: !prefs.collapsed }),
              { 'aria-expanded': !prefs.collapsed },
            ),
            iconButton(t('close'), '×', () => updatePrefs({ dismissed: true })),
          ),
        ),
        prefs.collapsed
          ? null
          : h(
              'div',
              { className: 'dsh-lt__body', ref: bodyRef },
              output.length > 0
                ? h('pre', { className: 'dsh-lt__out', dir: 'ltr' }, output)
                : h('div', { className: 'dsh-lt__empty' }, running ? t('waitingForFirstOutput') : t('noOutput')),
              code !== null && !running ? h('div', { className: 'dsh-lt__empty' }, t('exitCode', { code })) : null,
            ),
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
    }

    exports.LiveTerminal = LiveTerminal;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
