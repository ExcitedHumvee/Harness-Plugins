/**
 * Behavioural verifier for the sound-alerts browser half.
 *
 * `node --check` proves `lib/client.js` parses; it proves nothing about what the
 * control does. This harness closes that gap without a browser:
 *
 * - It evaluates the real bundle with a stubbed `window.__ModuleLoader__`, so
 *   the shipped file is what runs (no copy, no build step).
 * - It provides a minimal React hook dispatcher (state, refs, memo, callbacks,
 *   effects with dependency comparison and cleanup) and a JSX-runtime stub that
 *   produces plain element trees, so effects can be flushed deterministically.
 * - It provides a recording Web Audio stub, a localStorage stub, and a DOM stub,
 *   so cue playback, preference persistence, and stylesheet injection are all
 *   observable as data.
 *
 * The assertions cover the two alert triggers, the guards that keep them from
 * firing spuriously, volume/cue customization, persistence, and the copy.
 *
 * Usage: node verify-client.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, 'lib', 'client.js');

let failures = 0;
let currentTest = '';

/**
 * Assert one condition.
 * @param {string} label - what is being asserted.
 * @param {boolean} condition - the result.
 * @param {string} [detail] - extra context on failure.
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
  if (previous === undefined || next === undefined) return true;
  if (previous.length !== next.length) return true;
  for (let i = 0; i < previous.length; i += 1) {
    if (!Object.is(previous[i], next[i])) return true;
  }
  return false;
}

// ── the DOM, storage, and audio stubs ────────────────────────────────────────
const injectedStyles = [];
/** Names of the selector inputs the plugin actually queried. */
const queriedSelectors = [];
const storage = new Map();

/** Oscillator scheduling recorded by the audio stub, in creation order. */
let audioLog = [];

/** Minimal element stub sufficient for the plugin's `appendChild`/`dataset` use. */
function makeElement(tagName) {
  return { tagName, dataset: {}, textContent: '', children: [], appendChild(child) { this.children.push(child); } };
}

const documentStub = {
  head: makeElement('head'),
  createElement: (tagName) => makeElement(tagName),
  querySelector(selector) {
    queriedSelectors.push(selector);
    return null;
  },
  addEventListener() {},
  removeEventListener() {},
};

/** One recorded note: what was scheduled, and when. */
function makeAudioContext() {
  return {
    state: 'running',
    currentTime: 10,
    resumeCalls: 0,
    destination: { kind: 'destination' },
    resume() {
      this.resumeCalls += 1;
      return Promise.resolve();
    },
    createOscillator() {
      const record = { type: null, freq: null, start: null, stop: null };
      const oscillator = {
        frequency: { setValueAtTime(value, at) { record.freq = value; record.freqAt = at; } },
        connect() {},
        start(at) { record.start = at; },
        stop(at) { record.stop = at; },
        get record() { return record; },
      };
      Object.defineProperty(oscillator, 'type', {
        get: () => record.type,
        set: (value) => { record.type = value; },
      });
      audioLog.push(record);
      return oscillator;
    },
    createGain() {
      return {
        gain: {
          setValueAtTime(value, at) { this.setValue = { value, at }; },
          exponentialRampToValueAtTime(value, at) {
            this.ramps = [...(this.ramps ?? []), { value, at }];
          },
        },
        connect() {},
      };
    },
  };
}

const windowStub = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  document: documentStub,
  AudioContext: function AudioContext() {
    windowStub.__contexts = [...(windowStub.__contexts ?? []), makeAudioContext()];
    return windowStub.__contexts[windowStub.__contexts.length - 1];
  },
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

globalThis.window = windowStub;
globalThis.document = documentStub;

// ── the React stand-in ───────────────────────────────────────────────────────
const hookStates = [];
let hookIndex = 0;
/** Pending effects, each with its dependency array and cleanup slot. */
let pendingEffects = [];
/** Effects whose cleanup must run when their deps change or the tree unmounts. */
const liveEffects = new Map();
let effectSeq = 0;

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
        entry.value = typeof next === 'function' ? next(entry.value) : next;
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
  useCallback(fn, deps) {
    const slot = hookIndex;
    const entry = hookStates[slot];
    if (entry === undefined || depsChanged(entry.deps, deps)) {
      hookStates[slot] = { kind: 'callback', value: fn, deps };
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
      pendingEffects.push({ slot, token, fn, deps });
      liveEffects.set(slot, { deps, cleanup: undefined, token, ran: false });
    }
  },
};

/** JSX-runtime stub producing plain, inspectable element trees. */
const jsx = (type, props, key) => ({ $$typeof: 'element', type, key: key ?? null, props: props ?? {} });
const jsxs = jsx;

// ── loading the real bundle ──────────────────────────────────────────────────
let registration = null;
globalThis.window.__ModuleLoader__ = {
  load: (value) => {
    registration = value;
  },
};

const source = readFileSync(CLIENT, 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', source)(windowStub);

if (registration === null) {
  console.error('verifier: the bundle did not register with __ModuleLoader__');
  process.exit(1);
}

const ZERO_WIDTH_SPACE = '\u200b';
const moduleExports = registration.factory((specifier) => {
  if (specifier === 'react') return reactStub;
  if (specifier === 'react/jsx-runtime') return { jsx, jsxs };
  if (specifier === 'react/jsx-dev-runtime') return { jsx, jsxs };
  // The shell also seeds a namespace field whose value is a zero-width space,
  // so the primitive table's absence of Tooltip is exactly what proves the
  // shell's real Tooltip wins.
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: undefined, MARK: ZERO_WIDTH_SPACE };
  throw new Error(`verifier: unexpected require(${specifier})`);
});

console.log(`bundle: ${CLIENT}`);
console.log(`registered id: ${registration.id}`);

// ── the render driver ────────────────────────────────────────────────────────

/**
 * Render the control with the given standard props, flushing effects exactly
 * like React does for a committed tree.
 *
 * @param {object} props - the props the host slot would pass.
 * @returns {object|null} the rendered root element.
 */
function render(props) {
  hookIndex = 0;
  pendingEffects = [];
  const tree = moduleExports.SoundAlerts(props);
  for (const effect of pendingEffects) {
    const entry = liveEffects.get(effect.slot);
    if (entry !== undefined && entry.token === effect.token && !entry.ran) {
      entry.ran = true;
      entry.cleanup = effect.fn() ?? undefined;
    }
  }
  return tree;
}

/**
 * Render and materialize: the flat host-element list every assertion inspects.
 *
 * @param {object} props - the props the host slot would pass.
 * @returns {object[]} every host element in the rendered tree.
 */
function renderFlat(props) {
  const tree = render(props);
  return tree === null ? [] : elements(tree);
}

/** The root host element of a render, or null when the control renders nothing. */
function renderRoot(props) {
  return render(props);
}

/** Unmount the tree, running every live cleanup (mirrors React teardown). */
function unmount() {
  for (const entry of liveEffects.values()) entry.cleanup?.();
  liveEffects.clear();
  hookStates.length = 0;
  hookIndex = 0;
  pendingEffects = [];
}

/** Discard the whole component instance so the next render starts fresh. */
function resetTree() {
  liveEffects.clear();
  hookStates.length = 0;
  hookIndex = 0;
  pendingEffects = [];
}

const settingsKey = 'dsh-sound-alerts.settings.v1';

/**
 * The plugin's own English dictionary, captured from `apply` in the test below
 * and then used as the framework translate seat for every render. Driving the
 * control with the real copy means a missing or renamed key would surface as a
 * failed assertion rather than silently rendering the key.
 */
let englishCopy = {};

/**
 * Build the two standard hooks from a scripted state object.
 *
 * @param {object} state - `{ running, interactionKey }`, mutated between renders.
 * @returns {object} the hook-shaped props.
 */
function propsFor(state) {
  return {
    // Deliberately `'sessionId' in state`: an explicit `undefined` models the
    // Session-less header and must survive, which `??` would erase.
    sessionId: 'sessionId' in state ? state.sessionId : 'session-a',
    // The framework's translate seat: the host resolves the plugin's own
    // dictionary for the registered namespace and hands the occupant a `t`.
    t: (key) => englishCopy[key] ?? key,
    useSession: (selector) => selector({ running: state.running }),
    useSessionPendingInteraction: (selector) => selector({ get: () => (state.interactionKey === null ? undefined : { key: state.interactionKey }) }),
  };
}

/**
 * Recursively materialize a tree by invoking every function component.
 *
 * Unlike React, this descends through function components as well as host
 * elements: the control composes its panel and its glyph as function
 * components, so a host-elements-only walk would never see them. Only reached
 * AFTER the root's hook pass has finished, and none of the child components use
 * hooks, so invoking them here cannot disturb the root's hook slots.
 *
 * @param node - the current node.
 * @param out - accumulator of host elements.
 * @returns the accumulator.
 */
function expand(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) expand(child, out);
    return out;
  }
  if (typeof node.type === 'function') return expand(node.type(node.props), out);
  if (node.$$typeof !== 'element') return out;
  out.push(node);
  expand(node.props?.children, out);
  return out;
}

/** Every host element in a tree, in document order. */
function elements(tree) {
  return expand(tree);
}

/** Every element of one tag in a tree. */
function findAll(tree, type) {
  return elements(tree).filter((node) => node.type === type);
}

/** Every element whose `type` matches a predicate. */
function findWhere(tree, predicate) {
  return elements(tree).filter(predicate);
}

/** Run an event handler exactly as the DOM would. */
function fire(handler, event = {}) {
  handler(event);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── tests ────────────────────────────────────────────────────────────────────
const baseSettings = JSON.parse(JSON.stringify({
  enabled: true,
  volume: 0.5,
  minTurnMs: 0,
  turnComplete: { sound: 'chime', repeat: 1, gapMs: 250 },
  needsInput: { sound: 'ping', repeat: 2, gapMs: 180 },
}));

/** Seed a settings document, or clear it for the built-in defaults. */
function seedSettings(value) {
  storage.clear();
  if (value !== undefined) storage.set(settingsKey, JSON.stringify(value));
}

/** Read back what the plugin persisted. Returns undefined when the stored text is not JSON. */
function persisted() {
  const raw = storage.get(settingsKey);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Fresh instance on the default settings with alerts on. */
function freshInstance(state) {
  resetTree();
  seedSettings(baseSettings);
  return render(propsFor(state));
}

currentTest = 'module shape';
console.log('\nmodule shape');
check('registers under its package id', registration.id === 'dsh-sound-alerts');
check('exports apply', typeof moduleExports.apply === 'function');
check('exports inject', Array.isArray(moduleExports.inject));
check('injects slots and locale', JSON.stringify(moduleExports.inject) === JSON.stringify(['slots', 'locale']));

// The plugin's own apply, against a recording ctx.
{
  const registered = [];
  const injected = [];
  const effects = [];
  let effectOwner = 'none';
  const ctx = {
    effect(fn, label) {
      effectOwner = label;
      effects.push(fn());
    },
    locale: {
      register(namespace, dictionaries) {
        registered.push({ namespace, dictionaries });
        return () => {};
      },
    },
    slots: {
      inject(name, callback) {
        injected.push(name);
        return callback();
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
  };
  moduleExports.apply(ctx);

  currentTest = 'apply';
  console.log('\napply');
  const slotRegistrations = registered.filter((entry) => entry.options !== undefined);
  const localeRegistrations = registered.filter((entry) => entry.dictionaries !== undefined);
  check('injects the header utilities slot', injected.length === 1 && injected[0] === 'conversation.session.header.utilities');
  check('registers exactly one occupant', slotRegistrations.length === 1);
  check('occupant targets the header utilities slot', slotRegistrations[0]?.options.name === 'conversation.session.header.utilities');
  check('occupant id is the plugin id', slotRegistrations[0]?.options.id === 'sound-alerts');
  check('occupant order sits next to the context gauge (5)', slotRegistrations[0]?.options.order === 4);
  check('occupant binds the plugin dictionary', slotRegistrations[0]?.options.locale === 'sound-alerts');
  check('occupant component is the control', slotRegistrations[0]?.component === moduleExports.SoundAlerts);
  check('registers one locale namespace', localeRegistrations.length === 1 && localeRegistrations[0].namespace === 'sound-alerts');
  check('registers both dictionaries', localeRegistrations[0]?.dictionaries.zh !== undefined && localeRegistrations[0]?.dictionaries.en !== undefined);
  check('registers the effect under a label', effects.length === 1 && typeof effects[0] === 'function');
  check('effect label names the dictionaries', effectOwner === 'sound-alerts: dictionaries');
  check('stylesheets are read from the document, style[data-plugin-css] tag injection happened', injectedStyles.length === 0 && documentStub.head.children.length === 1);
  check('the injected style tag carries the plugin markers', documentStub.head.children[0]?.dataset.plugin === 'dsh-sound-alerts');
  check('the injected style tag is namespaced', documentStub.head.children[0]?.dataset.pluginCss === 'dsh-sound-alerts/sound-alerts.css');
  check('the stylesheet was queried before insertion', queriedSelectors.includes('style[data-plugin-css="dsh-sound-alerts/sound-alerts.css"]'));
  check('the stylesheet defines the header control', String(documentStub.head.children[0]?.textContent).includes('.dsh-sound-alerts__trigger'));
}

currentTest = 'dictionaries';
console.log('\ndictionaries');
{
  const locale = registeredDictionaries();
  englishCopy = locale.en;
  const zhKeys = Object.keys(locale.zh).sort();
  const enKeys = Object.keys(locale.en).sort();
  check('the two dictionaries cover the same keys', JSON.stringify(zhKeys) === JSON.stringify(enKeys), `zh=${String(zhKeys.length)} en=${String(enKeys.length)}`);
  check('the English dictionary is non-trivial', enKeys.length >= 20, String(enKeys.length));
  const sounds = ['silent', 'chime', 'ping', 'drop', 'blip', 'double', 'pulse'];
  check('every offered sound has copy in both languages', sounds.every((sound) => locale.zh[`sound.${sound}`] !== undefined && locale.en[`sound.${sound}`] !== undefined));
}

/** Re-run apply against a fresh ctx and return the dictionaries. */
function registeredDictionaries() {
  let captured = null;
  moduleExports.apply({
    effect: (fn) => fn(),
    locale: { register: (namespace, dictionaries) => { captured = dictionaries; return () => {}; } },
    slots: { inject: (_name, callback) => callback(), register: () => () => {} },
  });
  return captured;
}

currentTest = 'rendering';
console.log('\nrendering');
{
  const state = { sessionId: 'session-a', running: false, interactionKey: null };
  const tree = freshInstance(state);
  check('renders a root with the plugin class', tree?.props?.className?.includes('dsh-sound-alerts'));
  check('reports the armed state on a data attribute', tree?.props?.['data-sound-alerts'] === 'on');

  const closed = renderFlat(propsFor(state));
  const buttons = closed.filter((node) => node.type === 'button');
  check('renders exactly one trigger button', buttons.length === 1);
  check('the trigger carries an accessible name', buttons[0]?.props?.['aria-label'] === 'Alert sounds are on', buttons[0]?.props?.['aria-label']);
  check('the trigger is a dialog opener', buttons[0]?.props?.['aria-haspopup'] === 'dialog');
  check('the panel is closed initially', buttons[0]?.props?.['aria-expanded'] === false);
  check('no panel while closed', closed.filter((node) => node.props?.role === 'dialog').length === 0);
  check('the speaker glyph draws its paths', closed.filter((node) => node.type === 'path').length >= 3);

  // Open the panel.
  const opened = freshInstance(state);
  fire(renderFlat(propsFor(state)).filter((node) => node.type === 'button')[0].props.onClick);
  const open = renderFlat(propsFor(state));
  const dialogs = open.filter((node) => node.props?.role === 'dialog');
  check('the trigger opens a dialog panel', dialogs.length === 1);
  check('the panel is labelled', dialogs[0]?.props?.['aria-label'] === 'Alert sounds');
  check('the open trigger reports expanded', open.filter((node) => node.type === 'button')[0]?.props?.['aria-expanded'] === true);

  const selects = open.filter((node) => node.type === 'select');
  const numbers = open.filter((node) => node.type === 'input' && node.props.type === 'number');
  const checkboxes = open.filter((node) => node.type === 'input' && node.props.type === 'checkbox');
  const ranges = open.filter((node) => node.type === 'input' && node.props.type === 'range');
  check('offers one sound picker per cue', selects.length === 2);
  // One minimum-turn field plus a repeat and a gap for each of the two cues.
  check('offers the minimum-turn field and repeat/gap per cue', numbers.length === 5, String(numbers.length));
  check('the minimum-turn field comes first', numbers[0]?.props?.['aria-label'] === undefined && numbers[0]?.props.id === 'dsh-sound-alerts-min-turn');
  check('each cue labels its repeat and gap fields', numbers.filter((node) => typeof node.props['aria-label'] === 'string').length === 4);
  check('offers the master switch', checkboxes.length === 1);
  check('offers a volume slider', ranges.length === 1);
  check('offers a test button per cue', open.filter((node) => node.type === 'button' && node.props.children === 'Test').length === 2);
  check('offers a reset button', open.filter((node) => node.type === 'button' && node.props.children === 'Reset').length === 1);
  check('the first sound picker lists every sound', selects[0]?.props.children.length === 7);
  check('the master switch reflects the stored value', checkboxes[0]?.props.checked === true);
  check('the volume slider reflects the stored value', ranges[0]?.props.value === 50, String(ranges[0]?.props.value));
  check('the minimum-turn field reflects the stored value', numbers[0]?.props.value === 0, String(numbers[0]?.props.value));
  check('the first cue shows its stored repeat', numbers[1]?.props.value === 1, String(numbers[1]?.props.value));
}

currentTest = 'no session';
console.log('\nno session');
{
  const state = { sessionId: undefined, running: false, interactionKey: null };
  const tree = freshInstance(state);
  check('renders nothing without a Session', tree === null);
}

currentTest = 'completion cue';
console.log('\ncompletion cue');
{
  const state = { sessionId: 'session-a', running: false, interactionKey: null };
  freshInstance(state);

  audioLog = [];
  render(propsFor({ ...state, running: true }));
  check('starting a turn makes no sound', audioLog.length === 0);

  render(propsFor({ ...state, running: false }));
  const chime = 2; // the chime recipe is a two-note interval
  check('finishing a turn plays the completion cue', audioLog.length === chime, `notes=${String(audioLog.length)}`);
  check('the cue uses the chime frequencies', audioLog.map((note) => Math.round(note.freq)).join(',') === '1047,784', audioLog.map((note) => note.freq).join(','));
  check('the cue is staggered as an interval', audioLog[0]?.start < audioLog[1]?.start);
  check('notes are released, not left ringing', audioLog.every((note) => note.stop > note.start));

  // Re-rendering the same idle state must not replay.
  audioLog = [];
  render(propsFor({ ...state, running: false }));
  check('an idle re-render stays silent', audioLog.length === 0);

  // A session that mounts idle never saw a turn complete.
  resetTree();
  audioLog = [];
  render(propsFor({ sessionId: 'session-b', running: false, interactionKey: null }));
  check('a session that mounts idle stays silent', audioLog.length === 0);

  // Switching back to an idle session must not look like a completion.
  resetTree();
  render(propsFor({ sessionId: 'session-c', running: true, interactionKey: null }));
  audioLog = [];
  render(propsFor({ sessionId: 'session-d', running: false, interactionKey: null }));
  check('switching sessions stays silent', audioLog.length === 0);
}

currentTest = 'minimum turn length';
console.log('\nminimum turn length');
{
  seedSettings({ ...baseSettings, minTurnMs: 60000 });
  resetTree();
  const state = { sessionId: 'session-a', running: false, interactionKey: null };
  render(propsFor(state));
  audioLog = [];
  render(propsFor({ ...state, running: true }));
  render(propsFor({ ...state, running: false }));
  check('a turn under the floor stays silent', audioLog.length === 0, `notes=${String(audioLog.length)}`);

  seedSettings({ ...baseSettings, minTurnMs: 0 });
  resetTree();
  render(propsFor(state));
  audioLog = [];
  render(propsFor({ ...state, running: true }));
  render(propsFor({ ...state, running: false }));
  check('a turn at the floor is cued', audioLog.length === 2);
}

currentTest = 'input-needed cue';
console.log('\ninput-needed cue');
{
  freshInstance({ sessionId: 'session-a', running: false, interactionKey: null });
  audioLog = [];
  render(propsFor({ sessionId: 'session-a', running: false, interactionKey: 'approval-1' }));
  check('a pending interaction plays the input cue', audioLog.length === 2, `notes=${String(audioLog.length)}`);
  check('the cue uses the ping frequency', Math.round(audioLog[0]?.freq) === 1175, String(audioLog[0]?.freq));
  check('the default input cue repeats twice', audioLog.length === 2);
  check('the repeats are spaced by the configured gap', Math.round((audioLog[1].start - audioLog[0].start) * 1000) === 180, String((audioLog[1].start - audioLog[0].start) * 1000));

  audioLog = [];
  render(propsFor({ sessionId: 'session-a', running: false, interactionKey: 'approval-1' }));
  check('re-rendering the same request stays silent', audioLog.length === 0);

  audioLog = [];
  render(propsFor({ sessionId: 'session-a', running: false, interactionKey: 'question-2' }));
  check('a replacement request cues again', audioLog.length === 2);

  audioLog = [];
  render(propsFor({ sessionId: 'session-a', running: false, interactionKey: null }));
  check('answering the request stays silent', audioLog.length === 0);
}

currentTest = 'customization';
console.log('\ncustomization');
{
  const state = { sessionId: 'session-a', running: false, interactionKey: null };
  freshInstance(state);
  fire(renderFlat(propsFor(state)).filter((node) => node.type === 'button')[0].props.onClick);

  // Choose `double` for the completion cue and raise its repeat to 3.
  const selects = renderFlat(propsFor(state)).filter((node) => node.type === 'select');
  fire(selects[0].props.onChange, { target: { value: 'double' } });
  // Field order is [minimum turn, complete repeat, complete gap, input repeat,
  // input gap], so index 1 is the completion cue's repeat count.
  const numbers = renderFlat(propsFor(state)).filter((node) => node.type === 'input' && node.props.type === 'number');
  check('the completion repeat field is the second number input', numbers[1]?.props['aria-label'] === 'When a final response completes — Repeat', numbers[1]?.props['aria-label']);
  fire(numbers[1].props.onChange, { target: { value: '3' } });

  const saved = persisted();
  check('the sound choice is persisted', saved?.turnComplete.sound === 'double', JSON.stringify(saved?.turnComplete));
  check('the repeat count is persisted', saved?.turnComplete.repeat === 3, String(saved?.turnComplete.repeat));
  check('editing one cue leaves the other alone', saved?.needsInput.sound === 'ping' && saved.needsInput.repeat === 2);
  check('the sound picker shows the new choice', renderFlat(propsFor(state)).filter((node) => node.type === 'select')[0]?.props.value === 'double');

  audioLog = [];
  render(propsFor({ ...state, running: true }));
  render(propsFor({ ...state, running: false }));
  // `double` is a two-note recipe, repeated three times.
  check('the customized cue plays the configured repeats', audioLog.length === 6, `notes=${String(audioLog.length)}`);
  check('the customized cue uses the double frequencies', audioLog.every((note) => Math.round(note.freq) === 988));

  // Volume at zero silences the alert path.
  storage.set(settingsKey, JSON.stringify({ ...saved, volume: 0 }));
  resetTree();
  render(propsFor(state));
  audioLog = [];
  render(propsFor({ ...state, running: true }));
  render(propsFor({ ...state, running: false }));
  render(propsFor({ ...state, running: false, interactionKey: 'approval-1' }));
  check('zero volume silences both cues', audioLog.length === 0, `notes=${String(audioLog.length)}`);

  // The master switch silences both cues and shows as off.
  storage.set(settingsKey, JSON.stringify({ ...baseSettings, enabled: false }));
  resetTree();
  const offTree = render(propsFor(state));
  check('the control reports the off state', offTree?.props?.['data-sound-alerts'] === 'off');
  check('the off state has its own class', offTree?.props?.className?.includes('dsh-sound-alerts--off'));
  check('the trigger label follows the state', renderFlat(propsFor(state)).filter((node) => node.type === 'button')[0]?.props?.['aria-label'] === 'Alert sounds are off');
  audioLog = [];
  render(propsFor({ ...state, running: true }));
  render(propsFor({ ...state, running: false }));
  render(propsFor({ ...state, running: false, interactionKey: 'approval-1' }));
  check('disabled alerts stay silent for both cues', audioLog.length === 0, `notes=${String(audioLog.length)}`);
}

currentTest = 'test button and reset';
console.log('\ntest button and reset');
{
  const state = { sessionId: 'session-a', running: false, interactionKey: null };
  freshInstance(state);
  fire(renderFlat(propsFor(state)).filter((node) => node.type === 'button')[0].props.onClick);

  const testButtons = renderFlat(propsFor(state)).filter((node) => node.type === 'button' && node.props.children === 'Test');
  check('the panel offers both test buttons', testButtons.length === 2);
  audioLog = [];
  fire(testButtons[0].props.onClick);
  check('the completion test button plays a cue', audioLog.length === 2, `notes=${String(audioLog.length)}`);

  audioLog = [];
  fire(testButtons[1].props.onClick);
  check('the input test button plays a cue', audioLog.length === 2);

  // Reset must restore defaults even after edits.
  storage.set(settingsKey, JSON.stringify({ ...baseSettings, enabled: false, volume: 0.05 }));
  resetTree();
  render(propsFor(state));
  fire(renderFlat(propsFor(state)).filter((node) => node.type === 'button')[0].props.onClick);
  const reset = renderFlat(propsFor(state)).filter((node) => node.type === 'button' && node.props.children === 'Reset');
  fire(reset[0].props.onClick);
  const afterReset = persisted();
  check('reset restores the master switch', afterReset?.enabled === true);
  check('reset restores the volume', afterReset?.volume === 0.5, String(afterReset?.volume));
  check('reset restores the cue sounds', afterReset?.turnComplete.sound === 'chime' && afterReset?.needsInput.sound === 'ping');
}

currentTest = 'stored payload hardening';
console.log('\nstored payload hardening');
{
  const state = { sessionId: 'session-a', running: false, interactionKey: null };
  for (const [label, payload] of [
    ['garbage text', 'not json at all'],
    ['a null document', 'null'],
    ['an array', '[1,2,3]'],
    ['unknown sounds', JSON.stringify({ turnComplete: { sound: 'airhorn' }, needsInput: { sound: 5 } })],
    ['out-of-range numbers', JSON.stringify({ volume: 99, minTurnMs: -4000, turnComplete: { repeat: 0, gapMs: 99999 } })],
    ['wrong field types', JSON.stringify({ enabled: 'yes', volume: 'loud' })],
  ]) {
    resetTree();
    storage.clear();
    storage.set(settingsKey, payload);

    // Render, then exercise the control so the in-memory state is the only
    // thing under test: a payload the plugin cannot parse must still leave a
    // working, in-range configuration rather than a broken one.
    let flat;
    try {
      render(propsFor(state));
      flat = renderFlat(propsFor(state));
      fire(flat.filter((node) => node.type === 'button')[0].props.onClick);
      const numbers = renderFlat(propsFor(state)).filter((node) => node.type === 'input' && node.props.type === 'number');
      fire(numbers[0].props.onChange, { target: { value: '1500' } });
      flat = renderFlat(propsFor(state));
    } catch (error) {
      check(`${label} does not throw`, false, String(error));
      continue;
    }

    const saved = persisted();
    const volumeOk = typeof saved.volume === 'number' && saved.volume >= 0 && saved.volume <= 1;
    const repeatOk = Number.isInteger(saved.turnComplete.repeat) && saved.turnComplete.repeat >= 1 && saved.turnComplete.repeat <= 5;
    const soundOk = ['silent', 'chime', 'ping', 'drop', 'blip', 'double', 'pulse'].includes(saved.turnComplete.sound);
    const controlLive = flat.filter((node) => node.type === 'button').length >= 1 && flat.some((node) => node.props?.role === 'dialog');
    check(`${label} leaves a working control and a usable document`, controlLive && volumeOk && repeatOk && soundOk, JSON.stringify(saved));
    check(`${label} keeps the user's edit`, saved.minTurnMs === 1500, String(saved.minTurnMs));
  }

  // A silent cue is a first-class choice, not an error state.
  resetTree();
  storage.clear();
  storage.set(settingsKey, JSON.stringify({ ...baseSettings, turnComplete: { sound: 'silent', repeat: 1, gapMs: 250 } }));
  render(propsFor(state));
  audioLog = [];
  render(propsFor({ ...state, running: true }));
  render(propsFor({ ...state, running: false }));
  check('choosing Silent plays nothing for that cue', audioLog.length === 0);
  audioLog = [];
  render(propsFor({ ...state, running: false, interactionKey: 'approval-1' }));
  check('choosing Silent leaves the other cue armed', audioLog.length === 2);
}

currentTest = 'unmount';
console.log('\nunmount');
{
  const state = { sessionId: 'session-a', running: false, interactionKey: null };
  freshInstance(state);
  render(propsFor(state));
  let threw = false;
  try {
    unmount();
  } catch (error) {
    threw = true;
    console.log(String(error));
  }
  check('unmounting runs every cleanup without error', !threw);
}

// Avoid an unhandled rejection from the fire-and-forget `ctx.resume()`.
await sleep(0);

console.log('');
if (failures === 0) {
  console.log('all checks passed');
} else {
  console.log(`${String(failures)} check(s) failed`);
  process.exit(1);
}
