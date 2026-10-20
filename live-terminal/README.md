# Live Terminal

A terminal window docked above the message composer. Every time the agent runs
a command through its shell tool, the window opens with:

- **the command** on a one-line bar, with `$` as the prompt;
- **a live stream of its stdout/stderr**, updating as the command produces it;
- **a stopwatch** counting how long that command has been running, which freezes
  at the final duration when it exits;
- a status dot — pulsing while running, then green for success, amber for a
  cancelled command, red for a failure — plus the exit code.

It is a **bundle with both halves**: a Host half that reads the harness's own
job registry, and a browser half that renders the window.

## How it works

The harness already registers every terminal command it runs as a job in
`ctx.jobs`, carrying the owning session, the command text, the start time, the
status, and a bounded output ring that can be read incrementally. The Host half
subscribes to that registry, folds each command's ring into one record per
session, and serves the records over a read-only route:

```
GET /dsh-live-terminal?sessionId=<id>   →   { sessionId, active, recent, serverTime }
```

The browser half polls that route — fast (≈350 ms) while a command runs, slowly
(≈1.2 s) when idle — and renders the newest command. Because the stopwatch is
computed from the Host's `startedAt` on every tick (corrected by the snapshot's
`serverTime`), it stays accurate across a throttled background tab, a reload, or
a browser whose clock differs from the Host's.

Nothing is written to the session log, no credential is read, and no new session
event type is introduced. The plugin only displays state the harness already
keeps.

## Using it

- **Collapse** (`▾`) hides the output but keeps the command, status, and clock.
- **Hide when idle** (`○`/`◉`) hides the whole window once nothing is running;
  the next command brings it back.
- **Copy** (`⧉`) copies the retained output.
- **×** dismisses the window; the *Show last command* pill brings it back.

Collapse and idle-visibility choices persist in this browser's local storage.

Up to 6 commands are retained per session, and 120,000 characters of output per
command (older output is dropped from the front and marked as truncated).

## Install

From this repository:

```sh
dsh plugin --profile web add "github:ExcitedHumvee/Harness-Plugins#path:/live-terminal"
```

Restart DSH afterwards — a bundle contributes a configuration layer composed at
boot, so `patchReload: live` does not cover it. For a local checkout, run
`node install.mjs` from the repository root instead.

## Files

| File | Role |
|---|---|
| `index.js` | Host half: job subscription, per-session records, snapshot route |
| `client.js` | Browser half: the docked window, polling, and stopwatch |
| `cordis.patch.yml` | The bundle layer that mounts the Host row |
| `locale/en.json`, `locale/zh.json` | Plugin Manager title and description |
| `icon.svg` | Original artwork for the plugin row |

## Limitations

- The window shows **shell commands run through the harness's shell tools**
  (`bash`, `pwsh`, `terminal`). Commands you type into a separate interactive
  terminal panel are not shell-tool calls and do not appear.
- Output is a best-effort live view: the job ring is pumped at a bounded cadence,
  so bytes two streams produced in the same window may appear in drain order.
- A command that produces output faster than the ring retains shows its tail,
  with a truncation marker.
