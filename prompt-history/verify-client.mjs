/**
 * Behavioural verifier for the prompt-history browser half.
 *
 * `node --check` proves `client.js` parses; it proves nothing about what the
 * keys do. This harness closes that gap without a browser:
 *
 * - It evaluates the real bundle with a stubbed `window.__ModuleLoader__`, so
 *   the shipped file is what runs (no copy, no build step).
 * - It provides a minimal React hook dispatcher (refs, memos, effects with
 *   dependency comparison and cleanup) and a recursive element renderer, so the
 *   bundle's own component tree mounts and its effects run deterministically.
 * - It provides a composer stub whose `closest()` answers the shell's
 *   `[data-composer-input]` marker, plus selection and range stubs that model
 *   "caret at the start" and "caret inside the draft".
 *
 * Why this matters: rendering garbage from a hand-edited JSON file is a
 * cosmetic bug, but stealing ArrowUp from the middle of a draft is a broken
 * editor. The assertions therefore cover the exact recall path — empty box,
 * start of the line, repeated Up/Down, the oldest-entry stop, restoring the
 * saved draft — and every guard that must leave the key to the editor.
 *
 * Usage: node verify-client.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, 'client.js');

let failures = 0;
let currentTest = '';

/**
 * Assert one condition.
 *
 * @param label - what is being asserted.
 * @param condition - the result.
 * @param detail - extra context on failure.
 */
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL [${currentTest}] ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

/** Compare two dependency arrays the way React does. */
function depsChanged(previous, next) {
  if (previous === undefined || next === undefined) return previous !== next;
  if (previous.length !== next.length) return true;
  for (let i = 0; i < previous.length; i += 1) {
    if (!Object.is(previous[i], next[i])) return true;
  }
  return false;
}

// ── the React stand-in ───────────────────────────────────────────────────────
const hookStates = [];
let hookIndex = 0;
let pendingEffects = [];
const liveEffects = new Map();
let effectSeq = 0;
let stateVersion = 0;

const reactStub = {
  useState(initial) {
    const slot = hookIndex;
    if (hookStates[slot] === undefined) {
      hookStates[slot] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
    }
    hookIndex += 1;
    const entry = hookStates[slot];
    return [
      entry.value,
      (next) => {
        const value = typeof next === 'function' ? next(entry.value) : next;
        if (!Object.is(value, entry.value)) {
          entry.value = value;
          stateVersion += 1;
        }
      },
    ];
  },
  useRef(initial) {
    const slot = hookIndex;
    if (hookStates[slot] === undefined) hookStates[slot] = { kind: 'ref', value: { current: initial } };
    hookIndex += 1;
    return hookStates[slot].value;
  },
  useMemo(factory, deps) {
    const slot = hookIndex;
    const entry = hookStates[slot];
    if (entry === undefined || depsChanged(entry.deps, deps)) {
      hookStates[slot] = { kind: 'memo', value: factory(), deps };
    }
    hookIndex += 1;
    return hookStates[slot].value;
  },
  useEffect(fn, deps) {
    const slot = hookIndex;
    hookIndex += 1;
    const existing = liveEffects.get(slot);
    if (existing !== undefined && depsChanged(existing.deps, deps)) {
      existing.cleanup?.();
      liveEffects.delete(slot);
    }
    if (!liveEffects.has(slot)) {
      const token = (effectSeq += 1);
      pendingEffects.push({ slot, token, fn });
      liveEffects.set(slot, { deps, cleanup: undefined, token, ran: false });
    }
  },
};

/** Element stub produced by the bundle's `react.createElement`. */
const h = (type, props) => ({ $$typeof: 'element', type, props: props ?? {} });
reactStub.createElement = h;

// ── the composer, document, and selection stubs ──────────────────────────────
let menuOpen = false;
const keyListeners = new Set();
/** What `caretAtStart` should answer for the next handler call. */
const caret = { collapsed: true, inside: true, atStart: true };

class FakeElement {}

/** Every DOM element answers `closest`; only the composer answers the shell marker. */
FakeElement.prototype.closest = () => null;

const composerNode = { nodeName: '#text' };
const composer = new FakeElement();
composer.isContentEditable = true;
composer.closest = (selector) => (selector === '[data-composer-input]' ? composer : null);
composer.contains = (node) => node === composerNode;
composer.ownerDocument = {
  createRange: () => ({
    setStart() {},
    setEnd() {},
    toString: () => (caret.atStart ? '' : 'draft'),
  }),
};

const selectionStub = {
  rangeCount: 1,
  getRangeAt: () => ({
    collapsed: caret.collapsed,
    startContainer: caret.inside ? composerNode : { outside: true },
    startOffset: 0,
  }),
};

const documentStub = {
  addEventListener(type, fn, capture) {
    if (type === 'keydown' && capture === true) keyListeners.add(fn);
  },
  removeEventListener(type, fn) {
    keyListeners.delete(fn);
  },
  querySelector(selector) {
    return menuOpen && selector === '[data-trigger-menu]' ? {} : null;
  },
};

const windowStub = { getSelection: () => selectionStub };
globalThis.window = windowStub;
globalThis.document = documentStub;
globalThis.Element = FakeElement;

// ── loading the real bundle ─────────────────────────────────────────────────
let registration = null;
windowStub.__ModuleLoader__ = {
  load(value) {
    registration = value;
  },
};

// eslint-disable-next-line no-new-func
new Function('window', readFileSync(CLIENT, 'utf8'))(windowStub);

if (registration === null) {
  console.error('verifier: the bundle did not register with __ModuleLoader__');
  process.exit(1);
}

const bundle = registration.factory((specifier) => {
  if (specifier === 'react') return reactStub;
  throw new Error(`verifier: unexpected require(${specifier})`);
});

console.log(`bundle: ${CLIENT}`);
console.log(`registered id: ${registration.id}`);
console.log('');

// ── the render driver ────────────────────────────────────────────────────────
/**
 * Render one element, invoking component functions until a host element (or
 * null) comes out. Hooks keep a single global index per pass, exactly in the
 * order React would call the nested components.
 *
 * @param element - the element tree produced by `h`.
 * @returns the rendered host tree, or null.
 */
function renderElement(element) {
  if (element === null || element === undefined || typeof element !== 'object') return null;
  if (typeof element.type === 'function') return renderElement(element.type(element.props));
  return element;
}

/**
 * Commit the tree and flush the effects this commit registered.
 *
 * @param props - the props the host slot would pass.
 * @returns the rendered host tree.
 */
function render(props) {
  for (let pass = 0; pass < 10; pass += 1) {
    const before = stateVersion;
    hookIndex = 0;
    pendingEffects = [];
    const tree = renderElement({ type: bundle.PromptHistory, props });
    for (const effect of pendingEffects) {
      const entry = liveEffects.get(effect.slot);
      if (entry !== undefined && entry.token === effect.token && !entry.ran) {
        entry.ran = true;
        entry.cleanup = effect.fn() ?? undefined;
      }
    }
    if (stateVersion === before) return tree;
  }
  return null;
}

/** Unmount the tree, running every live cleanup (mirrors React teardown). */
function unmount() {
  for (const entry of liveEffects.values()) entry.cleanup?.();
  liveEffects.clear();
  hookStates.length = 0;
  hookIndex = 0;
  pendingEffects = [];
}

// ── the harness state ────────────────────────────────────────────────────────
/** The loaded conversation nodes the fake Chat hook returns. */
let chatNodes = [];
/** Draft writes the composer facade would apply. */
let suggested = [];
/** The draft currently in the box. */
const box = { draft: '' };

const useChatStub = (selector) => selector({ legacy: { nodes: chatNodes } });

const actions = {
  setDraft(text) {
    suggested.push(text);
    box.draft = text;
  },
};

/**
 * Mount the dock entry with real-shaped props.
 *
 * @param options - nodes, pending echoes, draft, phase, and overrides.
 * @returns the props the entry was rendered with.
 */
function mount(options = {}) {
  unmount();
  suggested = [];
  chatNodes = options.nodes ?? [];
  box.draft = options.draft ?? '';
  caret.collapsed = true;
  caret.inside = true;
  caret.atStart = true;
  menuOpen = false;
  const props = {
    session: { pendingSubmissions: options.pending ?? [] },
    input: { draft: box.draft, phase: options.phase ?? 'plain', queue: options.queue ?? [] },
    inputActions: options.actions ?? actions,
    useChat: options.useChat ?? useChatStub,
  };
  render(props);
  return props;
}

/** Re-commit the currently mounted tree with a changed draft. */
function commitDraft(props, draft) {
  box.draft = draft;
  render({ ...props, input: { ...props.input, draft } });
}

/**
 * Dispatch one key through the listeners the entry installed.
 *
 * @param key - `ArrowUp` or `ArrowDown`.
 * @param overrides - event fields to override (modifiers, target, phase...).
 * @returns the event, with `defaultPrevented`/`stopped` recorded.
 */
function press(key, overrides = {}) {
  const event = {
    key,
    target: composer,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...overrides,
  };
  for (const listener of [...keyListeners]) listener(event);
  return event;
}

/** The list of draft writes since the last `mount`. */
function writes() {
  return [...suggested];
}

// ── 1. history derivation ────────────────────────────────────────────────────
console.log('1. history derivation');
{
  const nodes = [
    { kind: 'user', seq: 1, content: [{ type: 'text', text: 'first prompt' }] },
    { kind: 'assistant', seq: 2, blocks: [{ kind: 'text', text: 'answer' }] },
    { kind: 'tool-result', seq: 3, name: 'bash', content: [] },
    { kind: 'user', seq: 4, content: [{ type: 'text', text: 'second prompt' }] },
    { kind: 'command', seq: 5, name: 'goal', args: ' ship it' },
    { kind: 'steering', seq: 6, content: [{ type: 'text', text: 'steer here' }] },
  ];
  check(
    'user messages, commands, and steering messages become entries in order',
    JSON.stringify(bundle.buildEntries(nodes, [], [])) ===
      JSON.stringify(['first prompt', 'second prompt', '/goal ship it', 'steer here']),
    JSON.stringify(bundle.buildEntries(nodes, [], [])),
  );

  const dedupe = [
    { kind: 'user', seq: 1, content: [{ type: 'text', text: 'same' }] },
    { kind: 'user', seq: 2, content: [{ type: 'text', text: 'same' }] },
    { kind: 'user', seq: 3, content: [{ type: 'text', text: 'other' }] },
    { kind: 'user', seq: 4, content: [{ type: 'text', text: 'same' }] },
  ];
  check(
    'consecutive duplicates collapse but separated ones stay',
    JSON.stringify(bundle.buildEntries(dedupe, [], [])) === JSON.stringify(['same', 'other', 'same']),
    JSON.stringify(bundle.buildEntries(dedupe, [], [])),
  );

  check(
    'queued messages follow the durable nodes',
    JSON.stringify(
      bundle.buildEntries([{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'sent' }] }], [
        { content: [{ type: 'text', text: 'queued' }] },
      ], []),
    ) === JSON.stringify(['sent', 'queued']),
  );

  check(
    'pending echoes come after queued messages',
    JSON.stringify(
      bundle.buildEntries(
        [{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'sent' }] }],
        [{ content: [{ type: 'text', text: 'queued' }] }],
        [{ text: 'pending' }],
      ),
    ) === JSON.stringify(['sent', 'queued', 'pending']),
  );

  check(
    'pending echoes are appended after the durable nodes',
    JSON.stringify(
      bundle.buildEntries([{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'sent' }] }], [], [
        { text: 'just now' },
      ]),
    ) === JSON.stringify(['sent', 'just now']),
  );

  check(
    'a pending echo duplicating the last durable message collapses',
    JSON.stringify(
      bundle.buildEntries([{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'sent' }] }], [], [
        { text: 'sent' },
      ]),
    ) === JSON.stringify(['sent']),
  );

  check(
    'a queued message duplicating the last durable message collapses',
    JSON.stringify(
      bundle.buildEntries(
        [{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'sent' }] }],
        [{ content: [{ type: 'text', text: 'sent' }] }],
        [],
      ),
    ) === JSON.stringify(['sent']),
  );

  check(
    'trailing whitespace is trimmed and blank entries are dropped',
    JSON.stringify(
      bundle.buildEntries(
        [
          { kind: 'user', seq: 1, content: [{ type: 'text', text: 'line\n\n' }] },
          { kind: 'user', seq: 2, content: [{ type: 'text', text: '   ' }] },
          { kind: 'user', seq: 3, content: [{ type: 'image', attachment: {} }] },
          { kind: 'command', seq: 4, name: 'help', args: '   ' },
          { kind: 'command', seq: 5, name: null, args: 'orphan' },
        ],
        [],
        [],
      ),
    ) === JSON.stringify(['line', '/help']),
    JSON.stringify(
      bundle.buildEntries(
        [
          { kind: 'user', seq: 1, content: [{ type: 'text', text: 'line\n\n' }] },
          { kind: 'user', seq: 2, content: [{ type: 'text', text: '   ' }] },
          { kind: 'user', seq: 3, content: [{ type: 'image', attachment: {} }] },
          { kind: 'command', seq: 4, name: 'help', args: '   ' },
          { kind: 'command', seq: 5, name: null, args: 'orphan' },
        ],
        [],
        [],
      ),
    ),
  );

  const long = Array.from({ length: 205 }, (_, index) => ({
    kind: 'user',
    seq: index,
    content: [{ type: 'text', text: `prompt ${String(index)}` }],
  }));
  const capped = bundle.buildEntries(long, [], []);
  check('the list is capped to the newest 200 entries', capped.length === 200 && capped[199] === 'prompt 204');
  check('malformed input never throws', JSON.stringify(bundle.buildEntries([null, 7, {}], null, null)) === '[]');
}

// ── 2. navigation algebra ────────────────────────────────────────────────────
console.log('');
console.log('2. navigation algebra');
{
  const entries = ['one', 'two', 'three'];

  const first = bundle.historyStep(null, entries, '', 'up', true);
  check(
    'Up from an empty box starts at the newest entry and saves the empty draft',
    first !== null && first.text === 'three' && first.nav.index === 2 && first.nav.saved === '',
    JSON.stringify(first),
  );

  const older = bundle.historyStep(first.nav, entries, 'three', 'up', false);
  check('Up keeps walking back from any caret position', older.text === 'two' && older.nav.index === 1);

  const oldest = bundle.historyStep({ index: 0, saved: '' }, entries, 'one', 'up', false);
  check('Up at the oldest entry is consumed without moving', oldest !== null && oldest.text === null);

  const newer = bundle.historyStep({ index: 0, saved: 'draft' }, entries, 'one', 'down', false);
  check('Down steps toward the newest entry', newer.text === 'two' && newer.nav.index === 1);

  const restored = bundle.historyStep({ index: 2, saved: 'draft' }, entries, 'three', 'down', false);
  check('Down past the newest restores the saved draft and ends recall', restored.nav === null && restored.text === 'draft');

  check('Down with no active recall is ordinary caret movement', bundle.historyStep(null, entries, 'x', 'down', false) === null);
  check(
    'Up inside a non-empty draft is ordinary caret movement',
    bundle.historyStep(null, entries, 'half typed', 'up', false) === null,
  );
  check(
    'Up at the start of a non-empty draft recalls and saves that draft',
    (() => {
      const step = bundle.historyStep(null, entries, 'half typed', 'up', true);
      return step !== null && step.text === 'three' && step.nav.saved === 'half typed';
    })(),
  );
  check('Up with no history is left to the editor', bundle.historyStep(null, [], '', 'up', true) === null);
}

// ── 3. the real component and its key listener ──────────────────────────────
console.log('');
console.log('3. composer key handling');
{
  const nodes = [
    { kind: 'user', seq: 1, content: [{ type: 'text', text: 'one' }] },
    { kind: 'user', seq: 2, content: [{ type: 'text', text: 'two' }] },
    { kind: 'user', seq: 3, content: [{ type: 'text', text: 'three' }] },
  ];
  let props = mount({ nodes, draft: '' });
  check('mount installs exactly one capture listener', keyListeners.size === 1);

  let event = press('ArrowUp');
  check('Up in an empty box recalls the newest prompt', JSON.stringify(writes()) === '["three"]');
  check('the handled key is prevented and stopped', event.defaultPrevented && event.stopped);

  commitDraft(props, box.draft);
  press('ArrowUp');
  press('ArrowUp');
  check('repeated Up walks back through history', JSON.stringify(writes()) === '["three","two","one"]');

  commitDraft(props, box.draft);
  event = press('ArrowUp');
  check('Up at the oldest entry consumes the key without writing', writes().length === 3 && event.defaultPrevented);

  commitDraft(props, box.draft);
  press('ArrowDown');
  press('ArrowDown');
  press('ArrowDown');
  check(
    'Down walks forward and finally restores the saved empty draft',
    JSON.stringify(writes().slice(3)) === '["two","three",""]',
  );

  commitDraft(props, '');
  event = press('ArrowDown');
  check('Down after recall ends is left to the editor', writes().length === 6 && !event.defaultPrevented);

  props = mount({ nodes, draft: 'half typed' });
  event = press('ArrowUp');
  check('Up at the start of a non-empty draft recalls the newest', JSON.stringify(writes()) === '["three"]' && event.defaultPrevented);
  commitDraft(props, 'three');
  press('ArrowDown');
  check('Down restores the draft that was in the box', writes().at(-1) === 'half typed');

  props = mount({ nodes, draft: 'half typed' });
  caret.atStart = false;
  event = press('ArrowUp');
  check('Up with the caret inside the draft is left to the editor', writes().length === 0 && !event.defaultPrevented);

  caret.atStart = true;
  event = press('ArrowUp', { shiftKey: true });
  check('Shift+Up is left to the editor for selection', writes().length === 0 && !event.defaultPrevented);

  event = press('ArrowUp', { metaKey: true });
  check('Cmd/Meta+Up is left to the editor', writes().length === 0 && !event.defaultPrevented);

  menuOpen = true;
  event = press('ArrowUp');
  check('an open slash/mention menu keeps the arrows', writes().length === 0 && !event.defaultPrevented);
  menuOpen = false;

  event = press('ArrowUp', { isComposing: true });
  check('an IME composition keeps the arrow', writes().length === 0 && !event.defaultPrevented);

  props = mount({ nodes, draft: '', phase: 'submitting' });
  event = press('ArrowUp');
  check('a locked composer keeps the arrow', writes().length === 0 && !event.defaultPrevented);

  composer.isContentEditable = false;
  event = press('ArrowUp');
  check('a read-only composer keeps the arrow', writes().length === 0 && !event.defaultPrevented);
  composer.isContentEditable = true;

  event = press('ArrowUp', { target: new FakeElement() });
  check('a key outside the composer is ignored', writes().length === 0 && !event.defaultPrevented);

  event = press('Enter');
  check('other keys pass through untouched', writes().length === 0 && !event.defaultPrevented);

  mount({ nodes, queue: [{ content: [{ type: 'text', text: 'queued prompt' }] }], draft: '' });
  press('ArrowUp');
  check('a queued prompt is recallable before it reaches the transcript', writes().at(-1) === 'queued prompt');
}

// ── 4. clearing the box ends recall ─────────────────────────────────────────
console.log('');
console.log('4. a submitted box resets recall');
{
  const nodes = [
    { kind: 'user', seq: 1, content: [{ type: 'text', text: 'one' }] },
    { kind: 'user', seq: 2, content: [{ type: 'text', text: 'two' }] },
  ];
  const props = mount({ nodes, draft: '' });
  press('ArrowUp');
  commitDraft(props, box.draft);
  press('ArrowUp');
  commitDraft(props, box.draft);
  check('recall reached the oldest entry', JSON.stringify(writes()) === '["two","one"]');

  // Submission clears the draft; the next Up must start from the newest again.
  commitDraft(props, '');
  press('ArrowUp');
  check('Up after the box was cleared restarts at the newest entry', writes().at(-1) === 'two');

  unmount();
  check('unmount removes the capture listener', keyListeners.size === 0);
}

// ── 5. registration ─────────────────────────────────────────────────────────
console.log('');
console.log('5. slot registration');
{
  check('inject names the slots service', Array.isArray(bundle.inject) && bundle.inject.includes('slots'));
  const seen = [];
  bundle.apply({
    slots: {
      inject(name, callback) {
        seen.push({ kind: 'inject', name });
        callback();
        return () => {};
      },
      register(options, component) {
        seen.push({ kind: 'register', options, component });
        return () => {};
      },
    },
  });
  const inject = seen.find((entry) => entry.kind === 'inject');
  const register = seen.find((entry) => entry.kind === 'register');
  check('it injects the composer dock slot', inject !== undefined && inject.name === 'conversation.input.dock');
  check(
    'it registers an invisible entry under its own id',
    register !== undefined &&
      register.options.name === 'conversation.input.dock' &&
      register.options.id === 'prompt-history' &&
      typeof register.options.order === 'number',
  );
}

// ── result ──────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.log(`${String(failures)} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
