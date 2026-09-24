# proctoring.js

Zero-dependency browser proctoring toolkit. Detects tab switching, camera
tampering, missing or extra faces, and room noise — through one small event API.

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
  `MediaRecorder`, no screenshots unless you opt in.
- **A broken feature never kills the session.** If the camera is denied, tab
  monitoring keeps running and you get a `detector:error` event.
- **Permissions are opt-in.** Only tab detection is on by default, because it
  needs no permission prompt.

---

## Detectors

| Detector | Default | Permissions | What it catches |
|---|---|---|---|
| `tabs` | **on** | none | Tab switch, window blur, page hidden |
| `camera` | off | camera | Denied camera, muted track, covered lens, frozen feed, unplugged device |
| `face` | off | camera (shared) | No face, multiple faces, looking away |
| `audio` | off | microphone | Sustained loud noise, spectral busyness |

Face detection reuses the camera detector's stream, so enabling both costs one
permission prompt, not two.

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
  },

  camera: {
    enabled: false,
    videoElement: '#preview',       // selector, element, or null for no preview
    width: 640,
    height: 480,
    detectMuted: true,              // lens covered / revoked
    detectEnded: true,              // device unplugged
    throttleMs: 2000,
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

  backend: {
    enabled: false,
    endpoint: null,                 // POST target for violations
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
| `window-blur` | medium | Window lost focus while still visible |
| `camera-denied` | critical | Permission refused |
| `camera-disabled` | critical | Track ended — device gone or revoked |
| `camera-muted` | high | Track muted, or the image froze |
| `face-not-detected` | medium | No face for longer than `awayGraceMs` |
| `face-multiple` | high | More than `maxFaces` faces |
| `face-looking-away` | low | Face present but off-centre |
| `audio-too-loud` | low | RMS above threshold, sustained |
| `audio-multiple-voices` | medium | Spectral busyness above threshold |

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
- Audio is analysed in memory and discarded — the library never records it.
- Always tell candidates what is being monitored before the session starts.

---

## Development

```bash
npm install
npm run dev              # demo page at http://localhost:5173/demo.html
npm run build            # emits dist/proctoring.js, .cjs, .umd.js + index.d.ts
npm test                 # build + 57 checks against the built artifact
```

Four suites, 93 checks in total:

| Command | Checks | What it proves |
|---|---|---|
| `npm run verify` | 57 | Build output, exports, report math, screenshot helpers, face + audio decision logic |
| `npm run verify:browser` | 23 | Real Edge: tab switch, camera stream, audio sampler, teardown, screenshots |
| `npm run verify:umd` | 6 | The `<script src>` path via a plain static server |
| `npm run verify:face` | 7 | face-api CDN + weights resolve and inference runs |
| `npm run verify:static` | 8 | The deployed demo shape: one HTML file + the published CDN bundle |

`npm test` runs against `dist/`, not `src/`, so a build regression (a missing
export, broken CJS interop) fails here rather than in a consumer's app.

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

Two deliberate testing choices worth knowing:

- **Detector decision rules are unit-tested with synthetic input**, not through
  a real face or microphone. A real camera cannot be made to show exactly two
  faces on demand, so `_evaluate` / `_sample` are driven directly with stubbed
  detections and analyser buffers. That tests *our* thresholds and grace
  periods deterministically; face-api's detection accuracy is upstream's concern.
- **The synthetic microphone is silent**, so the browser suite asserts the
  absence of a false positive rather than a real `audio-too-loud` event. The
  loud path is covered by the stubbed-analyser tests.

> The UMD check spawns its own static server rather than using Vite, because
> Vite's dev server pipes every `.js` through its ESM transform and would inject
> an `import` into the UMD wrapper. The same applies if you test the bundle by
> hand — serve it as a plain static file.

## License

MIT
