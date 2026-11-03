# Prompt History

Terminal-style history for the message composer. Press <kbd>↑</kbd> at the
start of the line — or with an empty box — to bring back what you sent before,
and keep pressing to walk further back. <kbd>↓</kbd> walks forward and, past the
newest entry, puts your unsent draft back exactly as it was.

It is a **bundle with a browser half**: the Host half is empty, and all of the
work happens in the page against data the conversation already has.

## Using it

| You do this | What happens |
|---|---|
| <kbd>↑</kbd> in an empty box | The newest prompt or slash command sent in this session appears |
| <kbd>↑</kbd> with the caret at the very start of a draft | The draft is saved and the newest entry replaces it |
| <kbd>↑</kbd> again | Steps further back through history |
| <kbd>↑</kbd> at the oldest entry | Nothing changes; the key is consumed, as a shell does at the top of its history |
| <kbd>↓</kbd> after a recall | Steps forward; at the newest entry it restores the draft you started with and ends recall |
| <kbd>↓</kbd> when no recall is active | Ordinary caret movement — untouched |
| <kbd>↑</kbd>/<kbd>↓</kbd> with the caret inside the line | Ordinary caret movement — untouched |

The rule is deliberately the one a shell uses: recall only *starts* at the far
left (or in an empty box), but once it is active the two arrows keep cycling
from any caret position. That is what lets you press <kbd>↑</kbd> three times in
a row without first moving the caret back to the start of the text it just put
in the box.

While a slash-command or `@`-mention menu is open, the arrows belong to the menu,
so recall stays out of the way. The same is true while the composer is locked by
a submission, during IME composition, and for the modified chords
(<kbd>Shift</kbd>, <kbd>Alt</kbd>, <kbd>Ctrl</kbd>, or <kbd>Cmd</kbd>).

## What counts as history

- Messages you sent in this session.
- Messages queued or steered into a running turn.
- Slash commands, rebuilt as the line you typed (`/goal ship it`).
- Local submissions that are still in flight, so <kbd>↑</kbd> works the instant
  you press Enter rather than after the round-trip.

Assistant answers, tool calls and their output, injected context, and command
results are not history. Consecutive duplicates collapse into one entry, so
re-sending the same line twice does not cost two identical <kbd>↑</kbd> presses
to get past it.

History is scoped to the session you are in, and it is **derived, not stored**:
the plugin reads the conversation the page has already loaded, the composer's
queued messages, and the Session's pending submissions. It writes nothing to the
session log, to settings, or to `localStorage`. That also means it survives a
reload for free.

## What it does not change

- It does not submit anything, edit the session, or add a tool.
- It does not touch the sidebar's session search box; the composer is the only
  input it listens to.
- Restoring a draft that contained `@file` / `@session` chips brings back their
  text, not the structured references — a history line is plain text.
- The conversation layer loads a window of the session, not the whole log. In a
  very long session the oldest prompts appear once their turns are loaded (for
  example after scrolling back); the pending echoes still cover the newest.

## Install

From the repository root:

```sh
dsh plugin --profile web add "<this checkout>/prompt-history"
```

or, from the GUI, install **Harness Plugins** from the marketplace (see the
repository README). Restart DSH afterwards — bundles compose at boot — then
hard-reload the page.

Remove it with:

```sh
dsh plugin --profile web remove dsh-prompt-history
```

## Verify

```sh
node prompt-history/verify-client.mjs
```

The verifier evaluates the shipped `client.js` with stubbed React, DOM, and
selection objects, then drives the real listener through the behaviors above:
history derivation, the navigation algebra, every guard, the submitted-box
reset, and the slot registration. It needs no browser and no installed profile.
