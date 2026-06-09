# AudioMass AI-Control Protocol — The Contract

This is the wire contract between an AI controller and an AudioMass editor instance.
It describes what is **implemented today** (read from `bridge.js` / `control.js` /
`controller.js` on the `ai-control` branch) versus what is **PLANNED** (from
`../../CAPABILITIES.md`). Anything not in the "Implemented" tables does **not** work yet —
do not assume an unlisted verb exists.

---

## 1. Architecture — the rendezvous model

A single **bridge** process (`bridge.js`) runs a WebSocket server on a fixed address,
`ws://127.0.0.1:8077`. Two kinds of clients connect to it. Neither finds the other directly —
they both find the bridge, which routes between them.

- **Editor** — the AudioMass page. `control.js` is injected into the page, polls until
  `window.PKAudioEditor` exists, dials the bridge, registers as `role:"editor"`, executes
  incoming commands against the live editor, and forwards `Did*` notifications.
- **Controller** — the AI client. `controller.js` provides a `Controller` class and a CLI.
  It registers as `role:"controller"`, sends commands, and receives results + broadcast events.

```
   AI / shell                 bridge.js                  AudioMass page
  (controller.js) ─command──▶ ws://127.0.0.1:8077 ─command──▶ (control.js)
                  ◀─result───  routes by reqId    ◀─result───  VERBS dispatch
                  ◀─event────  broadcast to all   ◀─event────  Did* forwarding
                              controllers
```

Routing: each `command` carries a `reqId`; the bridge stores `reqId → controllerId` in a
`pending` map so the editor's `result` is returned to the controller that asked. `event`
messages from an editor are broadcast to **all** controllers. Commands target one editor
(see §7).

---

## 2. Message envelope

One JSON object per WebSocket message. Shapes below are verbatim from `bridge.js`.

| Direction | Type | Shape |
|---|---|---|
| client → bridge | `register` | `{type:"register", role:"editor"\|"controller", name?}` |
| bridge → client | `registered` | `{type:"registered", id, role}` |
| controller → bridge | `command` | `{type:"command", reqId, verb, args?, target?}` — `target` = `editorId` or `"active"` (default) |
| bridge/editor → controller | `result` (ok) | `{type:"result", reqId, ok:true, data}` |
| bridge/editor → controller | `result` (error) | `{type:"result", reqId, ok:false, error}` |
| editor → bridge → controllers | `event` | `{type:"event", name, data}` |
| bridge → client | `error` | `{type:"error", error}` — e.g. invalid JSON (not tied to a reqId) |

Notes:
- `id` assigned by the bridge is `"{role}-{n}"`, e.g. `editor-1`, `controller-2`.
- The bridge answers `ping` (`data:"pong"`) and `listEditors` directly; every other verb is
  forwarded to the editor. If no editor is connected, a forwarded command returns
  `{ok:false, error:"no editor connected"}`.
- Controller `send(verb, args, target)` auto-generates `reqId`, resolves on `ok:true`, rejects
  on `ok:false` or a ~10s timeout.

---

## 3. Verb reference

### 3a. Implemented verbs

Bridge-handled (answered without an editor):

| Verb | Args | Returns | Maps to |
|---|---|---|---|
| `ping` | — | `"pong"` | bridge |
| `listEditors` | — | `[{id, name}, …]` | bridge `editors` map |

Editor verbs (from the `VERBS` table in `control.js`). All action verbs fire `app.fireEvent(...)`;
when multitrack is on, `Request*` events auto-route through `multitrack.Propagate` (no mode branch).

| Verb | Args | Returns | Underlying Request*/dep |
|---|---|---|---|
| `getProject` | — | project state (see §4) | reads engine/multitrack |
| `getSelection` | — | `{start,end}` seconds, or `null` | wavesurfer region / `multitrack.GetRegion` |
| `listVerbs` | — | `[{verb, help}, …]` | local table |
| `play` | — | `{playing:true}` | `RequestPlay` |
| `pause` | — | `{playing:false}` | `RequestPause` |
| `stop` | — | `{playing:false}` | `RequestStop` |
| `seekTo` | `{time}` (seconds) | `{time, fraction}` | `RequestSeekTo` (takes 0..1 fraction; converted as `time/duration`, clamped) |
| `select` | `{start,end}` (seconds) | actual region `{start,end}` | `RequestRegionSet(start,end)` |
| `clearSelection` | — | `{selection:null}` | `RequestRegionClear` |
| `fadeIn` | — | `{applied:"fadeIn", range}` | `RequestActionFX_FadeIn` (arg ignored; acts on selection or whole clip) |
| `fadeOut` | — | `{applied:"fadeOut", range}` | `RequestActionFX_FadeOut` (arg ignored) |
| `gain` | `{db}` | `{applied:"gain", db, linear, range}` | `RequestActionFX_GAIN [{val:10^(db/20)}]` |
| `normalizeLUFS` | `{target, ceiling?}` (ceiling default `-1.0`) | `{applied:"normalizeLUFS", target, ceiling, range}` | `RequestActionFX_NormalizeLUFS {target,ceiling}`; requires `app._deps.lufs` |
| `undo` | — | `{undone:true}` | `StateRequestUndo` |
| `redo` | — | `{redone:true}` | `StateRequestRedo` |
| `zoomReset` | — | `{zoom:"reset"}` | `RequestZoomUI(0)` |

Error behavior: an unknown verb returns `error:"unknown verb: <v>"`; action verbs throw (→
`ok:false`) when no audio is loaded or args are missing/non-numeric.

> **Note on the CLI help:** `controller.js --help` shows `fadeOut '{"secs":2}'`, but the
> implemented `fadeIn`/`fadeOut` ignore their argument — fade duration is **not** yet
> parameterized. The example is aspirational, not a contract.

### 3b. PLANNED verbs (not built)

From `CAPABILITIES.md`. **None of these are implemented** — listed so controllers know the
intended menu. Provenance tags: `[native]` existing AudioMass `Request*` · `[add]` new handler ·
`[recipe]` composite · `[pipeline]` generator bridge · `[read]` query.

- **Reads/awareness:** `getTrack`, `getClip`, `getTimelineAnalysis` `[add]`, `describeTimeline`
  `[add]`, `getHistory`, `getDuration`, `getSampleRate`.
- **Project/session:** `newProject`, `loadAudio`, `loadProjectFile` (see §6), `saveProject`,
  `exportProjectFile`, `export(format,range)`, `bounce`.
- **Transport (extra):** `transportToggle`, `skipBack`, `skipForward`, `setLoop`, `previewRegion`.
- **Selection (extra):** `selectClip`, `selectAll`, `setRegion`/`clearRegion`.
- **View:** `zoomIn/Out`, `zoomToFit`, `zoomTo`, `centerToCursor`, `pan`, `scrollTo`, `toggleMixer`.
- **Tracks (multitrack):** `addTrack`, `removeTrack`, `renameTrack`, `reorderTrack`, `mute`,
  `solo`, `setVolume`, `setPan`, `setTrackHeight`, `setTrackColor`, `armRecord`.
- **Clips:** `addClip`, `moveClip`, `trimClip`, `splitClip`, `deleteClip`, `duplicateClip`,
  `setClipGain`, `crossfade`, `getClipLength`, `getClipBounds`.
- **Editing:** `cut`, `copy`, `paste`, `delete`, `insertSilence`, `trim`, `removeSilence`,
  `join`/`assembleBackToBack`, `reverse`/`flip`.
- **FX (full palette):** `normalize`, `normalizeRMS`, `hardLimit`, `loudness`, `compressor`,
  `paramEQ`, `humNotch`, `changeRate`, `changeSpeed`, `reverb`, `delay`, `deClick`,
  `repairSplice`, `denoise`, `distort`, `invert` (+ preview variants).
- **Analysis:** `measureLUFS`, `measurePeak`/`detectClipping`, `frequencyAnalysis`,
  `detectSilence`, `estimateTempo`.
- **Versions/fan-out:** `listVersions`, `swapVersion`, `addVersionAsTrack`, `compareVersions`,
  `versionBack`/`versionForward`.
- **Markers/metadata:** `addMarker`, `removeMarker`, `listMarkers`, `setID3`.
- **Recording:** `record`, `stopRecord`. **History:** `clearHistory`.
- **Generation hooks `[pipeline]`:** `generateVoice`, `generateMusic`, `generateSFX`,
  `regenerateSegment`.
- **Recipes `[recipe]`:** `layInShow`, `addBedUnder`, `duckMusicUnderVoice`, `applyStandardFades`,
  `autoLevel`, `trimDeadAir`, `assembleSegments`, `polishShow`.

---

## 4. `getProject` state schema

**Implemented** — exactly what `control.js` returns:

```json
{
  "loaded":     true,
  "duration":   123.45,
  "playhead":   12.0,
  "selection":  { "start": 1.0, "end": 4.0 },
  "multitrack": false
}
```

- `loaded` — `is_ready` (single-track) or `multitrack.HasClips()` (multitrack).
- `duration`, `playhead` — seconds; honor multitrack getters when MT is on.
- `selection` — `{start,end}` seconds or `null`.
- `multitrack` — whether multitrack mode is on.

**PLANNED** fuller schema (from `CAPABILITIES.md §1`, not built):

```json
{
  "loaded": true, "duration": 123.45, "playhead": 12.0, "multitrack": true,
  "zoom": { "factor": 1, "leftPercent": 0 },
  "selection": { "track": "t1", "start": 1.0, "end": 4.0 },
  "tracks": [
    { "id": "t1", "name": "VO", "mute": false, "solo": false, "volumeDb": 0, "pan": 0,
      "clips": [ { "id": "c1", "name": "intro", "start": 0, "length": 8.0, "gainDb": 0,
                   "fadeIn": 0.2, "fadeOut": 0.5 } ] }
  ]
}
```

---

## 5. Notifications (`Did*` events)

Forwarded by `control.js` from the `PKAudioEditor` event bus to all controllers as
`{type:"event", name, data}`. Heavy live objects (AudioBuffers) are stripped; only summaries cross.

| `name` | `data` payload |
|---|---|
| `DidStateChange` | `{canUndo, canRedo, undoDepth, redoDepth, recentUndo:[…desc], recentRedo:[…desc]}` (last 5 descs) |
| `DidSelectClip` | `{id, name, start, track}` or `null` |
| `DidUpdateMultitrack` | `{multitrack, duration, playhead, selection}` (fresh snapshot) |
| `DidStopPlay` | `{playing:false, playhead}` |
| `DidZoom` | `{zoomFactor, leftPercent, verticalZoom}` or `null` |

Bridge-originated events (not from the editor): `EditorConnected {id, name}`,
`EditorDisconnected {id}`. The controller library also emits a local `Disconnected {}` and an
`Error {error}` to `'*'` listeners. Subscribe via `controller.on(name, cb)` or `on('*', cb)`.

---

## 6. Project-file format (PLANNED — not built)

The intent (`CAPABILITIES.md §2, §16 layInShow`) is that an AI can author a JSON layout and load
a whole board in one call (`loadProjectFile` / `layInShow`). AudioMass's **native** save format is
`.amss` (its own binary/serialized format); we will likely define a cleaner JSON layout instead of
authoring `.amss` directly. A sketch of the intended shape:

```json
{
  "version": 1,
  "sampleRate": 48000,
  "tracks": [
    { "name": "VO",  "clips": [ { "src": "intro.wav", "at": 0.0 },
                                { "src": "body.wav",  "at": 8.5 } ] },
    { "name": "Bed", "volumeDb": -14, "clips": [ { "src": "music.mp3", "at": 0.0,
                                                   "fadeIn": 1.0, "fadeOut": 2.0 } ] }
  ]
}
```

This is a target, not a contract — field names will be finalized when `loadProjectFile` is built.

---

## 7. Connection rules

- **Fixed endpoint:** `ws://127.0.0.1:8077` (bridge `--port` overrides; controller `--url`).
- **No auth:** localhost only. Anyone who can reach the port can drive the editor.
- **Auto-reconnect (editor):** `control.js` reconnects every ~2s if the socket drops; it polls
  for `window.PKAudioEditor` every 200ms before first connect. Event forwarding is wired once,
  regardless of socket state (sends no-op while disconnected).
- **Heartbeat:** the bridge pings every 30s and terminates sockets that miss a pong.
- **Tab registry / "active" target:** the bridge tracks all connected editors in an `editors` map.
  A command's `target` is an explicit `editorId`, or `"active"` (default) = the **most-recently
  registered** editor. Use `listEditors` to enumerate; pass `--target <id>` to address a specific
  tab.
- **Controller timeout:** per-command ~10s; on timeout the promise rejects with `.timeout=true`.
