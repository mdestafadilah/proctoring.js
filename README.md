# proctoring.js

Zero-dependency browser proctoring toolkit. Detects tab switching, right-click
use, developer-tools shortcuts, camera tampering, missing or extra faces, room
noise, and third-party capture software — virtual cameras, loopback audio cables
and screen shares — through one small event API.

**[Live demo](https://proctoring-js-demo.netlify.app)** ·
**[npm](https://www.npmjs.com/package/proctoring.js)**

```bash
npm install proctoring.js
```

```js
import { Proctor } from 'proctoring.js';

const proctor = new Proctor({
  camera: { enabled: true, videoElement: '#preview' },
});

proctor.on('violation', (v) => console.log(v.type, v.severity, v.details));

await proctor.start();

// ...exam runs...

const report = proctor.stop();
console.log(report.score, report.violations);
```

---

## Why this exists

Most proctoring libraries are either heavyweight SaaS SDKs that phone home, or
tutorial-grade snippets that break the moment a candidate unplugs their webcam.
`proctoring.js` sits in between: a small, auditable client-side library with a
stable event contract, no runtime dependencies, and no opinion about your
backend.

Design rules it follows:

- **No hidden network calls.** Nothing leaves the page unless you set
  `backend.endpoint`.
- **Nothing is recorded.** Audio is analysed in memory and discarded; no
  `MediaRecorder`, and no screenshots or periodic snapshots unless you opt in.
  The clipboard is never read — copy/paste detection records that it happened,
  where, and how many characters, never the characters themselves.
- **A broken feature never kills the session.** If the camera is denied, tab
  monitoring keeps running and you get a `detector:error` event.
- **Permissions are opt-in.** Only tab detection is on by default, because it
  needs no permission prompt.

---

## Detectors

| Detector | Default | Permissions | What it catches |
|---|---|---|---|
| `tabs` | **on** | none | Tab switch, window blur, page hidden, page torn down |
| `rightClick` | off | none | Right-click, keyboard Menu key, long-press menu |
| `shortcuts` | off | none | DevTools / view-source shortcuts (`Ctrl+Shift+I`, `F12`, `Ctrl+U`, …) |
| `clipboard` | off | none | Copy, cut and paste, with the element it happened in |
| `camera` | off | camera | Denied camera, muted track, covered lens, frozen feed, unplugged device |
| `face` | off | camera (shared) | No face, multiple faces, looking away |
| `audio` | off | microphone | Sustained loud noise, spectral busyness |
| `thirdParty` | off | camera (for labels) | Virtual cameras, loopback audio cables, screen shares |

Face detection reuses the camera detector's stream, so enabling both costs one
permission prompt, not two. The same is true of `thirdParty.detectActiveCamera`.

Periodic snapshots are not a detector: see [Periodic snapshots](#periodic-snapshots).

---

## Options

All options are optional. The shape is `detector -> setting`.

```js
new Proctor({
  sessionId: 'attempt-1234',        // your own id, echoed in the report
  metadata: { examId: 'math-01' },  // arbitrary JSON-safe data
  logLevel: 'warn',                 // silent | error | warn | info | debug

  tabs: {
    enabled: true,
    trackWindowBlur: true,          // also flag focus loss, not just tab switch
    minHiddenMs: 0,                 // ignore flicker shorter than this
    throttleMs: 300,
    reportOnClose: false,           // report tab-closed as the page goes away
  },

  rightClick: {
    enabled: false,
    block: false,                   // suppress the browser menu (opt-in)
    detectPointerDown: true,        // catch it even if the page swallows the menu
    dedupeMs: 400,                  // one gesture is one violation
    throttleMs: 500,                // minimum gap between reported right-clicks
    captureTarget: true,            // record tag/id/classes of the target
  },

  shortcuts: {
    enabled: false,
    combos: null,                   // null = the platform's devtools defaults
    block: false,                   // preventDefault the shortcut (opt-in)
  },

  clipboard: {
    enabled: false,
    actions: ['copy', 'cut', 'paste'],
    block: false,                   // preventDefault the operation (opt-in)
    throttleMs: 250,                // per action, not shared across them
    ignoreSelectors: null,          // CSS selectors for your own UI
  },

  camera: {
    enabled: false,
    videoElement: '#preview',       // selector, element, or null for no preview
    width: 640,
    height: 480,
    detectMuted: true,              // lens covered / revoked
    detectEnded: true,              // device unplugged
    throttleMs: 2000,
    snapshotIntervalMs: 0,          // periodic webcam stills; 0 = off
  },

  face: {
    enabled: false,
    videoElement: null,             // defaults to the camera detector's element
    provider: 'cdn',                // cdn | module | custom
    intervalMs: 500,                // inference cadence; 500ms is a good default
    minConfidence: 0.5,
    requireFace: true,
    awayGraceMs: 2000,              // grace before "no face" is a violation
    maxFaces: 1,
    lookAwayTolerance: 0.25,        // how far off-centre before it counts
    throttleMs: 3000,
  },

  audio: {
    enabled: false,
    rmsThreshold: 0.08,             // 0..1 loudness that counts as too loud
    loudGraceMs: 1500,              // must stay loud this long
    voiceThreshold: 0.5,
    detectMultipleVoices: false,    // experimental
    throttleMs: 3000,
  },

  thirdParty: {
    enabled: false,
    detectVirtualDevices: true,     // scan enumerateDevices() for virtual devices
    detectActiveCamera: true,       // needs camera.enabled
    detectScreenShare: true,        // observe getDisplayMedia
    devices: null,                  // extra lowercase substrings to flag
    ignore: null,                   // substrings that suppress a match
    scanIntervalMs: 15000,          // rescan cadence; devicechange also triggers
    checkIntervalMs: 3000,          // active-camera poll
    throttleMs: 2000,
  },

  pageCapture: {
    enabled: false,                 // gates startPageCapture(); nothing starts itself
    intervalMs: 30000,              // snapshot cadence
    maxWidth: 640,
    quality: 0.6,
    displaySurface: 'browser',      // browser | window | monitor (a hint only)
  },

  backend: {
    enabled: false,
    endpoint: null,                 // POST target for violations
    snapshotEndpoint: null,         // separate target for snapshots; falls back
    batchIntervalMs: 0,             // 0 = send immediately
    offlineQueue: true,             // retry when the network returns
    includeReport: false,
    minSeverity: null,              // only upload this severity and above
    retries: 2,
    timeoutMs: 10000,
  },

  report: {
    persist: true,                  // survive a page reload
    storageKey: 'proctoring.js:report',
    maxViolations: 1000,

    captureScreenshots: false,      // attach a webcam frame to visual violations
    screenshotMaxWidth: 320,        // downscale target; 0 = native size
    screenshotQuality: 0.6,         // JPEG quality
    screenshotTypes: null,          // null = camera + face only
    screenshotBudgetBytes: 8 * 1024 * 1024,
  },

  // Per-type severity overrides
  severity: { 'tab-hidden': 'critical' },
})
```

---

## Events

```js
const off = proctor.on('violation', (v) => {
  // v = { id, type, severity, detector, timestamp, elapsedMs, details }
  if (v.severity === 'critical') alertSupervisor(v);
});
off(); // unsubscribe
```

| Event | Payload | When |
|---|---|---|
| `started` | `{ startedAt, detectors }` | `start()` resolved |
| `violation` | `Violation` | any detector fires |
| `snapshot` | `Snapshot` | a periodic still was taken |
| `detector:ready` | `{ detector }` | one detector initialised |
| `detector:error` | `{ detector, error }` | one detector failed |
| `detector:enabled` / `detector:disabled` | `{ detector }` | toggled at runtime |
| `stopped` | `{ report }` | `stop()` called |
| `log` | `{ level, message, meta }` | diagnostics |
| `error` | `Error` | session-level failure |

Use `once()` for one-shot listeners and `off()` to remove one.

---

## Violation types

| Type | Default severity | Meaning |
|---|---|---|
| `tab-hidden` | high | The page was hidden past `minHiddenMs` |
| `tab-closed` | high | The page is going away (close, reload or navigation) |
| `window-blur` | medium | Window lost focus while still visible |
| `right-click` | medium | Right-click, Menu key, or long-press inside the page |
| `shortcut-used` | high | A watched keyboard shortcut was pressed |
| `clipboard-copy` | medium | Text was copied out of the page |
| `clipboard-cut` | medium | Text was cut out of the page |
| `clipboard-paste` | medium | Text was pasted into the page |
| `camera-denied` | critical | Permission refused |
| `camera-disabled` | critical | Track ended — device gone or revoked |
| `camera-muted` | high | Track muted, or the image froze |
| `face-not-detected` | medium | No face for longer than `awayGraceMs` |
| `face-multiple` | high | More than `maxFaces` faces |
| `face-looking-away` | low | Face present but off-centre |
| `audio-too-loud` | low | RMS above threshold, sustained |
| `audio-multiple-voices` | medium | Spectral busyness above threshold — experimental, not a speaker count |
| `third-party-device` | medium | A known virtual/loopback capture device is installed |
| `virtual-camera-active` | high | The camera in use is one of those devices |
| `screen-share-started` | high | A screen share started, or the "camera" is a shared screen |

Override any of them with `severity: { 'audio-too-loud': 'medium' }`.

---

## API

| Method | Description |
|---|---|
| `start(overrides?)` | Initialise every enabled detector. Resolves even if one fails. |
| `stop()` | Tear everything down; returns the final report. |
| `getReport()` | Current snapshot — safe to call any time. |
| `getViolations(minSeverity?)` | Violation list, optionally filtered. |
| `hasViolation(type)` | Convenience boolean. |
| `getDetectorState(name)` | Live status, e.g. current face count. |
| `enableDetector(name)` / `disableDetector(name)` | Toggle at runtime. |
| `clearViolations()` | Reset the trail, keep detectors running. |
| `reportViolation(type, details, meta)` | Log your own custom violations. |
| `destroy()` | Stop and release every listener. |

---

## The report

```js
const report = proctor.stop();
```

```js
{
  sessionId: 'attempt-1234',
  startedAt: '2026-03-18T02:00:00.000Z',
  endedAt:   '2026-03-18T03:00:00.000Z',
  durationMs: 3600000,
  total: 4,
  score: 76,                    // 100 = clean, decreases with severity
  worstSeverity: 'high',
  countsByType: { 'tab-hidden': 2, 'face-not-detected': 2 },
  violations: [ /* full trail, newest last */ ],
  detectorStates: { /* last known state per detector */ },
  screenshotBytes: 0,           // in-memory screenshot budget used
  droppedScreenshots: 0,        // frames discarded once the budget ran out
}
```

Formatting helpers:

```js
import { formatReport, reportToCsv, downloadReport, mergeReports } from 'proctoring.js';

console.log(formatReport(report));       // human-readable summary
const csv = reportToCsv(report);         // spreadsheet-ready
downloadReport(report, 'exam.json');     // trigger a browser download
const forClass = mergeReports([r1, r2]); // combine sessions
```

---

## Screenshots

Off by default. When enabled, a downscaled webcam frame is attached to visual
violations (camera and face), which turns "the camera was muted at 12:03" into
evidence you can actually look at.

```js
new Proctor({
  camera: { enabled: true, videoElement: '#preview' },
  report: {
    captureScreenshots: true,
    screenshotMaxWidth: 320,   // ~3 KB per frame instead of ~40 KB
    screenshotQuality: 0.6,
    screenshotTypes: null,     // null = camera + face only
  },
});
```

```js
proctor.on('violation', (v) => {
  if (v.screenshot) img.src = v.screenshot;   // data:image/jpeg;base64,...
});
```

Three behaviours worth knowing:

- **Only visual violations get a frame.** Attaching a webcam still to
  `audio-too-loud` would be misleading evidence, so `tab-hidden` and audio
  violations never carry one. Narrow or widen this with `screenshotTypes`.
- **Screenshots are memory-only.** They are stripped before the report is
  persisted to `sessionStorage`, because a few hundred 3 KB frames would blow the
  ~5 MB quota and cost you the entire report. The persisted copy survives a
  reload; the images do not.
- **There is a budget.** Once `screenshotBudgetBytes` is exhausted, new frames
  are dropped and `report.droppedScreenshots` counts them. The violation itself
  is always kept — the text matters more than the picture.

If the frame cannot be read (no stream yet, a tainted canvas, a detached
element), capture silently yields nothing rather than failing the violation.

---

## Right-click detection

```js
new Proctor({ rightClick: { enabled: true } });
```

A right-click inside the page produces one `right-click` violation, recording
where it happened:

```js
{
  type: 'right-click',
  severity: 'medium',
  detector: 'rightClick',
  details: {
    source: 'pointerdown',   // or 'contextmenu'
    blocked: false,          // whether the menu was suppressed
    x: 412, y: 268,
    target: 'button#submit.primary',
    at: '2026-03-18T02:14:09.000Z',
  },
}
```

Two signals feed it, and they are deliberately redundant:

- **`contextmenu`**, listened for on `document` in the **capture** phase. It
  covers a mouse right-click, the keyboard Menu key, `Shift+F10`, and a
  long-press on Android. The capture phase matters: a page that calls
  `stopPropagation()` in a bubble-phase listener would otherwise silence a
  detector listening on `document`.
- **A secondary-button `pointerdown`**, which fires first and still fires when a
  page swallows the menu.

Both signals arrive for one click, so the detector collapses them: a `contextmenu`
within `dedupeMs` of a reported `pointerdown` is treated as the same gesture.
`dedupeMs` is separate from `throttleMs` on purpose — setting `throttleMs: 0` to
opt out of rate limiting must not also start double-counting every click.

### Blocking the menu

Off by default. A library should not silently change how your page behaves, and
a right-click is normal on most pages — only you know whether it is suspicious
in your context.

```js
new Proctor({ rightClick: { enabled: true, block: true } });
```

With `block: true` the browser menu is suppressed on **every** right-click, even
ones whose report is dropped by the throttle — otherwise a second click inside
the throttle window would quietly open the menu.

### Scope, honestly

This observes the **page**, not the machine. A right-click on the desktop, in
another app, or on browser chrome produces nothing here. Catching that is what
`tabs` and `camera` are for. It is also trivially defeated by devtools or a
second device — treat it as a signal for human review, not as prevention.

---

## Keyboard shortcuts

```js
new Proctor({ shortcuts: { enabled: true } });
```

Out of the box it watches the developer-tools and view-source combinations, which
is the usual first move when someone wants to inspect or edit an exam page:

| Platform | Watched by default |
|---|---|
| Windows / Linux | `Ctrl+Shift+I` · `Ctrl+Shift+J` · `Ctrl+Shift+K` · `Ctrl+Shift+C` · `Ctrl+U` · `F12` |
| macOS | `Cmd+Opt+I` · `Cmd+Opt+J` · `Cmd+Opt+K` · `Cmd+Shift+C` · `Cmd+U` · `F12` |

The platform list is chosen at start-up and exposed as `DEVTOOLS_COMBOS`, so you
can build on it rather than retyping it:

```js
import { DEVTOOLS_COMBOS, detectPlatform } from 'proctoring.js';

new Proctor({
  shortcuts: {
    enabled: true,
    combos: [...DEVTOOLS_COMBOS[detectPlatform()], 'ctrl+p', 'mod+shift+v'],
  },
});
```

```js
{
  type: 'shortcut-used',
  severity: 'high',
  detector: 'shortcuts',
  details: {
    combo: 'ctrl+shift+i',   // the matched rule, canonicalised
    label: 'devtools',       // or null for a combo the library does not know
    blocked: false,
    key: 'I',                // raw evidence, as the browser reported it
    code: 'KeyI',
    at: '2026-03-18T02:14:09.000Z',
  },
}
```

### Combo syntax

Modifiers `ctrl`, `shift`, `alt`, `meta`, plus `mod` — which resolves to `meta`
on macOS and `ctrl` elsewhere, the convention every editor uses — followed by one
key. Order does not matter; the matched combo is reported canonically:

```js
parseCombo('Shift+Ctrl+I');        // { ctrl: true, shift: true, key: 'i', raw: 'ctrl+shift+i' }
parseCombo('mod+shift+i', 'mac');  // { meta: true, ctrl: false, ... }
parseCombo('ctrl+shift');          // null — modifiers with no key
```

A typo is logged as a warning and skipped rather than thrown, so one bad entry
does not disable the rest — but it is never silent, because a rule that can never
match is the worst kind of bug to debug.

### Matching details that are easy to get wrong

- **`Shift` uppercases `key`.** `Ctrl+Shift+I` arrives as `key: 'I'`, so a naive
  `event.key === 'i'` comparison never fires. Both `event.code` and `event.key`
  are accepted, which also means a Cyrillic or Greek layout still matches — the
  physical key is the same even when the character is not.
- **Modifier sets must match exactly.** A subset check would accept
  `Ctrl+Shift+Alt+I` for a `ctrl+shift+i` rule. Exact matching also keeps **AltGr**
  out: on Windows it sets `ctrlKey` *and* `altKey`, so a portable `ctrl+alt+i`
  entry would fire every time a German or Polish candidate types an "i". No
  shipped default uses `ctrl+alt` for that reason, and there is a test asserting
  it stays that way.
- **Auto-repeat and IME are ignored.** Holding the key fires a stream of repeats
  and must not spam the report; a keydown during IME composition belongs to the
  input method, not to a shortcut.

### Blocking shortcuts

Off by default — a library should not silently change how your page behaves, and
hijacking `Ctrl+Shift+I` on a page you do not control is user-hostile.

```js
new Proctor({ shortcuts: { enabled: true, block: true } });
```

`preventDefault()` is called **only on a match**, never on unrelated keystrokes,
and it is the only thing that stops the browser acting on the shortcut — which
works in Chromium and Firefox for the DevTools and view-source keys.

### Scope, honestly

This detects a **keystroke**, not the tool. Someone who opens DevTools from the
browser menu, with the mouse, from a second window, or with a browser extension
produces nothing here — and once DevTools has focus, the page stops receiving
`keydown` at all, so a candidate can open it and then do whatever they like
without a single further event. Treat `shortcut-used` as one weak signal among
several, never as proof that DevTools was not used.

---

## Copy / paste

Detects copy, cut and paste inside the page, and records *where* it happened. No
permission and no user gesture: these are ordinary DOM events.

| Signal | Violation | Details |
|---|---|---|
| `copy` | `clipboard-copy` | `target`, `textLength` |
| `cut` | `clipboard-cut` | `target`, `textLength` |
| `paste` | `clipboard-paste` | `target`, `textLength` |

```js
new Proctor({
  clipboard: {
    enabled: true,
    actions: ['copy', 'cut', 'paste'],  // any subset
    block: false,                       // true also preventDefault()s the operation
    throttleMs: 250,                    // per action, so a copy cannot swallow a paste
    ignoreSelectors: ['#host-toolbar'], // your own UI, e.g. a "copy question" button
  },
})
```

The listeners sit in the **capture phase** on `document`, so a page calling
`stopPropagation()` cannot hide the gesture — the same reasoning as the
right-click detector. `block: true` calls `preventDefault()` on *every* event,
including ones whose report is throttled: suppressing only the reported ones
would let the second copy inside the throttle window go through silently.

### What it does not do

**The clipboard is never read.** `textLength` is measured from the event's own
`clipboardData` — data the browser has already handed the page by virtue of the
event firing — and the string is discarded on the same line it is measured.
`navigator.clipboard.readText()` is never called: it needs a `clipboard-read`
permission prompt, and it would turn a behavioural signal into content
surveillance. If you need the text, read it in your own `copy` handler and decide
for yourself what to store.

**Only this page is observable.** A paste into Word, or a copy made in another
tab, never reaches these listeners. Silence means "not here", not "not happening".

---

## Audio detection

Two signals, both from the same microphone stream:

- **Loudness (RMS)** — reports `audio-too-loud` when the room stays above
  `rmsThreshold` for `loudGraceMs`. This path is well-behaved, and is the reason
  to enable the detector at all.
- **Spectral busyness** — reports `audio-multiple-voices` when the spectrum looks
  "busy" enough. Opt-in via `detectMultipleVoices`, and experimental.

The detector **never records**. It reads the live waveform on the main thread and
discards every sample immediately — no `MediaRecorder`, no buffer, nothing to
leak. That keeps it usable in places where recording a candidate's audio needs
separate consent.

It also asks `getUserMedia` for `echoCancellation: false`,
`noiseSuppression: false` and `autoGainControl: false`. Those stages exist to
remove exactly the background noise and distant voices you are trying to detect.

### Scope, honestly

`detectMultipleVoices` **cannot count speakers**, and enabling it logs a warning
saying so. Three measurements, each pinned by a check in `npm run verify`:

| What was measured | Result |
|---|---|
| One voice at 0.3x vs 1.0x volume | 0.0020 → 0.0118 — **5.9x from volume alone** |
| One voice vs two voices | only **1.3x** apart |
| Room with background noise vs one voice | noise scores **~10x higher** |

So the score tracks how loud the room is and how high its noise floor is, not how
many people are talking. A single loud speaker reads as "busier" than two quiet
ones, and no threshold separates "several people talking" from "one person in a
noisy room".

The shipped `voiceThreshold` of `0.5` is also **unreachable** in practice —
realistic spectra measure 0.01–0.12, so the violation will not fire unless you
calibrate that value against your own audio.

It is kept because `audio-multiple-voices` is a published violation type, and a
host that calibrates the threshold may still find the ratio useful. Do not treat
its output as evidence that a second person is present.

> These measurements come from synthetic spectra, not real recordings, so treat
> the exact numbers as indicative. The direction is not in doubt — the metric is
> gain-dependent by construction, since its floor is an absolute value.

---

## Third-party capture software

Reports the screen-sharing, streaming and remote-access tooling that a web page
can actually observe — and is explicit about the rest.

| Signal | Violation | How it is seen |
|---|---|---|
| A known virtual/loopback device is installed | `third-party-device` | `enumerateDevices()` |
| The camera in use is one of those devices | `virtual-camera-active` | the live `MediaStreamTrack` |
| The "camera" is really a shared screen | `screen-share-started` | `displaySurface` on the track |
| This page started a screen share | `screen-share-started` | `getDisplayMedia`, wrapped |

```js
new Proctor({
  camera: { enabled: true, videoElement: '#preview' },
  thirdParty: {
    enabled: true,
    detectVirtualDevices: true,   // scan enumerateDevices()
    detectActiveCamera: true,     // needs camera.enabled
    detectScreenShare: true,      // observe getDisplayMedia
    devices: ['acme capture'],    // extra lowercase substrings to flag
    ignore: null,                 // suppress known-good lab hardware
    scanIntervalMs: 15000,        // rescan cadence; devicechange also triggers
    checkIntervalMs: 3000,        // active-camera poll
    throttleMs: 2000,
  },
})
```

The shipped device list is exported as `KNOWN_THIRD_PARTY_DEVICES`: OBS Virtual
Camera, ManyCam, XSplit VCam, Snap Camera, DroidCam, Iriun, EpocCam, NDI,
SplitCam, CamTwist, Logi Capture, VB-Audio cables, VoiceMeeter, BlackHole,
Soundflower, and the screen-capture "cameras". Matching is a case-insensitive
substring test, because vendors decorate labels freely. `matchThirdPartyDevice(label, { extra, ignore })`
is exported too, so you can run the same rules over your own device inventory.

`ignore` is checked first and beats every match. The list is heuristic, so a site
with known-good virtual hardware needs that escape hatch.

### Scope, honestly

**Remote-desktop software cannot be detected from a web page.** No browser API
exposes other processes, and nothing about a TeamViewer, AnyDesk or RDP session is
visible to page script. If that is what worries you, this detector will not tell
you it is running — and neither will any other page-level library. Anything that
claims otherwise is guessing. That is why there is no `detectRemoteSession` option
here: there is no signal to build one from, and shipping a heuristic with no
signal would only produce noise that a supervisor learns to ignore.

What *is* observable, and what this detector reports:

- **Synthetic devices.** Third-party capture stacks install virtual cameras and
  loopback audio cables, and `enumerateDevices()` lists them by name. This is the
  main signal, and it is an observation rather than an inference. Note that it is
  a *capability*, not an act: `third-party-device` means the software is
  installed, which is why it is `medium` while actually using one is `high`.
- **The live camera track.** Its label identifies the device, so a candidate
  feeding a pre-recorded video through OBS is caught even when the virtual camera
  was plugged in after the initial scan. A track carrying `displaySurface` is a
  screen capture wearing a camera's label — the most conclusive signal available
  from inside a page.
- **Screen shares this page starts.** `getDisplayMedia` is wrapped while the
  detector runs and restored on `destroy()`. A share started in Zoom, Discord, or
  from the OS never passes through the page and is invisible here.

Two caveats worth designing around:

- **The device scan is blind without permission.** Browsers blank `label` until
  the user has granted access to that kind at least once. With no permission the
  scan runs, finds nothing, and logs a `debug` line saying so — silence here means
  "could not see", not "clean". Run it next to `camera`, or call
  `proctor.getDetector('thirdParty').scan()` right after permission is granted.
- **No stream is opened and nothing is uploaded.** This detector never calls
  `getUserMedia` itself; `detectActiveCamera` reads the camera detector's existing
  track, so enabling both costs no extra permission prompt.

---

## Periodic snapshots

Stills taken on a timer, emitted as `snapshot`. They are **samples, not
violations**: they never enter the report, the score, or the screenshot budget.

| Source | How to enable | What it captures |
|---|---|---|
| `webcam` | `camera.snapshotIntervalMs > 0` | The candidate's camera, read from the stream the camera detector already holds |
| `page` | `pageCapture.enabled` + `proctor.startPageCapture()` | A screen the candidate chose to share |

```js
const proctor = new Proctor({
  camera: { enabled: true, videoElement: '#preview', snapshotIntervalMs: 30000 },
  pageCapture: { enabled: true, intervalMs: 30000, maxWidth: 640 },
  backend: {
    enabled: true,
    endpoint: 'https://api.example/violations',
    snapshotEndpoint: 'https://api.example/snapshots', // falls back to endpoint
  },
});

proctor.on('snapshot', (s) => console.log(s.source, s.bytes));
await proctor.start();
```

Each snapshot is `{ source, at, dataUrl, bytes, width, height }`. It is emitted as
an event and, when a backend is configured, POSTed as `{ snapshots: [ … ] }` to
`backend.snapshotEndpoint`. Snapshots are **not queued and not retried** — a
backlog of stale frames arriving late is worse than a gap, and there is always
another one coming. A failed upload is swallowed.

### Page capture needs a click, and cannot be faked

```js
// From a click handler — never from start().
button.addEventListener('click', () => proctor.startPageCapture());
```

A page cannot rasterise its own DOM: there is no native DOM-to-image API, and
`html2canvas` would be a runtime dependency, which this library does not take. The
only zero-dependency route is `getDisplayMedia()`, and the browser gates that on
**transient activation** — so `startPageCapture()` has to be called from a real
user gesture and can never run unattended. `pageCapture.enabled` merely permits
the call; nothing switches it on by itself.

The candidate picks the surface, so `displaySurface: 'browser'` is a hint about
what to ask for, not a guarantee of what they choose. Capture also ends by itself
when they press "Stop sharing" in the browser's own UI.

> **Watch out:** with `thirdParty.detectScreenShare` on, your own page capture is
> reported as `screen-share-started`. That is correct — the page really is sharing
> its screen — but it means the two features flag each other. Filter out the
> `source: 'getDisplayMedia'` event, or leave `detectScreenShare` off.

`stopPageCapture()` releases the surface and is safe to call when idle;
`isPageCapturing()` reports the current state.

---

## Sending violations to a backend

```js
new Proctor({
  backend: {
    enabled: true,
    endpoint: 'https://api.example.com/proctoring',
    includeReport: false,
    minSeverity: 'medium',   // don't report every glance away
  },
});
```

Each request is `POST` with:

```json
{ "violations": [ { "id": "vio_...", "type": "tab-hidden", ... } ], "sentAt": "..." }
```

Reliability behaviour:

- **Retries** use exponential backoff, but only for network errors and `5xx`. A
  `4xx` is treated as a bug in your endpoint and is not retried.
- **`navigator.sendBeacon`** is used on page unload, because a normal `fetch` is
  cancelled when the document goes away — which is exactly when `tab-hidden`
  fires.
- **`offlineQueue`** keeps unsent violations in memory and flushes on the next
  successful request.

### Reporting while the page is dying

`tabs.reportOnClose` raises `tab-closed` from the `pagehide` handler — the last
reliable moment before a document is torn down. Delivery there is a special case,
and an easy one to get wrong:

- The transport's own `pagehide` listener is registered when the session is
  constructed, so it runs **before** the detector's and flushes an empty queue.
  A `tab-closed` queued after that would die with the document.
- So a terminal violation skips the queue entirely and goes straight out over
  `sendBeacon`. `proctor.reportViolation(type, details, { terminal: true })` does
  the same for your own end-of-session reports.

Two honest caveats. `pagehide` fires for a **close, a reload and a navigation**
alike, and no API separates them, so `tab-closed` means "the page went away".
And delivery is best-effort: `beforeunload` may not run at all, and a beacon can
still be dropped. Treat a missing `tab-closed` as **unknown**, never as "clean" —
which is why it is off by default.

---

## Face detection setup

By default (`provider: 'cdn'`) the library loads `@vladmandic/face-api` **1.7.15**
and its matching model weights from jsDelivr at runtime. Library and weights come
from the same published tarball, which avoids the version-mismatch bug that
silently produces garbage detections.

If you would rather self-host:

```js
face: {
  enabled: true,
  provider: 'module',                 // use your own installed copy
  providerOptions: {
    modelUrl: '/static/face-models/', // must end with a slash
  },
}
```

```bash
npm install @vladmandic/face-api
# then copy node_modules/@vladmandic/face-api/model/ into your public folder
```

You can also point the CDN provider at your own mirror:

```js
face: {
  enabled: true,
  provider: 'cdn',
  providerOptions: {
    scriptUrl: '/vendor/face-api.esm.js',
    modelUrl: '/models/face-api/',
  },
}
```

> **Note:** the `models/` folder committed in this repository is ~18 MB and is
> **not** published to npm. Only `dist/` ships. See `.npmignore`.

---

## CDN / script tag usage

```html
<script src="https://cdn.jsdelivr.net/npm/proctoring.js/dist/proctoring.umd.js"></script>
<script>
  const proctor = new Proctoring.Proctor({ camera: { enabled: true } });
  proctor.on('violation', console.log);
  proctor.start();
</script>
```

The UMD build exposes the namespace as `window.Proctoring`.

A complete, self-contained example lives in [`netlify-demo/index.html`](./netlify-demo/index.html)
— one HTML file, no build step, loading the published bundle from jsDelivr. It is
deployed at https://proctoring-js-demo.netlify.app.

```bash
npm run deploy:demo    # redeploy netlify-demo/ to Netlify
```

---

## Browser support

Requires a **secure context** (`https://` or `http://localhost`) — browsers only
expose `getUserMedia` there. Tab detection works everywhere.

| Feature | Requirement |
|---|---|
| `tabs` | Page Visibility API (universal) |
| `rightClick` | `contextmenu` event (universal) |
| `shortcuts` | `keydown` event (universal) |
| `camera` | `navigator.mediaDevices.getUserMedia` |
| `face` | WebGL (via TensorFlow.js) |
| `audio` | Web Audio API |

Node has no DOM, so `start()` rejects outside a browser. The module is still
safe to import at top level, which makes SSR and unit-test imports work.

---

## Security and privacy notes

This library helps you *observe* a session. It cannot make a browser exam
tamper-proof — a determined candidate with devtools or a second machine can
defeat any client-side proctoring. Treat its output as a signal for human review,
not as proof.

- Violations are stored in `sessionStorage`, which the candidate can clear.
  Use `backend.endpoint` for a trail you control.
- `report.captureScreenshots` is off by default; enabling it captures webcam
  frames and may create a legal obligation to notify candidates. The frames are
  never persisted to storage and never uploaded unless you also enable the
  backend.
- Periodic snapshots (`camera.snapshotIntervalMs`, `pageCapture`) are off by
  default for the same reason. Page capture additionally requires the candidate
  to grant screen sharing from a click, so it can never start on its own.
- The clipboard is never read. Copy/paste detection records the event, the
  element it happened in, and the character count — never the text.
- Audio is analysed in memory and discarded — the library never records it.
- Always tell candidates what is being monitored before the session starts.

---

## Development

```bash
npm install
npm run dev              # demo page at http://localhost:5173/demo.html
npm run build            # emits dist/proctoring.js, .cjs, .umd.js + index.d.ts
npm test                 # build + 157 checks against the built artifact
```

Five suites, 246 checks in total:

| Command | Checks | What it proves |
|---|---|---|
| `npm run verify` | 157 | Build output, exports, report math, screenshot helpers, and the decision logic of every detector including clipboard, tab-close and snapshot routing |
| `npm run verify:browser` | 64 | Real Edge: tab switch, right-click, keyboard shortcuts, camera stream, audio sampler, device scan, live-camera-track match, real copy/cut/paste, tab-closed beaconing, webcam and page snapshots, `getDisplayMedia` wrap/restore, teardown, screenshots |
| `npm run verify:umd` | 6 | The `<script src>` path via a plain static server |
| `npm run verify:face` | 7 | face-api CDN + weights resolve and inference runs |
| `npm run verify:static` | 12 | The deployed demo shape: one HTML file + the published CDN bundle |

`npm test` runs against `dist/`, not `src/`, so a build regression (a missing
export, broken CJS interop) fails here rather than in a consumer's app.

`npm run verify:all` chains the first four. `verify:static` is deliberately left
out: it loads the demo's pinned CDN bundle, so it can only pass *after* that
version is published — chaining it would make `verify:all` fail on every
pre-release run. Run it as the last step of a release instead.

`verify:static` also accepts a deployed URL, so a deploy can be checked rather
than assumed:

```bash
DEMO_URL=https://proctoring-js-demo.netlify.app npm run verify:static
```

The browser suites drive real Edge over CDP. They need Bun and a dev server:

```bash
npm run dev -- --port 5180 --strictPort   # in one shell
npm run verify:browser                    # in another
npm run verify:face                       # downloads ~2MB of models
```

They launch Edge with `--use-fake-device-for-media-stream`, so the camera and
audio checks run with no physical hardware and no permission prompt.

The CDP driver is vendored at [`scripts/lib/cdp.mjs`](./scripts/lib/cdp.mjs) — a
dependency-free copy, so the suites run on any clone without installing a
browser-automation stack. It is Windows-only: it looks for `msedge.exe` in the
two standard install locations and speaks DevTools Protocol over a WebSocket.
Set `edgePath` if Edge lives elsewhere.

The release version is read from `package.json` by
[`scripts/lib/pkg.mjs`](./scripts/lib/pkg.mjs), so bumping the version is a
one-line change plus the pin in `netlify-demo/index.html`.

Two deliberate testing choices worth knowing:

- **Detector decision rules are unit-tested with synthetic input**, not through
  a real face or microphone. A real camera cannot be made to show exactly two
  faces on demand, so `_evaluate` / `_sample` are driven directly with stubbed
  detections and analyser buffers. That tests *our* thresholds and grace
  periods deterministically; face-api's detection accuracy is upstream's concern.
- **The synthetic microphone is silent**, so the browser suite asserts the
  absence of a false positive rather than a real `audio-too-loud` event. The
  loud path is covered by the stubbed-analyser tests.
- **The third-party camera path runs against a real track**, because what needs
  proving there is not the matching rule (unit-tested) but that the detector
  reads the *camera detector's own* live track. The browser suite counts
  `getUserMedia` calls and fails on more than one, which is what backs the claim
  that enabling both costs no second permission prompt. A clean machine must
  also stay silent, so the suite asserts the absence of a false
  `virtual-camera-active` before forcing a match by declaring the local label as
  a pattern — and asserts it fires once, not once per tick.

Right-click detection, keyboard shortcuts and clipboard detection get the
opposite treatment: `verify:browser` pushes a **real** right-click, a **real**
`Ctrl+Shift+I` and a **real** `Ctrl+C` / `Ctrl+X` / `Ctrl+V` through Edge's input
pipeline via `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`, because a
page-scripted `dispatchEvent` proves only that a listener exists — it cannot
trigger a browser shortcut, so it cannot prove the detector sees what a user
produces. That is how the double-count bug in `throttleMs: 0` was found: the unit
tests were happy with a config the browser then disproved.

The genuine keystroke check runs with `block: true`, which serves two purposes at
once — it proves `preventDefault` reaches the browser before the shortcut is
acted on, and it stops Edge from actually opening DevTools in the middle of the
run. The same check proves `clipboard.block` suppresses a real copy, observed
through `defaultPrevented` on a listener registered *after* the detector's.

Two more things only a browser can prove. `tab-closed` is dispatched as a genuine
`PageTransitionEvent` on the real `window`, with `navigator.sendBeacon` stubbed —
which is what shows the violation leaves the page instead of dying in the queue.
And periodic snapshots are checked against real pixels: a live track for the
webcam source, and a genuine `getDisplayMedia` surface for the page source.

> The UMD check spawns its own static server rather than using Vite, because
> Vite's dev server pipes every `.js` through its ESM transform and would inject
> an `import` into the UMD wrapper. The same applies if you test the bundle by
> hand — serve it as a plain static file.

### Project layout

| Path | What it is |
|---|---|
| `src/` | Library source. `core/` holds the orchestrator; `detectors/` is the registry, where a new feature is one file plus one entry. |
| `scripts/` | The verification suites and the Netlify deploy helper. Not published. |
| `netlify-demo/` | The static demo site, hosted separately at `proctoring-js-demo.netlify.app`. |
| `demo.html` | The richer demo page served by `npm run dev`. |
| `models/` | Local face-api weights for the `module` and `custom` providers (~18 MB). Tracked for convenience, excluded from the tarball. |
| `legacy/` | Frozen snapshot of the first prototype — the plain vanilla-JS app this library was rewritten from, one `modules/*.js` file per detector idea. Not built, not tested, not published — see [`legacy/README.md`](./legacy/README.md). |

### Environment variables

**None are required.** Every one has a working fallback, and `npm test` plus all
four `verify:*` suites run with nothing set. Copy [`.env.example`](./.env.example)
to `.env` if you want to override any of them:

```bash
cp .env.example .env
```

| Variable | Used by | Fallback when unset |
|---|---|---|
| `NETLIFY_AUTH_TOKEN` | `npm run deploy:demo` | the token `netlify login` saved to `%APPDATA%/netlify/Config/config.json` |
| `DEMO_URL` | `npm run verify:static` | verifies the local `netlify-demo/` folder instead of the live site |
| `PYTHON` | `verify:umd`, `verify:static` | `python` on `PATH` — set it if that is a Windows Store shim |
| `NODE_AUTH_TOKEN`, `NPM_TOKEN` | `node scripts/check-npm-auth.mjs` | `_authToken` in `~/.npmrc` |

Two details worth knowing:

- **The library itself reads no environment variables.** It is a browser package;
  `backend.endpoint` and every detector option are passed to the `Proctor`
  constructor at runtime.
- **Loading is uniform.** Bun loads `.env` on its own (so the `verify:*` suites
  already see it); the two scripts run with plain `node` import
  `scripts/load-env.mjs`, which calls `process.loadEnvFile`. The real environment
  always wins over `.env`, under both runtimes, so a one-off
  `DEMO_URL=… npm run verify:static` still overrides the file.

`.env` is gitignored and excluded from the npm tarball. `.env.example` is
committed — never put a real secret in it.

## License

MIT
