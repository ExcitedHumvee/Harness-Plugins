/**
 * Behavioural checks for the DSH STT client half — no browser required.
 *
 * `lib/client.js` is evaluated here against stubs: `window.__ModuleLoader__`,
 * a minimal React hook dispatcher, a DOM-ish element tree, a `localStorage`,
 * a `MediaRecorder` + `getUserMedia` pair the test drives by hand, fake timers,
 * an analyser whose input level the test sets, a Lexical-ish contenteditable the
 * DOM-insert path can be pointed at, and a `fetch` that records every request.
 * Each test reloads the bundle, so mount-time settings are read fresh and no test
 * depends on the order of the ones before it.
 *
 * What is asserted is what would actually break on a user's machine:
 *
 *   - the plugin registers into the composer's trailing slot, left of the other
 *     trailing controls, and every locale key the component asks for exists in
 *     both dictionaries
 *   - a click opens the microphone with the recording constraints, picks a
 *     container the browser supports, and records with a timeslice
 *   - **the meter is visible and alive**: a status pill with level bars and a
 *     clock appears while recording, its bars follow the input level, the panel
 *     shows a dBFS meter with a peak hold, and *Test microphone* opens the mic
 *     without recording
 *   - **a dead input is called out**: flat bars long enough produce "No audio",
 *     and a silent clip fails with the device advice rather than "no speech"
 *   - stopping POSTs the recorded blob to `/transcribe` with the per-request
 *     headers, and the transcript lands at the caret through the composer's own
 *     paste command
 *   - **insertion never fails silently**: every fallback is exercised — the
 *     public draft action, the editor's own DOM pipeline, the clipboard — and the
 *     path taken is shown next to the button and in the diagnostics
 *   - an empty clip is never uploaded, an unreachable sidecar is reported as
 *     such, an in-flight transcription can be cancelled, and the microphone and
 *     audio graph are always released
 *   - the recording cap and the silence auto-stop end a recording on their own
 *
 * Usage: node stt/verify-client.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, 'lib', 'client.js');
const PACKAGE = join(here, 'package.json');

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

// ── minimal React ────────────────────────────────────────────────────────────

/** Element factory mirroring the JSX runtime contract. */
const jsx = (type, props, key) => ({ type, props: props ?? {}, key: key ?? null });
const jsxs = jsx;

/**
 * A hook dispatcher plus a renderer, sized to what this plugin uses.
 *
 * Instances are keyed by their position in the tree, so a re-render keeps the
 * same hook state — which is what makes `useState`/`useRef` observable here.
 */
function createRuntime() {
  const instances = new Map();
  let current = null;
  let dirty = false;

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

  const react = {
    useState(initial) {
      const instance = current;
      const index = instance.index++;
      if (instance.hooks.length <= index) {
        instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      }
      const hook = instance.hooks[index];
      const setter = (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next;
        if (Object.is(value, hook.value)) return;
        hook.value = value;
        dirty = true;
      };
      return [hook.value, setter];
    },
    useRef(initial) {
      const instance = current;
      const index = instance.index++;
      if (instance.hooks.length <= index) instance.hooks[index] = { value: { current: initial } };
      return instance.hooks[index].value;
    },
    useCallback(fn, deps) {
      const instance = current;
      const index = instance.index++;
      const previous = instance.hooks[index];
      if (previous === undefined || !sameDeps(previous.deps, deps)) instance.hooks[index] = { value: fn, deps };
      return instance.hooks[index].value;
    },
    useMemo(fn, deps) {
      const instance = current;
      const index = instance.index++;
      const previous = instance.hooks[index];
      if (previous === undefined || !sameDeps(previous.deps, deps)) instance.hooks[index] = { value: fn(), deps };
      return instance.hooks[index].value;
    },
    useEffect(fn, deps) {
      const instance = current;
      const index = instance.index++;
      const previous = instance.hooks[index];
      if (previous === undefined || !sameDeps(previous.deps, deps)) {
        // Store the deps, or the next render has nothing to compare against and
        // re-runs every effect (and its cleanup) on every render.
        instance.hooks[index] = { deps };
        instance.effects.push({ fn, index, previous });
      }
    },
  };

  /**
   * Render one element into a host tree.
   * @param element - element, string, number, array or null.
   * @param path - stable instance path.
   * @returns the rendered node.
   */
  function render(element, path) {
    if (element === null || element === undefined || typeof element === 'boolean') return null;
    if (typeof element === 'string' || typeof element === 'number') return element;
    if (Array.isArray(element)) return element.map((child, index) => render(child, `${path}[${index}]`));

    const { type, props } = element;
    if (typeof type === 'function') {
      const name = type.displayName ?? type.name ?? 'anon';
      const instancePath = `${path}/${name}`;
      const instance = instances.get(instancePath) ?? { hooks: [], index: 0, effects: [] };
      instances.set(instancePath, instance);

      const previous = current;
      instance.index = 0;
      instance.effects = [];
      current = instance;
      let output;
      try {
        output = type(props ?? {});
      } finally {
        current = previous;
      }
      const node = render(output, instancePath);

      for (const effect of instance.effects) {
        if (effect.previous?.cleanup) effect.previous.cleanup();
        const cleanup = effect.fn();
        instance.hooks[effect.index] = { ...instance.hooks[effect.index], cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      }
      return node;
    }

    return { type, props: props ?? {}, children: render(props?.children, `${path}/${String(type)}`) };
  }

  return {
    react,
    jsx,
    jsxs,
    /**
     * Render a root element and return its host tree.
     * @param element - the root element.
     * @returns the rendered tree.
     */
    mount(element) {
      return render(element, 'root');
    },
    /**
     * Re-render while state changes keep arriving.
     * @param element - the root element to re-render.
     * @returns the final tree.
     */
    async flush(element) {
      let tree = render(element, 'root');
      for (let round = 0; round < 80; round += 1) {
        // Several microtask hops: a settled `fetch` chain (await response.json()
        // → setState) is not one hop deep, and returning early would hand back a
        // tree that is one state update behind.
        for (let hop = 0; hop < 6; hop += 1) await Promise.resolve();
        if (!dirty) {
          for (let hop = 0; hop < 6; hop += 1) await Promise.resolve();
          if (!dirty) return render(element, 'root');
        }
        dirty = false;
        tree = render(element, 'root');
      }
      return tree;
    },
  };
}

/** Depth-first search over a host tree. */
function findAll(node, predicate, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  // A host element with one child holds that child directly, not in an array;
  // missing that case hides whole subtrees from the search.
  const children = Array.isArray(node.children) ? node.children : [node.children];
  for (const child of children) findAll(child, predicate, out);
  return out;
}

/** Text of every string leaf, for copy assertions. */
function strings(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  const children = Array.isArray(node.children) ? node.children : [node.children];
  for (const child of children) strings(child, out);
  return out;
}

// ── stubs ────────────────────────────────────────────────────────────────────

const fetchCalls = [];
const storage = new Map();
const pastings = [];
const drafts = [];
const clipboardWrites = [];
const timers = [];
const trackStops = [];

/** Stubbed fetch: tests install a handler, or a queue of planned responses. */
let fetchPlan = [];
let fetchHandler = null;

const fetchStub = async (url, options = {}) => {
  fetchCalls.push({ url, options });
  if (fetchHandler !== null) return fetchHandler(url, options);
  const next = fetchPlan.shift();
  if (next === undefined) throw new Error(`unexpected fetch: ${url}`);
  if (next instanceof Error) throw next;
  return {
    ok: next.ok ?? true,
    status: next.status ?? 200,
    json: async () => next.body ?? {},
  };
};

/** A blob stand-in that keeps its parts, so the request body is inspectable. */
class FakeBlob {
  constructor(parts = [], options = {}) {
    this.parts = parts;
    this.type = options.type ?? '';
    this.size = parts.reduce((total, part) => total + (typeof part.size === 'number' ? part.size : 1), 0);
  }
}

const SUPPORTED_CONTAINERS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

/** A MediaRecorder the test drives: `emit` feeds data, `stop` fires `onstop`. */
class FakeRecorder {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType ?? '';
    this.state = 'inactive';
    this.timeslice = null;
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    FakeRecorder.instances.push(this);
  }

  static isTypeSupported(type) {
    return FakeRecorder.supported.includes(type);
  }

  start(timeslice) {
    this.state = 'recording';
    this.timeslice = timeslice;
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.onstop?.();
  }

  /** Simulate one `dataavailable` event. */
  emit(data) {
    this.ondataavailable?.({ data });
  }
}
FakeRecorder.instances = [];
FakeRecorder.supported = [...SUPPORTED_CONTAINERS];
FakeRecorder.reset = () => {
  FakeRecorder.instances = [];
  FakeRecorder.supported = [...SUPPORTED_CONTAINERS];
};

/** The analyser the meter reads: `level` is the byte value it reports. */
const analyser = {
  fftSize: 1024,
  smoothingTimeConstant: 0,
  level: 128,
  getByteTimeDomainData(buffer) {
    buffer.fill(analyser.level);
  },
};

const audioGraph = { closed: 0, disconnects: 0, sources: 0 };

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.resumes = 0;
  }

  resume() {
    this.resumes += 1;
    this.state = 'running';
    return Promise.resolve();
  }

  createMediaStreamSource() {
    audioGraph.sources += 1;
    return {
      connect() {},
      disconnect() {
        audioGraph.disconnects += 1;
      },
    };
  }

  createAnalyser() {
    return analyser;
  }

  close() {
    audioGraph.closed += 1;
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** `InputEvent` stand-in, so the synthetic-beforeinput path is exercised. */
class FakeInputEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
    this.inputType = init.inputType;
    this.data = init.data;
  }
}

/** requestAnimationFrame queue: `tickMeter` runs one frame at a time. */
const rafHandles = new Map();
const rafQueue = [];
let rafNext = 0;

/** What the next `getUserMedia` / `enumerateDevices` call does. */
const mediaPlan = { calls: 0, error: null, tracks: [], constraints: [], devices: null };

const windowStub = {
  __ModuleLoader__: { load: (entry) => { windowStub.__entry = entry; } },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  navigator: {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        mediaPlan.calls += 1;
        mediaPlan.constraints.push(constraints);
        if (mediaPlan.error !== null) throw mediaPlan.error;
        return { getTracks: () => mediaPlan.tracks };
      },
      enumerateDevices: async () => mediaPlan.devices ?? [],
    },
    clipboard: {
      writeText: async (text) => {
        if (windowStub.navigator.clipboard.blocked) throw new Error('blocked');
        clipboardWrites.push(text);
      },
      blocked: false,
    },
  },
  MediaRecorder: FakeRecorder,
  Blob: FakeBlob,
  AudioContext: FakeAudioContext,
  InputEvent: FakeInputEvent,
  setTimeout: (fn, ms) => {
    timers.push({ fn, ms, cleared: false });
    return timers.length;
  },
  clearTimeout: (id) => {
    const timer = timers[id - 1];
    if (timer !== undefined) timer.cleared = true;
  },
  requestAnimationFrame: (fn) => {
    rafNext += 1;
    rafHandles.set(rafNext, fn);
    rafQueue.push(rafNext);
    return rafNext;
  },
  cancelAnimationFrame: (id) => {
    rafHandles.delete(id);
  },
};

globalThis.window = windowStub;
globalThis.fetch = fetchStub;

const source = readFileSync(CLIENT, 'utf8');

/**
 * Evaluate the bundle and build its exports against a fresh hook runtime.
 *
 * Re-evaluating is what makes the tests independent: `useState(readSilence)` and
 * friends run once per mount, so a settings test needs a component that has never
 * been mounted before.
 *
 * @param runtime - the hook runtime to render with.
 * @returns the plugin's exports.
 */
function loadWith(runtime) {
  // eslint-disable-next-line no-new-func
  new Function('window', source)(windowStub);
  const primitives = { Tooltip: ({ children }) => children };
  const requireStub = (id) => {
    if (id === 'react') return runtime.react;
    if (id === 'react/jsx-runtime') return { jsx: runtime.jsx, jsxs: runtime.jsxs };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`unexpected require: ${id}`);
  };
  return windowStub.__entry.factory(requireStub);
}

let runtime = createRuntime();
/** Rebuilt by every `reset()`; the helpers below always read the current one. */
let exportsObject = loadWith(runtime);

const entry = windowStub.__entry;
check('client bundle calls the module loader', typeof entry === 'object' && entry !== null);
check('registers under the package id', entry?.id === 'dsh-stt', String(entry?.id));
check('id matches package.json', JSON.parse(readFileSync(PACKAGE, 'utf8')).name === entry?.id);

// ── module shape ─────────────────────────────────────────────────────────────
console.log('');
console.log('module shape');
check('exports apply', typeof exportsObject.apply === 'function');
check('exports the component', typeof exportsObject.SttButton === 'function');
check('exports the panel', typeof exportsObject.SttPanel === 'function');
check('injects slots and locale', Array.isArray(exportsObject.inject) && exportsObject.inject.includes('slots') && exportsObject.inject.includes('locale'));

/** Captured slot registration from a stubbed client context. */
const registrations = [];
const localeNamespaces = [];
const ctx = {
  effect: (fn, label) => {
    ctx.effects.push({ fn, label });
    fn();
  },
  effects: [],
  locale: { register: (ns, dicts) => localeNamespaces.push({ ns, dicts }) },
  slots: {
    inject: (slot, fn) => {
      ctx.injectedSlot = slot;
      fn();
    },
    register: (options, component) => registrations.push({ options, component }),
  },
};
exportsObject.apply(ctx);

check('injects the composer trailing slot', ctx.injectedSlot === 'conversation.input.right', String(ctx.injectedSlot));
check('registers exactly one occupant', registrations.length === 1, String(registrations.length));
check('occupant targets the composer trailing slot', registrations[0]?.options?.name === 'conversation.input.right');
check('occupant id is stt', registrations[0]?.options?.id === 'stt');
check('occupant sits at the left of the trailing controls', registrations[0]?.options?.order === 9, String(registrations[0]?.options?.order));
check('occupant binds the plugin dictionary', registrations[0]?.options?.locale === 'stt');
check('occupant component is the button', registrations[0]?.component === exportsObject.SttButton);
check('registers one locale namespace', localeNamespaces.length === 1);
check('namespace is stt', localeNamespaces[0]?.ns === 'stt');
check('registers English and Chinese', Boolean(localeNamespaces[0]?.dicts?.en) && Boolean(localeNamespaces[0]?.dicts?.zh));
check('the effect carries a label', typeof ctx.effects[0]?.label === 'string' && ctx.effects[0].label.includes('stt'));

// ── dictionaries ─────────────────────────────────────────────────────────────
console.log('');
console.log('dictionaries');
const en = localeNamespaces[0].dicts.en;
const zh = localeNamespaces[0].dicts.zh;
check('the two dictionaries cover the same keys', JSON.stringify(Object.keys(en).sort()) === JSON.stringify(Object.keys(zh).sort()));
check('the English dictionary is non-trivial', Object.keys(en).length >= 45, String(Object.keys(en).length));

const usedKeys = new Set([...source.matchAll(/\bt\(\s*"([^"]+)"/g)].map((match) => match[1]));
const dynamicPrefixes = [...source.matchAll(/t\(`([a-z]+)\.\$\{/g)].map((match) => match[1]);
const missing = [...usedKeys].filter((key) => !(key in en));
check('every literal t() key exists in the dictionary', missing.length === 0, missing.join(', '));
check('the literal keys were actually found', usedKeys.size >= 40, String(usedKeys.size));
check('the engine status key is looked up dynamically', dynamicPrefixes.length >= 1, dynamicPrefixes.join(', '));
for (const prefix of dynamicPrefixes) {
  const statuses = ['ready', 'loading', 'starting', 'error'];
  check(`engine.${prefix}.* keys exist`, statuses.every((status) => `${prefix}.${status}` in en));
}
check('the meter and silence notes exist', 'note.silent' in en && 'note.autoStop' in en && 'note.meterUnavailable' in en);
check('the silent-microphone error exists', 'error.silentMic' in en && 'error.emptyRecording' in en);
check('the diagnostics keys exist', 'panel.diagnostics' in en && 'panel.diagInsert' in en && 'panel.diagHandles' in en);

// ── pure helpers ─────────────────────────────────────────────────────────────
console.log('');
console.log('pure helpers');
const {
  pickMime, cleanupText, appendToDraft, computeLevel, meterBars, levelToDb, findComposerEditor, domDraft, readDraftFrom,
  insertIntoComposer, placeText, recordingConstraints, clock, readLanguage, readBase, readSilence, readCap, readDevice,
  DEFAULT_BASE, SILENCE_RMS, METER_BARS,
} = exportsObject.__test;

check('exposes the test helpers', [pickMime, cleanupText, appendToDraft, computeLevel, meterBars, placeText, insertIntoComposer].every((value) => typeof value === 'function'));
check('the default endpoint is the sidecar port', DEFAULT_BASE === 'http://127.0.0.1:8124', DEFAULT_BASE);
check('the meter draws a readable number of bars', METER_BARS >= 8 && METER_BARS <= 24, String(METER_BARS));
check('the best container wins', pickMime(FakeRecorder) === 'audio/webm;codecs=opus', pickMime(FakeRecorder));
FakeRecorder.supported = ['audio/ogg;codecs=opus'];
check('the next supported container is used', pickMime(FakeRecorder) === 'audio/ogg;codecs=opus', pickMime(FakeRecorder));
FakeRecorder.supported = [];
check('no supported container falls back to the browser default', pickMime(FakeRecorder) === '', pickMime(FakeRecorder));
check('a recorder without isTypeSupported is tolerated', pickMime(function Recorder() {}) === '');
FakeRecorder.reset();

check('whitespace in a transcript is collapsed', cleanupText('  hello   there \n world ') === 'hello there world');
check('a space before punctuation is removed', cleanupText('hello , world .') === 'hello, world.');
check('a null transcript cleans to nothing', cleanupText(null) === '');
check('append keeps a word boundary', appendToDraft('Existing text', 'New words.') === 'Existing text New words.');
check('append respects trailing whitespace', appendToDraft('Existing ', 'New words.') === 'Existing New words.');
check('append into an empty draft adds no space', appendToDraft('   ', 'New words.') === 'New words.');

console.log('');
console.log('meter maths');
const silence = computeLevel(new Uint8Array(64).fill(128));
check('a centred buffer is silence', silence.rms === 0 && silence.peak === 0, JSON.stringify(silence));
const loud = computeLevel(new Uint8Array(64).fill(200));
check('an off-centre buffer has level', loud.rms > 0.5 && loud.peak > 0.5, JSON.stringify(loud));
check('the level is symmetrical', Math.abs(computeLevel(new Uint8Array(8).fill(56)).rms - computeLevel(new Uint8Array(8).fill(200)).rms) < 1e-9);
check('an empty buffer is silence', computeLevel(new Uint8Array(0)).rms === 0);
check('a missing buffer is silence', computeLevel(undefined).rms === 0);
const quietBars = meterBars(0.0, 10);
const loudBars = meterBars(0.1, 10);
check('the meter draws one bar per step', quietBars.length === 10 && loudBars.length === 10);
check('silence lights no bar', quietBars.every((fill) => fill === 0), JSON.stringify(quietBars));
check('a loud frame lights bars from the left', loudBars[0] === 1 && loudBars[9] === 0, JSON.stringify(loudBars));
check('bar fills stay inside 0..1', meterBars(5, 10).every((fill) => fill >= 0 && fill <= 1));
check('a rising level never shortens the meter', meterBars(0.1, 10).reduce((sum, fill) => sum + fill, 0) <= meterBars(0.3, 10).reduce((sum, fill) => sum + fill, 0));
check('silence reads as a very low dBFS', levelToDb(0) === -100, String(levelToDb(0)));
check('full scale reads as 0 dBFS', levelToDb(1) === 0, String(levelToDb(1)));
check('the clock formats under a minute', clock(7) === '0:07', clock(7));
check('the clock formats over a minute', clock(75) === '1:15', clock(75));

const defaultConstraints = recordingConstraints('');
check('no device id means the system default', defaultConstraints.audio.deviceId === undefined);
check('the constraints ask for speech processing', defaultConstraints.audio.echoCancellation === true && defaultConstraints.audio.channelCount === 1);
check('a chosen device is pinned exactly', recordingConstraints('dev-2').audio.deviceId.exact === 'dev-2');

// ── composer-editor DOM helpers ──────────────────────────────────────────────
/**
 * A fake Lexical-ish composer editor.
 * @param options - initial text and placement.
 * @returns the element plus its observable state.
 */
function fakeEditor(options = {}) {
  const node = {
    innerText: options.text ?? '',
    contentEditable: 'true',
    isContentEditable: true,
    focused: 0,
    edits: 0,
    focus() {
      node.focused += 1;
    },
    getAttribute(name) {
      return name === 'contenteditable' ? 'true' : null;
    },
    hasAttribute(name) {
      return name === 'data-lexical-editor' ? options.lexical !== false : false;
    },
    closest(selector) {
      return options.inOverlay === true && String(selector).includes('dialog') ? {} : null;
    },
    dispatchEvent(event) {
      // Stands in for Lexical's own beforeinput handling.
      if (options.handlesEvents === true && typeof event?.data === 'string') {
        node.innerText += event.data;
        node.edits += 1;
        return true;
      }
      return true;
    },
  };
  return node;
}

/**
 * A fake document over one or more editors.
 * @param editors - the editors to expose.
 * @param options - `insertText` fidelity switches.
 * @returns the document stub.
 */
function fakeDoc(editors, options = {}) {
  return {
    defaultView: options.defaultView ?? null,
    querySelectorAll: (selector) => (selector === '[role="textbox"]' ? editors : []),
    execCommand: (command, _ui, value) => {
      if (options.execCommand === 'none') return false;
      const editor = editors[editors.length - 1];
      if (command === 'selectAll') {
        if (options.selectAll === false) return false;
        editor.innerText = '';
        return true;
      }
      if (command === 'insertText') {
        if (options.insertText === false) return true; // claims success, changes nothing
        editor.innerText += value;
        return true;
      }
      return false;
    },
  };
}

console.log('');
console.log('composer editor lookup and insertion');
{
  const composer = fakeEditor({ text: 'hi' });
  const panelBox = fakeEditor({ text: 'panel', inOverlay: true });
  const doc = fakeDoc([panelBox, composer]);
  check('the editor outside overlays wins', findComposerEditor(doc) === composer);
  check('the draft is read out of the editor', domDraft(doc) === 'hi', domDraft(doc));
  check('a document without textboxes yields nothing', findComposerEditor(fakeDoc([])) === null);
  check('a missing document yields nothing', findComposerEditor(null) === null);
  const nonLexical = fakeEditor({ text: '', lexical: false });
  check('a non-Lexical textbox still works as a last resort', findComposerEditor(fakeDoc([nonLexical])) === nonLexical);
}
{
  const editor = fakeEditor({ text: '' });
  const doc = fakeDoc([editor]);
  check('execCommand insertion is believed when the DOM changes', insertIntoComposer('hello', doc) === true);
  check('the text landed in the editor', editor.innerText === 'hello', JSON.stringify(editor.innerText));
  check('the editor was focused first', editor.focused >= 1);
}
{
  const editor = fakeEditor({ text: 'keep ' });
  check('replace selects everything first', insertIntoComposer('new', fakeDoc([editor]), true) === true && editor.innerText === 'new', JSON.stringify(editor.innerText));
}
{
  const editor = fakeEditor({ text: 'original' });
  const doc = fakeDoc([editor], { insertText: false });
  check('a command that changes nothing is not believed', insertIntoComposer('x', doc) === false);
  check('and the editor is left alone', editor.innerText === 'original');
}
{
  const editor = fakeEditor({ text: '', handlesEvents: true });
  const doc = fakeDoc([editor], { execCommand: 'none' });
  check('the synthetic beforeinput path inserts', insertIntoComposer('from-events', doc) === true);
  check('the editor applied the event', editor.innerText === 'from-events', JSON.stringify(editor.innerText));
}
{
  check('no editor means no insertion', insertIntoComposer('text', fakeDoc([])) === false);
  check('a missing document means no insertion', insertIntoComposer('text', null) === false);
}

console.log('');
console.log('insertion paths');
const pasteKeyboard = { snapshot: { draft: 'draft', phase: 'plain' }, paste: (text) => pastings.push(text) };
const draftActions = { setDraft: (text) => drafts.push(text) };
check('caret mode inserts through the composer paste command', placeText('text', { keyboard: pasteKeyboard, inputActions: draftActions }, 'caret') === 'caret' && pastings[0] === 'text');
check('replace mode swaps the whole draft', placeText('text', { keyboard: { snapshot: { draft: 'old', phase: 'plain' } }, inputActions: draftActions }, 'replace') === 'replace' && drafts[0] === 'text');
check('replace mode leaves the caret command alone', pastings.length === 1);
check('copy mode reports a copy', placeText('text', { keyboard: pasteKeyboard }, 'copy') === 'copy');
check('a submitting composer is not written into', placeText('text', { keyboard: { snapshot: { draft: 'old', phase: 'submitting' }, paste: (text) => pastings.push(text) }, inputActions: draftActions }, 'caret') === 'copy');
check('a missing handle reports a copy', placeText('text', {}, 'caret', null) === 'copy');
const appended = placeText('text', { keyboard: { snapshot: { draft: 'Existing text', phase: 'plain' } }, inputActions: draftActions }, 'caret');
check('a keyboard without paste appends through setDraft', appended === 'caret' && drafts[drafts.length - 1] === 'Existing text text', String(drafts[drafts.length - 1]));
{
  const editor = fakeEditor({ text: 'Dear ' });
  const doc = fakeDoc([editor]);
  check('with no handles at all the editor is written directly', placeText('world', {}, 'caret', doc) === 'dom');
  check('the text is in the editor', editor.innerText === 'Dear world', JSON.stringify(editor.innerText));
  const replaceEditor = fakeEditor({ text: 'throw this away' });
  check('replace mode falls back to the editor too', placeText('kept', {}, 'replace', fakeDoc([replaceEditor])) === 'dom' && replaceEditor.innerText === 'kept');
  check('a document without an editor still copies', placeText('text', {}, 'caret', fakeDoc([])) === 'copy');
}
check('drafts are read from the keyboard handle first', readDraftFrom({ keyboard: { snapshot: { draft: 'from-handle' } } }, fakeDoc([fakeEditor({ text: 'from-dom' })])) === 'from-handle');
check('drafts fall back to the editor', readDraftFrom({}, fakeDoc([fakeEditor({ text: 'from-dom' })])) === 'from-dom');

storage.set('dsh-stt.language', 'DE');
check('a language tag is normalised to lower case', readLanguage() === 'de', readLanguage());
storage.set('dsh-stt.language', 'english');
check('a non-tag language falls back to auto', readLanguage() === 'auto', readLanguage());
storage.delete('dsh-stt.language');
storage.set('dsh-stt.base', 'http://127.0.0.1:9000/');
check('a saved endpoint loses its trailing slash', readBase() === 'http://127.0.0.1:9000', readBase());
storage.delete('dsh-stt.base');
check('an empty endpoint falls back to the default', readBase() === DEFAULT_BASE, readBase());
storage.set('dsh-stt.silence', '-3');
check('a negative silence timeout clamps to zero', readSilence() === 0, String(readSilence()));
storage.set('dsh-stt.silence', '99');
check('an absurd silence timeout clamps to 30', readSilence() === 30, String(readSilence()));
storage.delete('dsh-stt.silence');
storage.set('dsh-stt.cap', '1');
check('a tiny recording cap clamps to 5', readCap() === 5, String(readCap()));
storage.delete('dsh-stt.cap');
storage.set('dsh-stt.device', '  dev-7  ');
check('a saved device is trimmed', readDevice() === 'dev-7', readDevice());
storage.delete('dsh-stt.device');

// ── test plumbing ────────────────────────────────────────────────────────────
const t = (key, vars) => {
  const template = en[key] ?? key;
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
};

/**
 * Build the slot props for a mount.
 * @param options - handle overrides.
 * @returns the props object.
 */
function props(options = {}) {
  const keyboard = options.keyboard === undefined
    ? { snapshot: { draft: '', phase: 'plain' }, paste: (text) => pastings.push(text) }
    : options.keyboard;
  const inputActions = options.inputActions === undefined ? { setDraft: (text) => drafts.push(text) } : options.inputActions;
  return { keyboard, inputActions, t };
}

const element = (options = {}) => jsx(exportsObject.SttButton, props(options));
const buttonIn = (tree) => findAll(tree, (node) => node.type === 'button' && typeof node.props?.['aria-label'] === 'string')[0];
const errorShown = (tree) => findAll(tree, (node) => String(node.props?.className ?? '').includes('dsh-stt--error')).length > 0;
const recordingShown = (tree) => findAll(tree, (node) => String(node.props?.className ?? '').includes('dsh-stt--recording')).length > 0;
const pillIn = (tree) => findAll(tree, (node) => node.props?.role === 'status')[0];
const pillText = (tree) => {
  const pill = pillIn(tree);
  return pill === undefined ? '' : strings(pill).join(' ');
};
/** The meter bars inside a subtree, as fill fractions. */
const barsIn = (node) => findAll(node, (child) => typeof child.props?.['data-fill'] === 'string').map((child) => Number(child.props['data-fill']));

/**
 * Right-click the button to open the settings panel.
 * @param tree - the current render tree.
 * @param options - mount option overrides.
 * @returns the dialog node.
 */
async function openPanel(tree, options = {}) {
  const menu = findAll(tree, (node) => typeof node.props?.onContextMenu === 'function')[0];
  menu.props.onContextMenu({ preventDefault: () => {} });
  const next = await runtime.flush(element(options));
  return findAll(next, (node) => node.props?.role === 'dialog')[0];
}

/**
 * Reset every stub and reload the bundle, so the component mounts fresh.
 * @param options - a fetch plan and/or handler.
 */
function reset({ plan = [], handler = null } = {}) {
  fetchCalls.length = 0;
  fetchPlan = plan;
  fetchHandler = handler;
  pastings.length = 0;
  drafts.length = 0;
  clipboardWrites.length = 0;
  timers.length = 0;
  trackStops.length = 0;
  rafHandles.clear();
  rafQueue.length = 0;
  rafNext = 0;
  analyser.level = 128;
  audioGraph.closed = 0;
  audioGraph.disconnects = 0;
  audioGraph.sources = 0;
  mediaPlan.calls = 0;
  mediaPlan.error = null;
  mediaPlan.constraints = [];
  mediaPlan.devices = null;
  mediaPlan.tracks = [{ stop: () => trackStops.push('a') }, { stop: () => trackStops.push('b') }];
  windowStub.navigator.clipboard.blocked = false;
  delete globalThis.document;
  FakeRecorder.reset();
  runtime = createRuntime();
  exportsObject = loadWith(runtime);
}

/** Run one frame of the level meter. */
function tickMeter(times = 1) {
  for (let index = 0; index < times; index += 1) {
    const id = rafQueue.shift();
    if (id === undefined) return;
    const fn = rafHandles.get(id);
    if (fn !== undefined) fn(Date.now());
  }
}

/** Run every pending timer that has not been cleared. */
function runTimers() {
  for (const timer of timers.filter((entry) => !entry.cleared)) timer.fn();
}

/**
 * Start a recording.
 * @param options - mount option overrides.
 * @returns the tree and the recorder instance.
 */
async function startRecording(options = {}) {
  let tree = runtime.mount(element(options));
  buttonIn(tree).props.onClick();
  tree = await runtime.flush(element(options));
  return { tree, recorder: FakeRecorder.instances[FakeRecorder.instances.length - 1] };
}

/**
 * Stop the recording that is running.
 * @param options - mount option overrides.
 * @param chunk - the data chunk to emit, or null for an empty recording.
 * @returns the final tree.
 */
async function stopRecording(options = {}, chunk = { type: 'audio/webm;codecs=opus', size: 2048 }) {
  let tree = runtime.mount(element(options));
  const recorder = FakeRecorder.instances[FakeRecorder.instances.length - 1];
  if (chunk !== null) recorder.emit(chunk);
  buttonIn(tree).props.onClick();
  return runtime.flush(element(options));
}

const transcriptResponse = (text, extra = {}) => ({
  ok: true,
  status: 200,
  body: { text, language: 'en', languageProbability: 0.98, duration: 2.4, elapsed: 0.6, realtimeFactor: 4, segments: [], ...extra },
});

/** Freeze the clock so elapsed-time behaviour is deterministic. */
async function withClock(run) {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    // `await`, so the clock stays frozen for the whole awaited body: restoring it
    // at return time would hand the real clock back to every pending continuation.
    return await run({
      advance(ms) {
        clock += ms;
      },
    });
  } finally {
    Date.now = realNow;
  }
}

// ── rendering ────────────────────────────────────────────────────────────────
console.log('');
console.log('rendering');
reset();
{
  const tree = runtime.mount(element());
  const button = buttonIn(tree);
  check('renders a microphone button', button !== undefined);
  check('the button carries an accessible name', button?.props['aria-label'] === en['action.record']);
  check('the button is not a submit button', button?.props.type === 'button');
  check('the button reports not-recording', button?.props['aria-pressed'] === false);
  check('the button reports collapsed state', button?.props['aria-expanded'] === false);
  check('no status pill while idle', pillIn(tree) === undefined);
  check('the panel is closed initially', findAll(tree, (node) => node.props?.role === 'dialog').length === 0);
  check('the stylesheet is injected once', findAll(tree, (node) => node.props?.['data-plugin-css'] === 'dsh-stt').length === 1);
  const css = findAll(tree, (node) => node.props?.['data-plugin-css'] === 'dsh-stt')[0]?.children;
  check('the stylesheet is namespaced', typeof css === 'string' && css.includes('.dsh-stt__trigger'));
  check('the stylesheet carries the meter styles', typeof css === 'string' && css.includes('.dsh-stt__bar') && css.includes('.dsh-stt__pill'));
  check('no network request on render', fetchCalls.length === 0);
  check('the microphone is not opened on render', mediaPlan.calls === 0);
}

reset();
{
  const tree = runtime.mount(element({ keyboard: null, inputActions: null }));
  check('no composer handles still renders', buttonIn(tree) !== undefined);
}

// ── dictation ────────────────────────────────────────────────────────────────
console.log('');
console.log('dictation');
reset({ plan: [transcriptResponse('  Hello   world. ')] });
{
  const { tree: started, recorder } = await startRecording();
  check('the microphone is opened on click', mediaPlan.calls === 1, String(mediaPlan.calls));
  check('the audio graph is created on the click gesture', audioGraph.sources === 1, String(audioGraph.sources));
  check('the recording constraints ask for speech processing', mediaPlan.constraints[0]?.audio?.channelCount === 1 && mediaPlan.constraints[0]?.audio?.echoCancellation === true, JSON.stringify(mediaPlan.constraints[0]));
  check('a recorder was constructed', recorder !== undefined);
  check('the container is one the browser supports', FakeRecorder.supported.includes(recorder?.mimeType), String(recorder?.mimeType));
  check('recording starts with a timeslice', recorder?.timeslice === 250, String(recorder?.timeslice));
  check('the button switches to Stop', buttonIn(started)?.props['aria-label'] === en['action.stop']);
  check('the button reports recording', buttonIn(started)?.props['aria-pressed'] === true);
  check('the recording style is applied', recordingShown(started));
  check('no request is made while recording', fetchCalls.length === 0);

  analyser.level = 200;
  tickMeter(3);
  const tree = await stopRecording();
  check('exactly one transcription request was made', fetchCalls.length === 1, String(fetchCalls.length));
  const call = fetchCalls[0];
  check('the request is a POST to /transcribe', call.options?.method === 'POST' && String(call.url).endsWith('/transcribe'), String(call.url));
  check('the request carries the recorded container', call.options.headers['x-dsh-stt-mime'] === 'audio/webm;codecs=opus', String(call.options.headers['x-dsh-stt-mime']));
  check('the request asks for auto language by default', call.options.headers['x-dsh-stt-language'] === 'auto', String(call.options.headers['x-dsh-stt-language']));
  check('the request asks for transcription', call.options.headers['x-dsh-stt-task'] === 'transcribe', String(call.options.headers['x-dsh-stt-task']));
  check('the request enables the silence filter', call.options.headers['x-dsh-stt-vad'] === '1', String(call.options.headers['x-dsh-stt-vad']));
  check('the body is the recorded blob', call.options.body instanceof FakeBlob && call.options.body.type === 'audio/webm;codecs=opus');
  check('the body keeps the recorded chunks', call.options.body.parts.length === 1, String(call.options.body.parts.length));
  check('the transcript is cleaned before insertion', pastings[0] === 'Hello world.', JSON.stringify(pastings));
  check('the microphone is released', trackStops.length === 2, String(trackStops.length));
  check('the audio graph is closed', audioGraph.closed === 1, String(audioGraph.closed));
  check('the button returns to idle', buttonIn(tree)?.props['aria-label'] === en['action.record']);
  check('the recording style is gone', !recordingShown(tree));
  check('no error state is shown', !errorShown(tree));
  check('the result is visible without opening the panel', pillText(tree).includes(en['status.inserted']), pillText(tree));
}

// ── the meter ────────────────────────────────────────────────────────────────
console.log('');
console.log('the meter');
reset();
{
  const { tree: started } = await withClock(async ({ advance }) => {
    const started = await startRecording();
    return started;
  });
  check('a status pill appears while recording', pillIn(started) !== undefined);
  check('the pill reports the recording state', strings(pillIn(started)).some((value) => value.includes(en['status.listening']) || value.includes('0:0')), pillText(started));
  check('the pill has level bars', barsIn(pillIn(started)).length >= 8, String(barsIn(pillIn(started)).length));
  check('the bars start dark', barsIn(pillIn(started)).every((fill) => fill === 0), JSON.stringify(barsIn(pillIn(started)).slice(0, 4)));
}
reset();
{
  await startRecording();
  analyser.level = 128;
  tickMeter(2);
  const quiet = barsIn(pillIn(await runtime.flush(element())));
  analyser.level = 150;
  tickMeter(2);
  const partial = barsIn(pillIn(await runtime.flush(element())));
  analyser.level = 210;
  tickMeter(2);
  const loud = barsIn(pillIn(await runtime.flush(element())));
  const total = (bars) => bars.reduce((sum, fill) => sum + fill, 0);
  check('the bars follow the input level', total(partial) > total(quiet) && total(loud) > total(partial), `${String(total(quiet))} -> ${String(total(partial))} -> ${String(total(loud))}`);
  check('speech-level input lights only the left of the meter', partial[0] === 1 && partial[partial.length - 1] === 0, JSON.stringify(partial));
  check('a very loud frame fills the meter', loud.every((fill) => fill === 1), JSON.stringify(loud));
}
reset();
{
  const { tree } = await withClock(async ({ advance }) => {
    const { tree: started } = await startRecording();
    advance(3200);
    analyser.level = 190;
    tickMeter(3);
    const next = await runtime.flush(element());
    return { tree: next ?? started };
  });
  check('the pill shows the elapsed time', pillText(tree).includes('0:03'), pillText(tree));
}
reset();
{
  const { tree } = await startRecording();
  const recorder = FakeRecorder.instances[0];
  recorder.emit({ type: 'audio/webm;codecs=opus', size: 4096 });
  const next = await runtime.flush(element());
  check('the pill reports how much audio it has captured', pillText(next).includes('KB'), pillText(next));
}
reset();
{
  await withClock(async ({ advance }) => {
    await startRecording();
    advance(4000);
    analyser.level = 128; // a dead or muted input
    tickMeter(3);
    return null;
  });
  const tree = await runtime.flush(element());
  check('a flat input is called out as no audio', pillText(tree).includes(en['note.silent']), pillText(tree));
  check('the warning is styled as a warning', findAll(tree, (node) => String(node.props?.className ?? '').includes('dsh-stt__pill--warn')).length === 1);
}
reset();
{
  await startRecording();
  await withClock(async ({ advance }) => {
    advance(4000);
    analyser.level = 128;
    tickMeter(2);
  });
  const warned = await runtime.flush(element());
  check('the warning is visible while the input is dead', pillText(warned).includes(en['note.silent']));
  analyser.level = 205;
  tickMeter(3);
  const recovered = await runtime.flush(element());
  check('the warning clears when audio arrives', !pillText(recovered).includes(en['note.silent']), pillText(recovered));
}
reset();
{
  // A browser that provides no AudioContext at all: recording must still work,
  // and the UI has to say why the meter is missing.
  const ctor = windowStub.AudioContext;
  delete windowStub.AudioContext;
  const { tree, recorder } = await startRecording();
  check('a meter-less browser still records', recorder?.state === 'recording');
  check('the missing meter is explained', pillText(tree).includes(en['note.meterUnavailable']), pillText(tree));
  await stopRecording({}, null);
  check('the stream is closed even without a meter', trackStops.length === 2, String(trackStops.length));
  windowStub.AudioContext = ctor;
}

// ── test mode ────────────────────────────────────────────────────────────────
console.log('');
console.log('microphone test mode');
reset({ plan: [{ ok: true, status: 200, body: { status: 'ready', model: 'faster-whisper base', device: 'cpu' } }] });
{
  let tree = runtime.mount(element());
  const dialog = await openPanel(tree);
  const testButton = findAll(dialog, (node) => node.type === 'button' && strings(node).includes(en['panel.test']))[0];
  check('the panel offers a microphone test', testButton !== undefined);
  testButton.props.onClick();
  tree = await runtime.flush(element());
  check('the test opens the microphone', mediaPlan.calls === 1, String(mediaPlan.calls));
  check('the test records nothing', FakeRecorder.instances.length === 0, String(FakeRecorder.instances.length));
  check('the test shows a meter', pillIn(tree) !== undefined && barsIn(pillIn(tree)).length >= 8);
  check('the button offers to stop the test', buttonIn(tree)?.props['aria-label'] === en['action.stopTest'], String(buttonIn(tree)?.props['aria-label']));

  analyser.level = 210;
  tickMeter(3);
  tree = await runtime.flush(element());
  const loudSum = barsIn(pillIn(tree)).reduce((sum, fill) => sum + fill, 0);
  check('the test meter follows the input', loudSum > 0, String(loudSum));
  check('the panel meter marks a peak', findAll(tree, (node) => String(node.props?.className ?? '').includes('dsh-stt__meterPeak')).length === 1);
  check('the panel meter shows a dB figure', strings(tree).some((value) => value.endsWith(' dB')), strings(tree).filter((value) => value.includes('dB')).join(','));

  buttonIn(tree).props.onClick(); // stop the test
  tree = await runtime.flush(element());
  check('stopping the test releases the microphone', trackStops.length === 2, String(trackStops.length));
  check('stopping the test returns to idle', buttonIn(tree)?.props['aria-label'] === en['action.record']);
  check('stopping the test transcribes nothing', fetchCalls.filter((call) => String(call.url).endsWith('/transcribe')).length === 0, String(fetchCalls.length));
}

// ── empty, silent and speechless clips ───────────────────────────────────────
console.log('');
console.log('clips with nothing in them');
reset();
{
  await startRecording();
  const tree = await stopRecording({}, null);
  check('an empty recording makes no request', fetchCalls.length === 0, String(fetchCalls.length));
  check('an empty recording shows the error state', errorShown(tree));
  check('a silent microphone is blamed, not the recogniser', pillText(tree).includes(en['error.silentMic']), pillText(tree));
}
reset();
{
  await startRecording();
  analyser.level = 200; // there was audio, but no data arrived
  tickMeter(2);
  await runtime.flush(element());
  const tree = await stopRecording({}, null);
  check('a silent recorder with real input is reported as empty', pillText(tree).includes(en['error.emptyRecording']), pillText(tree));
}
reset({ plan: [transcriptResponse('   ')] });
{
  await startRecording();
  analyser.level = 200;
  tickMeter(2);
  await runtime.flush(element());
  const tree = await stopRecording();
  check('a clip with no speech makes one request', fetchCalls.length === 1, String(fetchCalls.length));
  check('no empty text is inserted', pastings.length === 0, JSON.stringify(pastings));
  check('a speechless clip with audio is reported as no speech', pillText(tree).includes(en['error.noSpeech']), pillText(tree));
}

// ── failure and cancellation paths ───────────────────────────────────────────
console.log('');
console.log('failures');
reset({ handler: async () => { throw new Error('ECONNREFUSED'); } });
{
  await startRecording();
  const tree = await stopRecording();
  check('an unreachable sidecar shows the error state', errorShown(tree));
  check('the failure asks for the sidecar health', fetchCalls.some((call) => String(call.url).endsWith('/health')));
  check('the failure is visible without opening the panel', pillText(tree).includes(en['error.offline']), pillText(tree));
}

reset();
{
  mediaPlan.error = new Error('Permission denied');
  let tree = runtime.mount(element());
  buttonIn(tree).props.onClick();
  tree = await runtime.flush(element());
  check('a refused microphone shows the error state', errorShown(tree));
  check('a refused microphone uploads nothing', fetchCalls.filter((call) => String(call.url).endsWith('/transcribe')).length === 0);
  check('the refusal explains the permission', pillText(tree).includes(en['error.permission']), pillText(tree));
}

reset();
{
  const recorder = windowStub.MediaRecorder;
  delete windowStub.MediaRecorder;
  let tree = runtime.mount(element());
  buttonIn(tree).props.onClick();
  tree = await runtime.flush(element());
  check('a browser without MediaRecorder shows the error state', errorShown(tree));
  check('the unsupported browser is explained', pillText(tree).includes(en['error.unsupported']), pillText(tree));
  windowStub.MediaRecorder = recorder;
}

reset({ handler: () => new Promise(() => {}) });
{
  const { tree: started } = await startRecording();
  FakeRecorder.instances[0].emit({ type: 'audio/webm;codecs=opus', size: 512 });
  buttonIn(started).props.onClick(); // stop
  let tree = await runtime.flush(element());
  check('the button offers Cancel while transcribing', buttonIn(tree)?.props['aria-label'] === en['action.cancel']);
  const signal = fetchCalls[0]?.options?.signal;
  buttonIn(tree).props.onClick(); // cancel
  tree = await runtime.flush(element());
  check('cancelling aborts the request', signal?.aborted === true);
  check('cancelling returns the button to idle', buttonIn(tree)?.props['aria-label'] === en['action.record']);
  check('cancelling inserts nothing', pastings.length === 0, JSON.stringify(pastings));
}

// ── automatic stopping ───────────────────────────────────────────────────────
console.log('');
console.log('automatic stop');
reset({ plan: [transcriptResponse('Capped dictation.')] });
{
  const { recorder } = await startRecording();
  check('the recording cap timer is armed for the default 120s', timers[0]?.ms === 120000, String(timers[0]?.ms));
  recorder.emit({ type: 'audio/webm;codecs=opus', size: 4096 });
  runTimers();
  const tree = await runtime.flush(element());
  check('the cap ends the recording without a click', recorder?.state === 'inactive');
  check('the capped recording is still transcribed', fetchCalls.length === 1, String(fetchCalls.length));
  check('the capped transcript lands in the composer', pastings[0] === 'Capped dictation.', JSON.stringify(pastings));
}

storage.set('dsh-stt.silence', '1');
reset({ plan: [transcriptResponse('Silence then speech.')] });
{
  const { recorder } = await startRecording();
  check('the meter is running while recording', rafQueue.length === 1, String(rafQueue.length));
  recorder.emit({ type: 'audio/webm;codecs=opus', size: 4096 });
  await withClock(async ({ advance }) => {
    analyser.level = 200;
    tickMeter(2);
    check('a loud frame is not silence', recorder?.state === 'recording');
    // The silence timer only counts after the warn window, so advance past it.
    advance(3000);
    analyser.level = 128;
    tickMeter(1);
    check('a silent frame does not stop the recording immediately', recorder?.state === 'recording');
    advance(1500);
    tickMeter(1);
    check('a sustained silence stops the recording', recorder?.state === 'inactive');
  });
  const tree = await runtime.flush(element());
  check('the silent recording is still transcribed', fetchCalls.length === 1, String(fetchCalls.length));
  check('the silent recording lands in the composer', pastings[0] === 'Silence then speech.', JSON.stringify(pastings));
  check('the meter is torn down after the auto-stop', audioGraph.closed === 1, String(audioGraph.closed));
  storage.delete('dsh-stt.silence');
}

// ── panel ────────────────────────────────────────────────────────────────────
console.log('');
console.log('panel');
reset({ plan: [{ ok: true, status: 200, body: { status: 'ready', model: 'faster-whisper base', device: 'cpu', cache: 'C:\\plugins\\stt\\.models' } }] });
{
  let tree = runtime.mount(element());
  const dialog = await openPanel(tree);
  check('the panel renders as a dialog', dialog !== undefined);
  check('the panel checks the engine on open', fetchCalls.some((call) => String(call.url).endsWith('/health')));
  const labels = strings(dialog);
  check('the panel names the engine state', labels.some((value) => value.includes('Ready') || value.includes('Sidecar')));
  check('the panel offers an endpoint field', findAll(dialog, (node) => node.type === 'input' && node.props.value === DEFAULT_BASE).length === 1);
  check('the panel offers a language field', findAll(dialog, (node) => node.type === 'input' && node.props.placeholder === en['panel.languageHint']).length === 1);
  check('the panel offers a task selector', findAll(dialog, (node) => node.type === 'select' && node.props.value === 'transcribe').length === 1);
  check('the panel offers the three insertion modes', ['caret', 'replace', 'copy'].every((value) => findAll(dialog, (node) => node.type === 'option' && node.props.value === value).length === 1));
  check('the panel offers a silence timeout', findAll(dialog, (node) => node.type === 'input' && node.props.type === 'number' && node.props.min === '0').length === 1);
  check('the panel offers a recording cap', findAll(dialog, (node) => node.type === 'input' && node.props.type === 'number' && node.props.min === '5').length === 1);
  check('the panel offers the silence filter toggle', findAll(dialog, (node) => node.type === 'input' && node.props.type === 'checkbox').length === 1);
  check('the panel offers a transcript box', findAll(dialog, (node) => node.type === 'textarea' && node.props.readOnly === true).length === 1);
  check('the panel offers a save button', findAll(dialog, (node) => node.type === 'button').some((node) => strings(node).includes(en['panel.save'])));
  check('the panel offers an input-device picker', findAll(dialog, (node) => node.type === 'select' && findAll(node, (child) => child.type === 'option' && child.props.value === '').length === 1).length === 1);
  check('the panel shows a level meter', findAll(dialog, (node) => node.props?.role === 'meter').length === 1);
  check('the meter reports its value', findAll(dialog, (node) => node.props?.role === 'meter')[0]?.props['aria-valuenow'] === 0);
  check('the panel names the diagnostics', labels.includes(en['panel.diagnostics']));
  check('the diagnostics report the composer handles', labels.some((value) => value.includes('keyboard.paste') || value.includes(en['panel.diagHandlesNo'])), labels.join(' | ').slice(0, 200));
  check('the diagnostics report the weights path', labels.some((value) => value.includes('.models')));

  const languageInput = findAll(dialog, (node) => node.type === 'input' && node.props.placeholder === en['panel.languageHint'])[0];
  const modeSelect = findAll(dialog, (node) => node.type === 'select' && node.props.value === 'caret')[0];
  const silenceInput = findAll(dialog, (node) => node.type === 'input' && node.props.type === 'number' && node.props.min === '0')[0];
  const capInput = findAll(dialog, (node) => node.type === 'input' && node.props.type === 'number' && node.props.min === '5')[0];
  const vadInput = findAll(dialog, (node) => node.type === 'input' && node.props.type === 'checkbox')[0];
  languageInput.props.onChange({ target: { value: 'de' } });
  modeSelect.props.onChange({ target: { value: 'copy' } });
  silenceInput.props.onChange({ target: { value: '2.5' } });
  capInput.props.onChange({ target: { value: '300' } });
  vadInput.props.onChange({ target: { checked: false } });
  tree = await runtime.flush(element());
  const saveButton = findAll(findAll(tree, (node) => node.props?.role === 'dialog')[0], (node) => node.type === 'button' && strings(node).includes(en['panel.save']))[0];
  saveButton.props.onClick();
  tree = await runtime.flush(element());
  check('saving stores the language', storage.get('dsh-stt.language') === 'de', String(storage.get('dsh-stt.language')));
  check('saving stores the insertion mode', storage.get('dsh-stt.mode') === 'copy', String(storage.get('dsh-stt.mode')));
  check('saving stores the silence timeout', storage.get('dsh-stt.silence') === '2.5', String(storage.get('dsh-stt.silence')));
  check('saving stores the recording cap', storage.get('dsh-stt.cap') === '300', String(storage.get('dsh-stt.cap')));
  check('saving stores the silence filter', storage.get('dsh-stt.vad') === '0', String(storage.get('dsh-stt.vad')));

  const closeButton = findAll(findAll(tree, (node) => node.props?.role === 'dialog')[0], (node) => node.type === 'button' && strings(node).includes(en['panel.close']))[0];
  closeButton.props.onClick();
  tree = await runtime.flush(element());
  check('closing removes the panel', findAll(tree, (node) => node.props?.role === 'dialog').length === 0);
  for (const key of ['dsh-stt.language', 'dsh-stt.mode', 'dsh-stt.silence', 'dsh-stt.cap', 'dsh-stt.vad']) storage.delete(key);
}

console.log('');
console.log('input device');
reset({ plan: [{ ok: true, status: 200, body: { status: 'ready', model: 'faster-whisper base' } }] });
{
  mediaPlan.devices = [
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Headset mic' },
    { kind: 'audiooutput', deviceId: 'spk-1', label: 'Speakers' },
    { kind: 'audioinput', deviceId: 'mic-2', label: '' },
  ];
  const tree = runtime.mount(element());
  await openPanel(tree);
  // One more render, so the asynchronous device enumeration has landed.
  const dialog = findAll(await runtime.flush(element()), (node) => node.props?.role === 'dialog')[0];
  const options = findAll(dialog, (node) => node.type === 'option');
  check('the picker lists the system default', options.some((node) => node.props.value === ''));
  check('the picker lists the real inputs', options.some((node) => node.props.value === 'mic-1') && options.some((node) => node.props.value === 'mic-2'), JSON.stringify(options.map((node) => node.props.value)));
  check('output devices are not offered', !options.some((node) => node.props.value === 'spk-1'));
  check('an unlabelled input gets a placeholder', options.some((node) => String(strings(node)).includes('Input 2')));

  const select = findAll(dialog, (node) => node.type === 'select' && findAll(node, (child) => child.type === 'option' && child.props.value === '').length === 1)[0];
  select.props.onChange({ target: { value: 'mic-2' } });
  const next = await runtime.flush(element());
  const saveButton = findAll(findAll(next, (node) => node.props?.role === 'dialog')[0], (node) => node.type === 'button' && strings(node).includes(en['panel.save']))[0];
  saveButton.props.onClick();
  await runtime.flush(element());
  check('saving stores the chosen device', storage.get('dsh-stt.device') === 'mic-2', String(storage.get('dsh-stt.device')));
  storage.delete('dsh-stt.device');
}
storage.set('dsh-stt.device', 'mic-9');
reset();
{
  await withClock(async () => {
    await startRecording();
    return null;
  });
  check('the saved device is requested exactly', mediaPlan.constraints[0]?.audio?.deviceId?.exact === 'mic-9', JSON.stringify(mediaPlan.constraints[0]));
  storage.delete('dsh-stt.device');
}

// ── insertion modes, end to end ──────────────────────────────────────────────
console.log('');
console.log('insertion modes and clipboard');
storage.set('dsh-stt.mode', 'copy');
reset({ plan: [transcriptResponse('Insert me.')] });
{
  await startRecording();
  const tree = await stopRecording();
  check('copy mode writes to the clipboard', clipboardWrites[0] === 'Insert me.', JSON.stringify(clipboardWrites));
  check('copy mode leaves the composer alone', pastings.length === 0 && drafts.length === 0, JSON.stringify(pastings));
  check('copy mode says so next to the button', pillText(tree).includes(en['status.copied']), pillText(tree));
}
storage.delete('dsh-stt.mode');

storage.set('dsh-stt.mode', 'replace');
reset({ plan: [transcriptResponse('Replacement text.')] });
{
  await startRecording();
  const tree = await stopRecording();
  check('replace mode swaps the draft', drafts[0] === 'Replacement text.' && pastings.length === 0, JSON.stringify(drafts));
  check('replace mode says so next to the button', pillText(tree).includes(en['status.replaced']), pillText(tree));
}
storage.delete('dsh-stt.mode');

reset({ plan: [transcriptResponse('Insert me.')] });
{
  const busy = { keyboard: { snapshot: { draft: 'old', phase: 'submitting' }, paste: (text) => pastings.push(text) } };
  await startRecording(busy);
  await stopRecording(busy);
  check('a busy composer is never written into', pastings.length === 0 && drafts.length === 0);
  check('a busy composer copies instead', clipboardWrites[0] === 'Insert me.', JSON.stringify(clipboardWrites));
}

console.log('');
console.log('editor fallback, end to end');
reset({ plan: [transcriptResponse('Dictated into the editor.')] });
{
  // No slot handles at all, the situation the diagnostics exist to expose.
  const editor = fakeEditor({ text: 'Dear ' });
  const doc = fakeDoc([editor]);
  doc.defaultView = { InputEvent: FakeInputEvent };
  globalThis.document = doc;
  const plain = { keyboard: null, inputActions: null };
  await startRecording(plain);
  analyser.level = 200;
  tickMeter(2);
  await runtime.flush(element(plain));
  const tree = await stopRecording(plain);
  check('the transcript reaches the real editor', editor.innerText === 'Dear Dictated into the editor.', JSON.stringify(editor.innerText));
  check('the editor path is reported next to the button', pillText(tree).includes(en['status.domInserted']), pillText(tree));
  const dialog = await openPanel(tree, plain);
  check('the diagnostics name the editor fallback', strings(dialog).some((value) => value.includes(en['panel.diagHandlesNo'])), strings(dialog).slice(0, 8).join(' | '));
  check('the diagnostics name the insert path', strings(dialog).some((value) => value.includes(en['status.domInserted'])));
}

reset({ plan: [transcriptResponse('Insert me.')] });
{
  const { tree: started } = await startRecording();
  // Opening the panel probes /health first, then the clip is transcribed: two
  // responses, in that order.
  fetchPlan = [{ ok: true, status: 200, body: { status: 'ready', model: 'faster-whisper base', device: 'cpu' } }, transcriptResponse('Insert me.')];
  const tree = await runtime.mount(element());
  const dialog = await openPanel(tree);
  check('the transcript box is empty before any dictation', findAll(dialog, (node) => node.type === 'textarea' && node.props.value === '').length === 1);
  FakeRecorder.instances[0].emit({ type: 'audio/webm;codecs=opus', size: 256 });
  buttonIn(started).props.onClick();
  const after = await runtime.flush(element());
  const panel = findAll(after, (node) => node.props?.role === 'dialog')[0];
  check('the panel stays open while the clip is transcribed', panel !== undefined);
  check('the panel keeps the last transcript', findAll(panel, (node) => node.type === 'textarea' && node.props.value === 'Insert me.').length === 1, JSON.stringify(strings(panel).slice(0, 6)));
  check('the diagnostics report the last request', strings(panel).some((value) => value.includes('HTTP 200')), strings(panel).filter((value) => value.includes('HTTP')).join(','));
  const copyButton = findAll(panel, (node) => node.type === 'button' && strings(node).includes(en['panel.copy']))[0];
  copyButton.props.onClick();
  await runtime.flush(element());
  check('the panel copy button copies the transcript', clipboardWrites[0] === 'Insert me.', JSON.stringify(clipboardWrites));
}

console.log('');
if (failures === 0) {
  console.log(`all checks passed (${String(checks)})`);
  process.exit(0);
}
console.log(`${String(failures)} of ${String(checks)} check(s) failed`);
process.exit(1);
