# dsh-sound-alerts

Notification sounds for the DSH Web GUI. Two cues, one header control:

- a cue when a **final response completes** — the agent handed the conversation back;
- a cue when **your input is needed** — an approval request or a question is waiting.

The speaker button sits in the session header utilities and opens a panel that
customizes both cues.

## The control

| Control | What it does |
|---|---|
| Speaker button | Shows whether alerts are armed; click to open the panel |
| Enable alert sounds | Master switch. Off silences both cues but keeps the setup |
| Volume | 0–100%, applied to every cue (default 50%) |
| Minimum turn length | Turns shorter than this stay silent (ms, default 1000). The floor keeps a rejected or empty turn from beeping |
| Per cue: Sound | `Silent`, `Chime`, `Ping`, `Drop`, `Blip`, `Double`, `Pulse` |
| Per cue: Repeat / Gap | How many times the cue plays (1–5), and the spacing between repeats (ms) |
| Test | Plays exactly what that cue will play, even while alerts are off |
| Reset | Restores the defaults |

Defaults are deliberately audible: a completion `Chime` once, and a `Ping`
twice for "your input is needed".

The button dims to a crossed-out speaker when alerts are off, and flashes in the
success color while a cue plays.

Preferences are stored in **this browser** (`localStorage`, key
`dsh-sound-alerts.settings.v1`) and survive a reload. They are deliberately not
host-backed: a preference about this machine's speakers belongs to this browser,
and the host needs no settings namespace for the plugin to work. A stale,
truncated, or hand-edited payload is normalized field by field on load, so it can
never produce an unusable configuration.

## What it listens to

Both triggers come from state the shell already maintains, so the plugin watches
no transport, subscribes to no event bus, and sends no requests.

| Cue | Signal | Guard |
|---|---|---|
| Final response completed | `useSession(snapshot => snapshot.running)` falls true → false | The flag must have been observed true, so a session that merely mounts idle or pages in history never cues. The turn must also outlast `minTurnMs` |
| Your input is needed | `useSessionPendingInteraction(snapshot => snapshot.get(sessionId))` gains a value | Keyed on the interaction's `key`, so one request cues once however often React re-renders, while a replacement request cues again |

Switching sessions resets the edge memory, so navigation cannot look like a
completion.

## How it loads

The package is dual-face, the standard DSH client-plugin shape:

- `lib/index.js` — the host half. Empty `apply`; it exists so the package is a
  well-formed Cordis Loader entry and therefore appears in the entry scan that
  composes `window.__DSH_BOOT__`.
- `lib/client.js` — the browser half, discovered through this package's own
  `dsh.client` declaration. It is plain script-form JavaScript
  (`window.__ModuleLoader__.load({ id, factory })`), so no build step is
  involved: the bundle is served as-is from disk.
- `package.json` — declares `exports["./client"]` and `dsh.client`
  (`platform: web`, `immediately: true`, plus an `inject` edge onto
  `dsh-client-ui-conversation`, which declares the header slot).

The client half registers one occupant into
`conversation.session.header.utilities` at `order: 4`, and registers its
`sound-alerts` locale namespace with English and Simplified Chinese dictionaries.

## Installing it

From the repository root, `node install.mjs` adds this row to
`$DSH_HOME/profiles/web/cordis.patch.yml` — with the real absolute path of the
checkout in place of `<repo>`:

```yaml
- insert:
    - id: sound-alerts
      name: file:///<repo>/sound-alerts/lib/index.js
```

The plugin is referenced by a `file:` URL, so there is no install step and no
`node_modules` entry. Profiles with `patchReload: live` (the default for `web`)
apply the change without a server restart; reload the page so the browser
re-reads the boot graph. Remove the row (`node install.mjs --uninstall`) to turn
the alerts off.

## Verifying

```sh
node --check lib/client.js     # parses
node verify-client.mjs         # behavioural checks, no browser required
```

`verify-client.mjs` evaluates `lib/client.js` itself against a stubbed
`window.__ModuleLoader__`, a minimal React hook dispatcher (state, refs, memo,
callbacks, effects with dependency comparison and cleanup), a recording Web Audio
stub, a `localStorage` stub, and a DOM stub. It asserts the whole surface: the
slot registration, both dictionaries staying key-complete, the panel's controls
and their stored values, the completion edge and its guards, the input-needed
edge and its keying, customization and persistence, the test button, reset, and
six malformed stored payloads.

## Sound, without audio files

Every cue is synthesized with the Web Audio API from a small recipe of notes, so
the plugin ships no assets, works offline, and fades cleanly. A recipe is a list
of notes with individual offsets, which is why `Chime` can be a falling two-note
interval rather than one repeated blip.

Two consequences of the browser's autoplay rule are handled explicitly:

- the `AudioContext` is created at the **first cue**, not at load, and resumed
  opportunistically — a cue fired before the page has seen a gesture may be
  dropped by the browser, which is the correct outcome rather than a stalled UI;
- `play` is wrapped so a missing audio stack, a torn-down context, or a policy
  rejection can never break the conversation.

## Moving it

The occupant is placement-independent: change the `name` and `id` in
`ctx.slots.register(...)` inside `lib/client.js` to any declared slot. Nearby
options:

| Slot | Result |
|---|---|
| `conversation.session.header.utilities` | current: speaker button beside the header utilities |
| `conversation.session.header.actions` | title-adjacent, next to the job list |
| `conversation.composer.dock` | full-width strip below the composer card |

The `id` used in the slot registration is `sound-alerts`, which is what the
panel's state and the profile row id follow. The npm package name is
`dsh-sound-alerts`; both are fine to keep as they are.
