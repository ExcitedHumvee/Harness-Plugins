/**
 * Browser half of the prompt-history plugin.
 *
 * Gives the message composer a terminal's Up/Down history:
 *
 *   - At the very start of the draft (or in an empty box), ArrowUp recalls the
 *     newest prompt or slash command already sent in this session.
 *   - Once recall is active, ArrowUp and ArrowDown keep stepping through the
 *     history from any caret position, exactly as a shell's line editor does.
 *   - ArrowDown past the newest entry restores the draft that was in the box
 *     when recall started.
 *   - At the oldest entry ArrowUp stays put; before the first entry ArrowDown
 *     is ordinary caret movement.
 *
 * History is derived, not stored: the loaded conversation already holds every
 * final user message and every slash command, the composer's queue holds what
 * the user sent while the agent was busy, and the Session snapshot adds the
 * local echoes for submissions that are not durable yet. Nothing is written to
 * the session log, to a preference, or to browser storage.
 *
 * The entry itself renders nothing. It mounts in `conversation.input.dock`,
 * the smallest session-scope seat that hands a plugin both the composer's
 * action face (`inputActions.setDraft`) and the conversation's loaded nodes
 * (`useChat`), then listens for the two keys on the composer element the shell
 * marks with `data-composer-input`.
 *
 * @module dsh-prompt-history/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-history',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;

    /** The shell's Lexical binding marks the composer root with this attribute. */
    const COMPOSER_SELECTOR = '[data-composer-input]';
    /** An open slash/mention popup; while it is up, the arrow keys belong to it. */
    const TRIGGER_MENU_SELECTOR = '[data-trigger-menu]';
    /** Longest history this session editor will walk. */
    const MAX_ENTRIES = 200;
    /** Stable empty list for the selector, so an absent Chat target costs no renders. */
    const EMPTY_NODES = Object.freeze([]);

    // ── history derivation ──────────────────────────────────────────────────
    /**
     * Join the text blocks of one user or steering message.
     *
     * @param content - the message's content blocks.
     * @returns the typed text, or null when the message carries no text.
     */
    function textOfContent(content) {
      if (!Array.isArray(content)) return null;
      let text = '';
      let seen = false;
      for (const block of content) {
        if (block === null || typeof block !== 'object' || block.type !== 'text') continue;
        if (typeof block.text !== 'string') continue;
        if (seen) text += '\n';
        text += block.text;
        seen = true;
      }
      return seen ? text : null;
    }

    /**
     * Rebuild the line a slash command was submitted with.
     *
     * `command/run` records the parser's raw input after the command name,
     * including the separator whitespace, so name plus args is the typed line.
     *
     * @param node - a conversation `command` node.
     * @returns the command line, or null when the name fell outside the window.
     */
    function commandLine(node) {
      if (typeof node.name !== 'string' || node.name === '') return null;
      return '/' + node.name + (typeof node.args === 'string' ? node.args : '');
    }

    /**
     * Build the history list, oldest first.
     *
     * Only what the user typed is history: final user messages, steering
     * messages, slash commands, the composer's queued messages, and local
     * submissions not durable yet. Assistant answers, tool rows, injected
     * context, and command results are not.
     *
     * Consecutive duplicates collapse, so a pending echo and the durable message
     * it becomes are one entry, and re-sending the same line twice does not need
     * two identical Up presses to pass through it.
     *
     * @param nodes - the loaded conversation nodes, in timeline order.
     * @param queued - user messages waiting in the composer's queue.
     * @param pending - local prompt submissions not observed as durable yet.
     * @returns the history entries, oldest first.
     */
    function buildEntries(nodes, queued, pending) {
      const entries = [];
      let last = null;
      const push = (text) => {
        if (typeof text !== 'string') return;
        const trimmed = text.replace(/\s+$/, '');
        if (trimmed.trim() === '' || trimmed === last) return;
        last = trimmed;
        entries.push(trimmed);
      };
      if (Array.isArray(nodes)) {
        for (const node of nodes) {
          if (node === null || typeof node !== 'object') continue;
          if (node.kind === 'user' || node.kind === 'steering') push(textOfContent(node.content));
          else if (node.kind === 'command') push(commandLine(node));
        }
      }
      if (Array.isArray(queued)) {
        for (const message of queued) {
          if (message === null || typeof message !== 'object') continue;
          push(textOfContent(message.content));
        }
      }
      if (Array.isArray(pending)) {
        for (const submission of pending) {
          if (submission === null || typeof submission !== 'object') continue;
          push(submission.text);
        }
      }
      return entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
    }

    /**
     * Advance one step through the history, as a shell's line editor would.
     *
     * `nav` is null while the box holds the user's own draft, and an index into
     * the entries once a recall is active. `saved` is the draft captured when
     * the recall started, restored when Down passes the newest entry.
     *
     * @param nav - current navigation state, or null.
     * @param entries - history entries, oldest first.
     * @param draft - the text currently in the box.
     * @param direction - `up` or `down`.
     * @param atStart - whether the caret sits at the start of the document.
     * @returns the next navigation state and the text to write, or null when the
     *   key belongs to the editor instead; a null text consumes the key without
     *   changing the box (the oldest-entry stop).
     */
    function historyStep(nav, entries, draft, direction, atStart) {
      if (direction === 'down') {
        if (nav === null) return null;
        if (nav.index < entries.length - 1) {
          const index = nav.index + 1;
          return { nav: { index, saved: nav.saved }, text: entries[index] };
        }
        return { nav: null, text: nav.saved };
      }
      if (entries.length === 0) return null;
      if (nav === null) {
        if (draft !== '' && !atStart) return null;
        const index = entries.length - 1;
        return { nav: { index, saved: draft }, text: entries[index] };
      }
      const index = Math.min(nav.index - 1, entries.length - 1);
      if (index < 0) return { nav: { index: 0, saved: nav.saved }, text: null };
      return { nav: { index, saved: nav.saved }, text: entries[index] };
    }

    // ── composer geometry ───────────────────────────────────────────────────
    /**
     * Whether the caret sits at the very start of the composer document.
     *
     * "Extreme left" is decided from the DOM range, not from the draft text:
     * the caret may sit at the start of a multi-line draft, and an empty box
     * trivially qualifies. A non-collapsed selection is left to the editor.
     *
     * @param root - the composer contenteditable element.
     * @returns whether no character precedes the caret.
     */
    function caretAtStart(root) {
      const selection = typeof window === 'undefined' ? null : window.getSelection();
      if (selection === null || selection === undefined || selection.rangeCount === 0) return false;
      const range = selection.getRangeAt(0);
      if (!range.collapsed || !root.contains(range.startContainer)) return false;
      try {
        const before = root.ownerDocument.createRange();
        before.setStart(root, 0);
        before.setEnd(range.startContainer, range.startOffset);
        return before.toString().replace(/[\u200b\ufeff]/g, '') === '';
      } catch {
        return false;
      }
    }

    // ── history plumbing ────────────────────────────────────────────────────
    /**
     * Local submissions not durable yet, newest after the conversation nodes.
     *
     * @param props - the dock entry's props.
     * @returns the pending submissions, or an empty list.
     */
    function pendingOf(props) {
      const pending = props?.session?.pendingSubmissions;
      return Array.isArray(pending) ? pending : EMPTY_NODES;
    }

    /**
     * Dock entry: history from the loaded Chat target plus pending echoes.
     *
     * The wrapper keeps the Chat hook out of the render path when a host does
     * not compose it, so the key handler still works from pending echoes alone
     * instead of the whole entry crashing.
     *
     * @param props - dock entry props.
     */
    function PromptHistory(props) {
      if (typeof props?.useChat === 'function') return h(ConnectedHistory, props);
      return h(HistoryKeys, {
        ...props,
        entries: buildEntries(EMPTY_NODES, props?.input?.queue, pendingOf(props)),
      });
    }

    /**
     * Connected variant: subscribes to the loaded conversation's node list.
     *
     * `legacy.nodes` is the finalized conversation projection, in timeline
     * order. Its identity changes exactly when the loaded window changes, so
     * the derived entries are memoized on it.
     *
     * @param props - dock entry props.
     */
    function ConnectedHistory(props) {
      const queued = props?.input?.queue;
      const pending = pendingOf(props);
      const nodes = props.useChat((chat) => {
        const nodes = chat?.legacy?.nodes;
        return Array.isArray(nodes) ? nodes : EMPTY_NODES;
      });
      const entries = react.useMemo(() => buildEntries(nodes, queued, pending), [nodes, queued, pending]);
      return h(HistoryKeys, { ...props, entries });
    }

    /**
     * Invisible dock entry that owns the composer's Up/Down history.
     *
     * The listener is attached once per mounted session and reads the current
     * draft, history, and action face through refs, so it never misses a key
     * because a render was a frame behind.
     *
     * @param props - dock entry props plus the derived entries.
     */
    function HistoryKeys(props) {
      const draft = typeof props?.input?.draft === 'string' ? props.input.draft : '';
      const phase = props?.input?.phase;
      const entries = Array.isArray(props?.entries) ? props.entries : EMPTY_NODES;
      const actions = props?.inputActions;

      /** Active recall: `{ index, saved }`, or null while editing the draft. */
      const navRef = react.useRef(null);
      const draftRef = react.useRef(draft);
      const phaseRef = react.useRef(phase);
      const entriesRef = react.useRef(entries);
      const actionsRef = react.useRef(actions);
      const wasEmptyRef = react.useRef(draft === '');

      react.useEffect(() => {
        draftRef.current = draft;
        phaseRef.current = phase;
        entriesRef.current = entries;
        actionsRef.current = actions;
      });

      // A submitted (or manually cleared) box ends the recall: the saved draft
      // is stale, and the next Up must start again from the newest command.
      react.useEffect(() => {
        const empty = draft === '';
        if (empty && !wasEmptyRef.current) navRef.current = null;
        wasEmptyRef.current = empty;
      }, [draft]);

      react.useEffect(() => {
        if (typeof document === 'undefined') return undefined;

        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;

          const target = event.target;
          if (!(target instanceof Element)) return;
          const root = target.closest(COMPOSER_SELECTOR);
          if (root === null || root.isContentEditable !== true) return;

          // A slash/mention popup is open: its own arbitration owns the arrows.
          if (document.querySelector(TRIGGER_MENU_SELECTOR) !== null) return;

          // The composer is locked while it adjudicates or submits.
          if (phaseRef.current === 'adjudicating' || phaseRef.current === 'submitting') return;

          const current = actionsRef.current;
          if (current === null || current === undefined || typeof current.setDraft !== 'function') return;

          const up = event.key === 'ArrowUp';
          const step = historyStep(
            navRef.current,
            entriesRef.current,
            draftRef.current,
            up ? 'up' : 'down',
            up ? caretAtStart(root) : false,
          );
          if (step === null) return;

          navRef.current = step.nav;
          if (step.text !== null) current.setDraft(step.text);
          event.preventDefault();
          event.stopPropagation();
        };

        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, []);

      return null;
    }

    // ── plugin body ─────────────────────────────────────────────────────────
    const inject = ['slots'];

    /**
     * Client plugin body: the invisible dock entry. The Host half has no work.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'prompt-history',
            order: 30,
          },
          PromptHistory,
        ),
      );
    }

    exports.PromptHistory = PromptHistory;
    // Exported for this repository's Node-side verification; no runtime caller.
    exports.buildEntries = buildEntries;
    exports.historyStep = historyStep;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
