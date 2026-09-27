# dsh-sound-alerts

Notification sounds for the DSH Web GUI. Two cues, one header control:

- a cue when a **final response completes** — the agent handed the conversation back;
- a cue when **your input is needed** — an approval request or a question is waiting.

Either cue can also keep reminding: it replays on an interval — one minute by
default — until you respond, so a cue that fires while you are away from the desk
does not go unheard. The speaker button sits in the session header utilities and
opens a panel that customizes all of it.

## The control

| Control | What it does |
|---|---|
| Speaker button | Shows whether alerts are armed; click to open the panel |
| Enable alert sounds | Master switch. Off silences both cues but keeps the setup |
| Volume | 0–100%, applied to every cue (default 50%) |
| Minimum turn length | Turns shorter than this stay silent (ms, default 1000). The floor keeps a rejected or empty turn from beeping |
| Per cue: Sound | `Silent`, `Chime`, `Ping`, `Drop`, `Blip`, `Double`, `Pulse` |
| Per cue: Repeat / Gap | How many times the cue plays (1–5), and the spacing between repeats (ms) |
| Per cue: Repeat until you respond | Replays the cue on an interval while the request is unanswered. On for "your input is needed", off for a completed turn |
| Per cue: Every (sec) | The reminder interval in seconds (10–600, default 60) |
| Test | Plays exactly what that cue will play, even while alerts are off |
| Reset | Restores the defaults |

Defaults are deliberately audible: a completion `Chime` once, and a `Ping`
twice for "your input is needed", reminding once a minute until you answer.

The button dims to a crossed-out speaker when alerts are off, and flashes in the
success color while a cue plays.

Preferences are stored in **this browser** (`localStorage`, key
`dsh-sound-alerts.settings.v1`) and survive a reload. They are deliberately not
host-backed: a preference about this machine's speakers belongs to this browser,
and the host needs no settings namespace for the plugin to work. A stale,
truncated, or hand-edited payload is normalized field by field on load, so it can
never produce an unusable configuration. The reminder fields were added to that
same document without changing its version: a payload written before they existed
simply lacks them and picks up the defaults.

## Repeating until you respond

A single cue is easy to miss if you have left the machine, which is exactly when a
notification matters. So each cue can *remind*: after the cue plays, it replays
every `remindMs` (a minute by default) for as long as the thing it announced is
still waiting on you.

What ends the loop is the interesting part, and it is different per cue:

| Cue | Reminds while | Stops when |
|---|---|---|
| Your input is needed | the Session has a pending interaction | you answer it — the interaction's `key` clears (or is replaced, which starts a fresh loop) |
| Final response completed | the turn has finished | you reply — the Session's `running` flag rises again |

Nothing else is needed to end it: `play` is handed a silenced copy of the settings
when the master switch is off or the volume is at zero, so switching alerts off
mid-wait silences the next repetition too, and the interval is re-read on every
tick rather than captured, so dragging it takes effect on the next repeat instead
of restarting the count. A Session switch, an unmount, or flipping the reminder
switch off clears the one outstanding timer immediately.

The loop is one `setTimeout` chain rather than `setInterval`, so a slow or
throttled background tab cannot stack repetitions on top of each other — a
browser that throttles a hidden tab to one timer per minute lands exactly on the
default interval.

## What it listens to

Both triggers come from state the shell already maintains, so the plugin watches
no transport, subscribes to no event bus, and sends no requests.

| Cue | Signal | Guard |
|---|---|---|
| Final response completed | `useSession(snapshot => snapshot.running)` falls true → false | The flag must have been observed true, so a session that merely mounts idle or pages in history never cues. The turn must also outlast `minTurnMs` |
| Your input is needed | `useSessionPendingInteraction(snapshot => snapshot.get(sessionId))` gains a value | Keyed on the interaction's `key`, so one request cues once however often React re-renders, while a replacement request cues again |

Switching sessions resets the edge memory, so navigation cannot look like a
completion. The reminder above adds no new subscription either: it is one timer
armed by the same effect that played the cue, and disarmed by the same effect's
cleanup.

## How it loads

The package is a **bundle**: `package.json` declares `dsh.bundle.patch`, so DSH
applies [`cordis.patch.yml`](./cordis.patch.yml) as a configuration layer when the
package is listed in the profile's `dsh.profile.bundles`. That layer's only job is
to mount this package, and it also carries the browser half:

- `cordis.patch.yml` — the layer. One row: `- id: sound-alerts` /
  `name: dsh-sound-alerts`.
- `lib/index.js` — the host half. Empty `apply`; it exists so the package is a
  well-formed Cordis Loader entry.
- `lib/client.js` — the browser half, discovered through this package's own
  `dsh.client` declaration and served at `/plugins/dsh-sound-alerts/client.js`.
  It is plain script-form JavaScript (`window.__ModuleLoader__.load({ id, factory })`),
  so no build step is involved: the bundle is served as-is from disk.
- `package.json` — declares `exports["./client"]` alongside `dsh.client`
  (`platform: web`, `immediately: true`, plus an `inject` edge onto
  `dsh-client-ui-conversation`, which declares the header slot).

The client half registers one occupant into
`conversation.session.header.utilities` at `order: 4`, and registers its
`sound-alerts` locale namespace with English and Simplified Chinese dictionaries.

## Installing it

```sh
dsh plugin --profile web add "github:ExcitedHumvee/Harness-Plugins#path:/sound-alerts"
```

Then **restart DSH** (`dsh web`) and reload the page. A bundle is composed at
boot, so unlike a profile patch-file edit it is not picked up by
`patchReload: live`.

`dsh plugin` forwards to pnpm in the profile directory, so pnpm must be on PATH
(`corepack enable pnpm`). On Windows, install from a path without spaces — DSH
forwards the argument through `cmd.exe`, which splits it.

To remove it, run the inverse and restart:

```sh
dsh plugin --profile web remove dsh-sound-alerts
```

### While editing this package

`dsh plugin` links the checkout, so a client-half edit needs only
`dsh plugin --profile web add <path>` again plus a page reload — the browser
fetches the bundle by content revision. A host-half edit needs a restart, because
the row's module is cached by the ESM loader.

`node install.mjs --wire` (from the repository root) mounts the host entry by
`file:` URL instead, which *is* covered by `patchReload: live`. It is the faster
loop for host-half work and not a distribution form.

## Verifying

```sh
node --check lib/client.js     # parses
node verify-client.mjs         # behavioural checks, no browser required
```

`verify-client.mjs` evaluates `lib/client.js` itself against a stubbed
`window.__ModuleLoader__`, a minimal React hook dispatcher (state, refs, memo,
callbacks, effects with dependency comparison and cleanup), a recording Web Audio
stub, a `localStorage` stub, a DOM stub, and a controllable clock standing
in for `window.setTimeout`. It asserts the whole surface: the slot registration,
both dictionaries staying key-complete, the panel's controls and their stored
values, the completion edge and its guards, the input-needed edge and its keying,
customization and persistence, the reminder loop — that it waits out its interval,
repeats, and stops on an answer, on a reply, on a Session switch, and when it is
switched off, muted, or floored — the test button, reset, and seven malformed
stored payloads.

The clock is what makes the reminder testable: a real timer would cost a minute
per repetition, and "nothing replays before the interval elapses" would be
unassertable.

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
