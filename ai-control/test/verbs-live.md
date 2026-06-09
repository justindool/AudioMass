# Live verb QA checklist

Manual QA for the AudioMass AI-control stack, run by the overseer against a **live**
editor. Each step gives the exact `controller.js` command and the expected observable
result in the running AudioMass page.

## Setup

1. Start the bridge (one terminal):

   ```bash
   cd ai-control
   node bridge.js          # or: npm run bridge
   ```

   Expect: `[bridge ...] listening on ws://127.0.0.1:8077`.

2. Open AudioMass in the browser so its in-page control client dials into the bridge
   and registers as an `editor`. The bridge log should show
   `editor connected: editor-1 (...)`.

3. Run all commands below from the `ai-control/` directory:

   ```bash
   cd ai-control
   ```

Conventions for every step:

- **Exit code:** `0` when `ok:true`, `1` on `ok:false`/timeout. Check with `echo $?`.
- Add `--raw` to any command to see the full `{ok, data|error}` envelope instead of just `data`.
- Add `--target <editorId>` to aim at a specific editor (default `active` = most-recently registered).
- Run `node controller.js --watch` in a **second** terminal to observe the `Did*` events
  each command emits while you run the steps in the first terminal.

---

## Group A — No audio needed (transport / state / introspection)

These work as soon as an editor is connected, even with an empty project. Transport
verbs on an empty project should still return `ok:true` (no-op) and not error.

| # | Command | Expected observable result |
|---|---------|----------------------------|
| A1 | `node controller.js listEditors` | Bridge-handled. Prints a JSON array with at least one entry, e.g. `[{"id":"editor-1","name":"..."}]`. Exit 0. Confirms the page is connected. |
| A2 | `node controller.js listVerbs` | Editor returns the list of verbs it supports (array of strings). Use this as the source of truth for what the live build actually implements. Exit 0. |
| A3 | `node controller.js getProject` | Returns project metadata (e.g. sample rate, channel count, duration — duration may be 0 with no audio). Exit 0. No visible change in the editor. |
| A4 | `node controller.js getSelection` | Returns the current selection (e.g. `{start, end}` or null/empty when nothing is selected). Exit 0. |
| A5 | `node controller.js play` | Editor begins playback; playhead starts moving. With no audio it is a silent no-op but still `ok:true`. Watch terminal shows a play/transport `Did*` event. Exit 0. |
| A6 | `node controller.js pause` | Playback pauses; playhead stops where it was. Exit 0. |
| A7 | `node controller.js stop` | Playback stops; playhead returns to start (time 0). Exit 0. |
| A8 | `node controller.js seekTo '{"time":3}'` | Playhead jumps to 3 seconds (or clamps to project end if shorter). The time display updates. Exit 0. |
| A9 | `node controller.js clearSelection` | Any selection is cleared; the waveform shows no highlighted region. A follow-up `getSelection` (A4) should report empty. Exit 0. |
| A10 | `node controller.js zoomReset` | Horizontal zoom returns to the default fit-to-window level. Visible in the waveform view. Exit 0. |
| A11 | `node controller.js --watch` | Connects and streams every incoming event as pretty JSON with a timestamp. Trigger events by running other commands in a second terminal (e.g. A5/A8/B-group). Ctrl-C to stop; exit 0. |

### Error/edge sanity (no audio)

| # | Command | Expected |
|---|---------|----------|
| A12 | Stop the bridge, then `node controller.js listEditors` | Clear message: "Cannot reach the bridge ... (connection refused). Is it running?". Exit 1. (Restart the bridge afterward.) |
| A13 | Close the AudioMass tab, then `node controller.js getProject` | `{"ok":false,"error":"no editor connected"}`. Exit 1. (Reopen the tab afterward.) |
| A14 | `node controller.js seekTo '{bad}'` | `Invalid jsonArgs (must be a JSON object): ...`. Exit 1. |

---

## Group B — Load an audio file first

**Precondition:** in AudioMass, open/import an audio file (e.g. drag in a WAV/MP3) so
the project has a non-zero duration and a visible waveform. Then run these.

| # | Command | Expected observable result |
|---|---------|----------------------------|
| B1 | `node controller.js getProject` | Now reports a real duration (> 0) and the file's sample rate / channels. Exit 0. |
| B2 | `node controller.js select '{"start":1,"end":4}'` | A region from 1s to 4s is highlighted in the waveform. `getSelection` (A4) should report `{start:1, end:4}` (approx). Watch terminal shows a `DidSelect*` event. Exit 0. |
| B3 | `node controller.js getSelection` | Returns the selection set in B2 (`start≈1`, `end≈4`). Exit 0. |
| B4 | `node controller.js play` | Plays from the selection start (or current playhead); audio is audible and the playhead moves. Exit 0. |
| B5 | `node controller.js pause` then `node controller.js stop` | Pause halts playback in place; stop returns the playhead to 0. Exit 0 each. |
| B6 | `node controller.js fadeIn '{"secs":2}'` | Applies a 2-second fade-in (to the selection if one is active, else from the start). The waveform amplitude ramps up over the affected region. Audibly fades in on playback. Exit 0. Emits a change/`Did*` event. |
| B7 | `node controller.js fadeOut '{"secs":2}'` | Applies a 2-second fade-out; waveform amplitude ramps down at the end of the region. Audibly fades out. Exit 0. |
| B8 | `node controller.js gain '{"db":-3}'` | Applies -3 dB gain to the selection (or whole file if no selection); waveform shrinks in amplitude. Audibly quieter. Exit 0. (Check the live `listVerbs` for the exact arg name — `db` vs `amount` — if this errors.) |
| B9 | `node controller.js normalizeLUFS '{"target":-16}'` | Loudness-normalizes the audio toward -16 LUFS; overall amplitude rescales accordingly. Exit 0. (Confirm the arg name via `listVerbs` if it errors.) |
| B10 | `node controller.js undo` | Reverts the most recent edit (e.g. the normalize from B9). Waveform returns to its prior state. Exit 0. Emits a `Did*` change event. |
| B11 | `node controller.js redo` | Re-applies the edit undone in B10. Waveform returns to the post-edit state. Exit 0. |
| B12 | `node controller.js clearSelection` | Selection highlight disappears. Exit 0. |
| B13 | `node controller.js zoomReset` | Zoom returns to fit-to-window over the full file. Exit 0. |

---

## Notes for the overseer

- The controller is **verb-agnostic**: it forwards whatever verb you pass. If a verb
  or arg name here disagrees with the live build, treat `node controller.js listVerbs`
  (A2) as authoritative and adjust the JSON args accordingly.
- `ping` and `listEditors` are answered by the bridge itself, so they work even with
  no editor connected — handy to confirm the bridge is alive independent of the page.
- For destructive verbs (B6–B9, B11), `undo` (B10) should always restore the prior
  state — use it to reset between trials.
