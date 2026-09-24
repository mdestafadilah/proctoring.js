/**
 * Post-build smoke test.
 *
 * Verifies the published artifact — not the source — so a build regression
 * (missing export, broken CJS interop) fails here rather than in a consumer's
 * app. Runs in Node, which also proves the module is safe to import without a
 * DOM (SSR / unit tests import it at top level).
 *
 *   node scripts/verify.mjs
 */
import { pkg } from './lib/pkg.mjs';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');

/** Dynamic import requires a file:// URL — a bare Windows path is rejected. */
const asUrl = (filename) => pathToFileURL(resolve(dist, filename)).href;

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function group(name) {
  console.log(`\n${name}`);
}

/**
 * Async sibling of `check`.
 *
 * Some decision logic is inherently asynchronous (`enumerateDevices()`, and the
 * `getDisplayMedia` wrapper). A promise returned from `check` would settle
 * *after* the check had already been counted as passing, so a genuine failure
 * would surface as an unhandled rejection next to a green tick.
 */
async function checkAsync(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

// ---------------------------------------------------------------------------
group('ESM build');

const esm = await import(asUrl('proctoring.js'));
const {
  Proctor,
  createProctor,
  EVENTS,
  VIOLATION_TYPES,
  DETECTOR_NAMES,
  CDN_DEFAULTS,
  FACE_API_VERSION,
  DEFAULT_OPTIONS,
  formatDuration,
  formatReport,
  mergeReports,
  diffReports,
  reportToCsv,
  computeRms,
  computeSpectralDensity,
  captureFrame,
  isVisualViolation,
  dataUrlBytes,
  FaceDetector,
  AudioDetector,
  RightClickDetector,
  ShortcutsDetector,
  DEVTOOLS_COMBOS,
  parseCombo,
  detectPlatform,
  ThirdPartyDetector,
  KNOWN_THIRD_PARTY_DEVICES,
  matchThirdPartyDevice,
  ClipboardDetector,
  TabsDetector,
  version,
} = esm;

check('Proctor is a constructor', () => assert.equal(typeof Proctor, 'function'));
check('createProctor is a factory', () => assert.equal(typeof createProctor, 'function'));
check('default export is Proctor', () => assert.equal(esm.default, Proctor));
check('version matches package.json', () => assert.equal(version, pkg.version));
check('every detector is registered', () =>
  assert.deepEqual(
    [...DETECTOR_NAMES],
    ['tabs', 'rightClick', 'shortcuts', 'clipboard', 'camera', 'face', 'audio', 'thirdParty']
  ));
check('the registry maps names to classes', () =>
  assert.equal(esm.DETECTORS.shortcuts, ShortcutsDetector));
check('event names are stable', () => {
  assert.equal(EVENTS.VIOLATION, 'violation');
  assert.equal(EVENTS.READY, 'ready');
  assert.equal(EVENTS.DETECTOR_ERROR, 'detector:error');
});
check('violation type ids are the wire format', () => {
  assert.equal(VIOLATION_TYPES.TAB_HIDDEN, 'tab-hidden');
  assert.equal(VIOLATION_TYPES.FACE_MULTIPLE, 'face-multiple');
  assert.equal(VIOLATION_TYPES.RIGHT_CLICK, 'right-click');
  assert.equal(VIOLATION_TYPES.SHORTCUT_USED, 'shortcut-used');
  assert.equal(VIOLATION_TYPES.THIRD_PARTY_DEVICE, 'third-party-device');
  assert.equal(VIOLATION_TYPES.VIRTUAL_CAMERA_ACTIVE, 'virtual-camera-active');
  assert.equal(VIOLATION_TYPES.SCREEN_SHARE_STARTED, 'screen-share-started');
});
check('only tabs is enabled by default', () => {
  assert.equal(DEFAULT_OPTIONS.tabs.enabled, true);
  assert.equal(DEFAULT_OPTIONS.rightClick.enabled, false);
  assert.equal(DEFAULT_OPTIONS.shortcuts.enabled, false);
  assert.equal(DEFAULT_OPTIONS.camera.enabled, false);
  assert.equal(DEFAULT_OPTIONS.face.enabled, false);
  assert.equal(DEFAULT_OPTIONS.audio.enabled, false);
  assert.equal(DEFAULT_OPTIONS.thirdParty.enabled, false);
});
check('face CDN URL is pinned to the runtime version', () => {
  assert.ok(CDN_DEFAULTS.scriptUrl.includes(`@${FACE_API_VERSION}`));
  assert.ok(FACE_API_VERSION === '1.7.15');
  assert.ok(CDN_DEFAULTS.modelUrl.endsWith('/'), 'model URL must end with a slash');
});

// ---------------------------------------------------------------------------
group('CJS build (require interop)');

const require = createRequire(import.meta.url);
const cjs = require(resolve(dist, 'proctoring.cjs'));
check('require() returns the namespace', () => assert.equal(typeof cjs.Proctor, 'function'));
check('named exports survive CJS', () => {
  assert.equal(cjs.EVENTS.VIOLATION, 'violation');
  assert.deepEqual(
    [...cjs.DETECTOR_NAMES],
    ['tabs', 'rightClick', 'shortcuts', 'clipboard', 'camera', 'face', 'audio', 'thirdParty']
  );
});
check('CommonJS and ESM expose identical keys', () => {
  const esmKeys = Object.keys(esm).filter((k) => k !== 'default').sort();
  const cjsKeys = Object.keys(cjs).filter((k) => k !== 'default').sort();
  assert.deepEqual(cjsKeys, esmKeys, 'CJS build is missing exports present in ESM');
});

// ---------------------------------------------------------------------------
group('pure helpers');

check('formatDuration handles hours', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(1000), '1s');
  assert.equal(formatDuration(65000), '1m 5s');
  assert.equal(formatDuration(3661000), '1h 1m 1s');
});
check('formatDuration rejects bad input', () => {
  assert.equal(formatDuration(NaN), '0s');
  assert.equal(formatDuration(-5), '0s');
  assert.equal(formatDuration(undefined), '0s');
});
check('computeRms is correct', () => {
  assert.ok(Math.abs(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-9);
  assert.equal(computeRms(new Float32Array([0, 0, 0, 0])), 0);
});
check('computeSpectralDensity spans 0..1', () => {
  assert.equal(computeSpectralDensity(new Uint8Array(64)), 0);
  assert.equal(computeSpectralDensity(new Uint8Array(64).fill(200)), 1);
});
check('reportToCsv quotes cells containing commas and quotes', () => {
  const csv = reportToCsv({
    violations: [
      {
        id: 'v1',
        type: 'tab-hidden',
        severity: 'high',
        detector: 'tabs',
        timestamp: Date.UTC(2026, 0, 1),
        elapsedMs: 10,
        details: { note: 'a, "quoted" value' },
      },
    ],
  });
  const [header, row] = csv.split('\r\n');
  assert.equal(header, 'id,type,severity,detector,timestamp,elapsedMs,details');
  assert.ok(row.startsWith('v1,tab-hidden,high,tabs,2026-01-01T00:00:00.000Z,10,'));

  // The details cell contains a comma and quotes, so it must be wrapped in
  // quotes with every inner `"` doubled (RFC 4180).
  const cell = row.slice('v1,tab-hidden,high,tabs,2026-01-01T00:00:00.000Z,10,'.length);
  assert.ok(cell.startsWith('"') && cell.endsWith('"'), 'cell must be quoted');

  const inner = cell.slice(1, -1);
  // After removing the outer quotes, every remaining `"` must be doubled.
  assert.equal(
    (inner.match(/""/g) || []).length * 2 + (inner.match(/(?<!")"(?!")/g) || []).length,
    (inner.match(/"/g) || []).length,
    'every inner quote must be part of a doubled pair'
  );
  assert.ok(inner.includes('""note""'), 'object keys must be escaped too');
});
check('mergeReports combines sessions in time order', () => {
  const merged = mergeReports([
    {
      sessionId: 'a',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T01:00:00.000Z',
      violations: [{ id: 'x', type: 'tab-hidden', severity: 'high', timestamp: 200 }],
    },
    {
      sessionId: 'b',
      startedAt: '2026-01-01T00:10:00.000Z',
      endedAt: '2026-01-01T00:30:00.000Z',
      violations: [{ id: 'y', type: 'window-blur', severity: 'medium', timestamp: 100 }],
    },
  ]);
  assert.equal(merged.sessions, 2);
  assert.equal(merged.total, 2);
  assert.equal(merged.violations[0].id, 'y', 'violations must be sorted by timestamp');
  assert.equal(merged.durationMs, 3600000);
  assert.equal(merged.countsByType['tab-hidden'], 1);
});
check('mergeReports([]) is safe', () => {
  const merged = mergeReports([]);
  assert.equal(merged.total, 0);
  assert.equal(merged.startedAt, null);
});
check('diffReports isolates new violations', () => {
  const before = { total: 1, violations: [{ id: 'a' }] };
  const after = { total: 2, violations: [{ id: 'a' }, { id: 'b' }] };
  const d = diffReports(before, after);
  assert.equal(d.addedCount, 1);
  assert.equal(d.added[0].id, 'b');
});

// ---------------------------------------------------------------------------
group('screenshots');

check('captureFrame returns null without a video element', () => {
  assert.equal(captureFrame(null), null);
  assert.equal(captureFrame(undefined), null);
});

check('captureFrame returns null when the video has no frames', () => {
  // readyState 0 (HAVE_NOTHING) — drawImage would throw or produce a blank.
  assert.equal(captureFrame({ readyState: 0, videoWidth: 640, videoHeight: 480 }), null);
  // Metadata present but zero dimensions — also unusable.
  assert.equal(captureFrame({ readyState: 4, videoWidth: 0, videoHeight: 0 }), null);
});

check('captureFrame never throws on a hostile element', () => {
  // A getter that throws must be contained, not propagated.
  const hostile = {
    get readyState() {
      throw new Error('detached');
    },
  };
  assert.equal(captureFrame(hostile), null);
});

check('isVisualViolation defaults to camera and face only', () => {
  assert.equal(isVisualViolation('camera-muted', 'camera', null), true);
  assert.equal(isVisualViolation('face-multiple', 'face', null), true);
  // An audio violation must not carry a webcam still — misleading evidence.
  assert.equal(isVisualViolation('audio-too-loud', 'audio', null), false);
  assert.equal(isVisualViolation('tab-hidden', 'tabs', null), false);
  // Neither should a right-click: a webcam frame proves nothing about a mouse.
  assert.equal(isVisualViolation('right-click', 'rightClick', null), false);
  // Nor a keystroke.
  assert.equal(isVisualViolation('shortcut-used', 'shortcuts', null), false);
});

check('isVisualViolation honours an explicit allow-list', () => {
  assert.equal(isVisualViolation('tab-hidden', 'tabs', ['tab-hidden']), true);
  assert.equal(isVisualViolation('camera-muted', 'camera', ['tab-hidden']), false);
  // An empty list falls back to the default rather than allowing everything.
  assert.equal(isVisualViolation('camera-muted', 'camera', []), true);
});

check('dataUrlBytes decodes base64 length correctly', () => {
  // "AAAA" -> 3 bytes, no padding.
  assert.equal(dataUrlBytes('data:image/jpeg;base64,AAAA'), 3);
  // "AAA=" -> 2 bytes.
  assert.equal(dataUrlBytes('data:image/jpeg;base64,AAA='), 2);
  // "AA==" -> 1 byte.
  assert.equal(dataUrlBytes('data:image/jpeg;base64,AA=='), 1);
  assert.equal(dataUrlBytes('not-a-data-url'), 0);
  assert.equal(dataUrlBytes(null), 0);
});

check('screenshot options default to off and small', () => {
  assert.equal(DEFAULT_OPTIONS.report.captureScreenshots, false);
  assert.equal(DEFAULT_OPTIONS.report.screenshotMaxWidth, 320);
  assert.ok(DEFAULT_OPTIONS.report.screenshotBudgetBytes > 0);
});

// ---------------------------------------------------------------------------
group('face decision logic');

/**
 * Drives FaceDetector._evaluate directly with synthetic detections.
 *
 * Deliberately bypasses face-api: this suite tests OUR rules (how many faces
 * count as cheating, how far off-centre is "looking away"), not face-api's
 * detection accuracy, which is upstream's concern and cannot be reproduced
 * deterministically in CI anyway.
 */
function makeFaceHarness(overrides = {}) {
  const violations = [];
  const config = {
    requireFace: true,
    awayGraceMs: 0,
    maxFaces: 1,
    multiFaceConfirmMs: 0,
    lookAwayTolerance: 0.25,
    throttleMs: 0,
    ...overrides,
  };
  const context = {
    options: {},
    report: (type, details, meta) => violations.push({ type, details, ...meta }),
    log: () => {},
    emit: () => {},
    setState: () => {},
  };
  const detector = new FaceDetector(config, context);
  return { detector, violations };
}

/** A detection box centred at (cx, cy) in a 640x480 frame. */
const detectionAt = (cx, cy, size = 200) => ({
  box: { x: cx * 640 - size / 2, y: cy * 480 - size / 2, width: size, height: size },
  score: 0.9,
});

const VIDEO = { videoWidth: 640, videoHeight: 480 };

check('a single centred face produces no violation', () => {
  const { detector, violations } = makeFaceHarness();
  detector._evaluate([detectionAt(0.5, 0.5)], VIDEO);
  assert.deepEqual(violations, [], `unexpected: ${JSON.stringify(violations)}`);
});

check('no face past the grace period produces face-not-detected', () => {
  const { detector, violations } = makeFaceHarness({ awayGraceMs: 0 });
  detector._evaluate([], VIDEO);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'face-not-detected');
  assert.equal(violations[0].details.faceCount, 0);
});

check('face-not-detected fires only once per absence', () => {
  const { detector, violations } = makeFaceHarness({ awayGraceMs: 0 });
  detector._evaluate([], VIDEO);
  detector._evaluate([], VIDEO);
  detector._evaluate([], VIDEO);
  assert.equal(violations.length, 1, 'a sustained absence must not spam violations');
});

check('a face returning re-arms the absence detector', () => {
  const { detector, violations } = makeFaceHarness({ awayGraceMs: 0 });
  detector._evaluate([], VIDEO);
  assert.equal(violations.length, 1);
  detector._evaluate([detectionAt(0.5, 0.5)], VIDEO);
  detector._evaluate([], VIDEO);
  assert.equal(violations.length, 2, 'a second absence must be reported again');
});

check('the grace period suppresses a brief absence', () => {
  const { detector, violations } = makeFaceHarness({ awayGraceMs: 60_000 });
  detector._evaluate([], VIDEO);
  assert.deepEqual(violations, [], 'a short absence must not fire before the grace period');
});

check('two faces produce face-multiple', () => {
  const { detector, violations } = makeFaceHarness();
  detector._evaluate([detectionAt(0.35, 0.5), detectionAt(0.65, 0.5)], VIDEO);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'face-multiple');
  assert.equal(violations[0].details.faceCount, 2);
  assert.equal(violations[0].details.maxFaces, 1);
});

check('maxFaces is respected when raised', () => {
  const { detector, violations } = makeFaceHarness({ maxFaces: 2 });
  detector._evaluate([detectionAt(0.35, 0.5), detectionAt(0.65, 0.5)], VIDEO);
  assert.deepEqual(violations, [], 'two faces must be allowed when maxFaces is 2');
});

check('a centred face is not "looking away"', () => {
  const { detector, violations } = makeFaceHarness();
  for (let i = 0; i < 5; i += 1) detector._evaluate([detectionAt(0.5, 0.5)], VIDEO);
  assert.deepEqual(violations, []);
});

check('a face at the frame edge needs two samples before firing', () => {
  const { detector, violations } = makeFaceHarness();
  // Far left: centre at x=0.08, well outside the 0.25 tolerance.
  detector._evaluate([detectionAt(0.08, 0.5)], VIDEO);
  assert.deepEqual(violations, [], 'one off-centre frame is motion, not a violation');
  detector._evaluate([detectionAt(0.08, 0.5)], VIDEO);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'face-looking-away');
  assert.ok(violations[0].details.offset > 0.25);
});

check('lookAwayTolerance widens the acceptable zone', () => {
  const { detector, violations } = makeFaceHarness({ lookAwayTolerance: 0.9 });
  detector._evaluate([detectionAt(0.08, 0.5)], VIDEO);
  detector._evaluate([detectionAt(0.08, 0.5)], VIDEO);
  assert.deepEqual(violations, [], 'a lenient tolerance must accept an off-centre face');
});

check('a detection without a box does not crash evaluation', () => {
  const { detector, violations } = makeFaceHarness();
  detector._evaluate([{ score: 0.9 }], VIDEO);
  assert.deepEqual(violations, []);
});

check('a zero-sized video frame does not divide by zero', () => {
  const { detector, violations } = makeFaceHarness();
  detector._evaluate([detectionAt(0.08, 0.5)], { videoWidth: 0, videoHeight: 0 });
  detector._evaluate([detectionAt(0.08, 0.5)], { videoWidth: 0, videoHeight: 0 });
  // Infinity offsets would fire; NaN comparisons must fall through instead.
  assert.deepEqual(violations, [], 'a degenerate frame size must be ignored');
});

// ---------------------------------------------------------------------------
group('audio decision logic');

/**
 * Drives AudioDetector._sample() with a stubbed AnalyserNode.
 *
 * A real microphone cannot be made to produce a known loudness on demand, so the
 * threshold/grace/re-arm rules are tested here deterministically. The live
 * pipeline (getUserMedia → AudioContext → sampler) is covered by
 * verify-browser.mjs.
 */
function makeAudioHarness(overrides = {}) {
  const violations = [];
  const logs = [];
  const config = {
    rmsThreshold: 0.08,
    loudGraceMs: 1000,
    voiceThreshold: 0.5,
    fftSize: 1024,
    smoothingTimeConstant: 0.8,
    detectMultipleVoices: false,
    throttleMs: 0,
    ...overrides,
  };
  const context = {
    options: {},
    report: (type, details, meta) => violations.push({ type, details, ...meta }),
    log: (level, message, details) => logs.push({ level, message, details }),
    emit: () => {},
    setState: () => {},
  };
  const detector = new AudioDetector(config, context);

  /** Point the analyser at a constant amplitude, as if the mic heard it. */
  detector.analyser = {
    fftSize: config.fftSize,
    frequencyBinCount: 512,
    getFloatTimeDomainData(buffer) {
      buffer.fill(detector._amplitude ?? 0);
    },
    getByteFrequencyData(array) {
      array.fill(detector._density ?? 0);
    },
  };
  detector.buffer = new Float32Array(config.fftSize);
  detector.freqData = new Uint8Array(512);

  return { detector, violations, logs };
}

check('silence produces no violation', () => {
  const { detector, violations } = makeAudioHarness();
  detector._amplitude = 0;
  for (let i = 0; i < 10; i += 1) detector._sample();
  assert.deepEqual(violations, []);
});

check('a loud room past the grace period produces audio-too-loud', () => {
  const { detector, violations } = makeAudioHarness({ loudGraceMs: 0 });
  detector._amplitude = 0.5;
  detector._sample();
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'audio-too-loud');
  assert.ok(violations[0].details.rms > 0.08, 'the violation must record the measured level');
  assert.equal(violations[0].details.threshold, 0.08);
});

check('the grace period suppresses a brief spike', () => {
  const { detector, violations } = makeAudioHarness({ loudGraceMs: 60_000 });
  detector._amplitude = 0.5;
  detector._sample();
  assert.deepEqual(violations, [], 'a short spike must not fire before the grace period');
});

check('sustained loudness does not spam violations', () => {
  const { detector, violations } = makeAudioHarness({ loudGraceMs: 0 });
  detector._amplitude = 0.5;
  for (let i = 0; i < 20; i += 1) detector._sample();
  assert.equal(violations.length, 1, 'a continuous noise must be reported once, not per sample');
});

check('the room must quieten down before it can fire again', () => {
  const { detector, violations } = makeAudioHarness({ loudGraceMs: 0 });
  detector._amplitude = 0.5;
  detector._sample();
  assert.equal(violations.length, 1);

  // Loud again without a quiet gap: still only one violation.
  detector._sample();
  assert.equal(violations.length, 1);

  // Drop well below the re-arm point (60% of threshold), then go loud again.
  detector._amplitude = 0;
  detector._sample();
  detector._amplitude = 0.5;
  detector._sample();
  assert.equal(violations.length, 2, 'a genuine second noise must be reported');
});

check('a level just under the threshold is ignored', () => {
  const { detector, violations } = makeAudioHarness({ loudGraceMs: 0, rmsThreshold: 0.08 });
  detector._amplitude = 0.07;
  for (let i = 0; i < 5; i += 1) detector._sample();
  assert.deepEqual(violations, [], 'below-threshold noise must never fire');
});

check('detectMultipleVoices is off by default', () => {
  const { detector, violations } = makeAudioHarness({ loudGraceMs: 60_000 });
  detector._amplitude = 0;
  detector._density = 255;
  for (let i = 0; i < 5; i += 1) detector._sample();
  assert.deepEqual(violations, [], 'spectral analysis must be opt-in');
});

check('spectral density reports multiple voices when enabled', () => {
  const { detector, violations } = makeAudioHarness({
    detectMultipleVoices: true,
    loudGraceMs: 60_000,
  });
  detector._amplitude = 0;
  detector._density = 255;
  detector._sample();
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'audio-multiple-voices');
  assert.ok(violations[0].details.density >= 0.5);
});

check('enabling detectMultipleVoices warns that it is experimental', () => {
  const { logs } = makeAudioHarness({ detectMultipleVoices: true });
  const warnings = logs.filter((entry) => entry.level === 'warn');
  assert.equal(warnings.length, 1, 'exactly one warning, emitted at construction');
  assert.match(warnings[0].message, /experimental/);
  assert.match(warnings[0].message, /not speaker count/);
  assert.equal(warnings[0].details.voiceThreshold, 0.5);
});

check('the experimental warning is absent on the default path', () => {
  const { logs } = makeAudioHarness();
  assert.deepEqual(logs, [], 'a detector that is off must not log anything');
});

// ---------------------------------------------------------------------------
// Known limitations of the spectral metric.
//
// These are CHARACTERISATION checks, not desired behaviour. They pin the
// measurements quoted in the `computeSpectralDensity` JSDoc, the `voiceThreshold`
// option docs and the README, so those comments cannot quietly become lies.
// If someone improves the metric these checks SHOULD fail — that is the point:
// update them together with the documentation, never on their own.
// ---------------------------------------------------------------------------

/** A plausible speech-like spectrum: strong low-mid, decaying harmonic tail. */
const SPEECH_SPECTRUM = [200, 185, 170, 150, 128, 105, 88, 70, 55, 42, 30, 22, 15, 10, 6, 3];

/** Place values into a 512-bin spectrum, optionally scaled to change loudness. */
const asSpectrum = (values, gain = 1) => {
  const out = new Uint8Array(512);
  out.set(values.map((v) => Math.min(255, Math.round(v * gain))));
  return out;
};

check('KNOWN LIMITATION: the density score rises with volume alone', () => {
  const quiet = computeSpectralDensity(asSpectrum(SPEECH_SPECTRUM, 0.3));
  const loud = computeSpectralDensity(asSpectrum(SPEECH_SPECTRUM, 1));
  assert.ok(
    loud > quiet * 4,
    `one voice scores ${(loud / quiet).toFixed(1)}x higher merely for being louder ` +
      `(quiet=${quiet}, loud=${loud}) — the floor is absolute, so the metric is not gain-invariant`
  );
});

check('KNOWN LIMITATION: a noisy room outscores any voice count', () => {
  const noisyRoom = computeSpectralDensity(asSpectrum(new Array(64).fill(90)));
  const oneVoice = computeSpectralDensity(asSpectrum(SPEECH_SPECTRUM));
  assert.ok(
    noisyRoom > oneVoice * 5,
    `background noise (${noisyRoom}) must dominate voices (${oneVoice}) — that is why no ` +
      `threshold separates "several people talking" from "one person in a noisy room"`
  );
});

check('KNOWN LIMITATION: the default voiceThreshold is unreachable', () => {
  const loudestRealistic = Math.max(
    computeSpectralDensity(asSpectrum(SPEECH_SPECTRUM, 1)),
    computeSpectralDensity(asSpectrum(new Array(64).fill(90)))
  );
  assert.ok(
    loudestRealistic < 0.5,
    `the default of 0.5 is documented as unreachable, but a realistic spectrum scored ${loudestRealistic}`
  );
});

check('_sample is a no-op before the analyser exists', () => {
  const context = { options: {}, report: () => {}, log: () => {}, emit: () => {}, setState: () => {} };
  const detector = new AudioDetector({ rmsThreshold: 0.08, fftSize: 1024 }, context);
  // Must not throw when called before init().
  detector._sample();
});

// ---------------------------------------------------------------------------
group('right-click decision logic');

/**
 * Drives RightClickDetector's handlers with plain event objects.
 *
 * Node has no DOM, and `init()` would need a real `document` — but the decision
 * rules (which signals count, how a gesture is deduplicated, when the menu is
 * suppressed) are all reachable through the handlers, so they are tested here.
 * That the listeners are actually wired to real DOM events is proved separately
 * in verify-browser.mjs, against a real right-click.
 */
function makeRightClickHarness(overrides = {}) {
  const violations = [];
  const states = [];
  const config = {
    block: false,
    detectPointerDown: true,
    dedupeMs: 400,
    throttleMs: 0,
    captureTarget: true,
    ...overrides,
  };
  const context = {
    options: {},
    report: (type, details, meta) => violations.push({ type, details, ...meta }),
    log: () => {},
    emit: () => {},
    setState: (name, state) => states.push({ name, state }),
  };
  return { detector: new RightClickDetector(config, context), violations, states };
}

/** A secondary-button pointer event, with a `preventDefault` we can observe. */
const rightButtonEvent = (target = null, extra = {}) => ({
  button: 2,
  clientX: 120.4,
  clientY: 300.6,
  target,
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  ...extra,
});

const element = (tagName, id = '', className = '') => ({ nodeType: 1, tagName, id, className });

check('a contextmenu event produces a right-click violation', () => {
  const { detector, violations } = makeRightClickHarness();
  detector._handleContextMenu(rightButtonEvent(element('BUTTON', 'submit', 'primary big')));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'right-click');
  assert.equal(violations[0].detector, 'rightClick');
  assert.equal(violations[0].details.source, 'contextmenu');
});

check('the violation records where the click landed', () => {
  const { detector, violations } = makeRightClickHarness();
  detector._handleContextMenu(rightButtonEvent(element('BUTTON', 'submit', 'primary big')));
  assert.equal(violations[0].details.target, 'button#submit.primary.big');
  assert.equal(violations[0].details.x, 120, 'coordinates must be rounded integers');
  assert.equal(violations[0].details.y, 301);
});

check('captureTarget: false omits the element', () => {
  const { detector, violations } = makeRightClickHarness({ captureTarget: false });
  detector._handleContextMenu(rightButtonEvent(element('BUTTON', 'submit')));
  assert.equal(violations[0].details.target, null);
});

check('an SVG target does not leak an object into the report', () => {
  const { detector, violations } = makeRightClickHarness();
  // SVG elements expose className as an SVGAnimatedString, not a string.
  detector._handleContextMenu(
    rightButtonEvent({ nodeType: 1, tagName: 'svg', id: 'chart', className: { baseVal: 'icon' } })
  );
  assert.equal(violations[0].details.target, 'svg#chart');
});

check('a click on the page background is described as the document', () => {
  const { detector, violations } = makeRightClickHarness();
  detector._handleContextMenu(rightButtonEvent({ nodeType: 9 }));
  assert.equal(violations[0].details.target, 'document');
});

check('a secondary-button pointerdown also reports', () => {
  const { detector, violations } = makeRightClickHarness();
  detector._handlePointerDown(rightButtonEvent());
  assert.equal(violations.length, 1);
  assert.equal(violations[0].details.source, 'pointerdown');
});

check('a left click is ignored', () => {
  const { detector, violations } = makeRightClickHarness();
  detector._handlePointerDown(rightButtonEvent(null, { button: 0 }));
  // A wheel/middle click, and an event with no button at all, must be silent too.
  detector._handlePointerDown(rightButtonEvent(null, { button: 1 }));
  detector._handlePointerDown({});
  assert.deepEqual(violations, [], 'only the secondary button may fire');
});

check('one gesture reports once, not twice', () => {
  // A real right-click produces pointerdown *and* contextmenu. The pair must
  // collapse into a single violation — and with `throttleMs: 0`, so that the
  // result cannot be an accident of the rate limit. This exact case produced two
  // violations until dedupe was given its own rule.
  const { detector, violations } = makeRightClickHarness({ throttleMs: 0 });
  detector._handlePointerDown(rightButtonEvent());
  detector._handleContextMenu(rightButtonEvent());
  assert.equal(violations.length, 1, 'the pointerdown/contextmenu pair must be deduplicated');
  assert.equal(violations[0].details.source, 'pointerdown', 'the earlier signal wins');
});

check('a stale pointerdown does not swallow a later menu key', () => {
  const { detector, violations } = makeRightClickHarness({ dedupeMs: 400 });
  detector._handlePointerDown(rightButtonEvent());
  // Simulate the next gesture arriving well after the dedupe window.
  detector._lastPointerDownAt = Date.now() - 5_000;
  detector._handleContextMenu(rightButtonEvent(null, { button: 0 }));
  assert.equal(violations.length, 2, 'a separate gesture must still be reported');
  assert.equal(violations[1].details.source, 'contextmenu');
});

check('the dedupe window is consumed, not sticky', () => {
  const { detector, violations } = makeRightClickHarness({ dedupeMs: 400, throttleMs: 0 });
  detector._handlePointerDown(rightButtonEvent());
  detector._handleContextMenu(rightButtonEvent()); // the same gesture — dropped
  detector._handleContextMenu(rightButtonEvent()); // the keyboard Menu key — reported
  assert.equal(violations.length, 2, 'the window must be cleared after the duplicate');
  assert.equal(violations[1].details.source, 'contextmenu');
});

check('with pointerdown off, contextmenu is the only source', () => {
  const { detector, violations } = makeRightClickHarness({ detectPointerDown: false });
  detector._handleContextMenu(rightButtonEvent());
  assert.equal(violations.length, 1);
  assert.equal(violations[0].details.source, 'contextmenu');
});

check('a second gesture after the throttle window reports again', () => {
  const { detector, violations } = makeRightClickHarness({ throttleMs: 0 });
  detector._handleContextMenu(rightButtonEvent());
  detector._handleContextMenu(rightButtonEvent());
  assert.equal(violations.length, 2, 'a repeated right-click must not be swallowed forever');
});

check('throttleMs caps a right-click spammer', () => {
  const { detector, violations } = makeRightClickHarness({ throttleMs: 60_000 });
  for (let i = 0; i < 5; i += 1) detector._handleContextMenu(rightButtonEvent());
  assert.equal(violations.length, 1, 'the rate limit must hold regardless of dedupe');
});

check('block: true suppresses the menu and says so', () => {
  const { detector, violations } = makeRightClickHarness({ block: true });
  const event = rightButtonEvent();
  detector._handleContextMenu(event);
  assert.equal(event.defaultPrevented, true, 'the context menu must be prevented');
  assert.equal(violations[0].details.blocked, true);
});

check('block: false never touches the page', () => {
  const { detector } = makeRightClickHarness();
  const event = rightButtonEvent();
  detector._handleContextMenu(event);
  assert.equal(event.defaultPrevented, false, 'a library must not block the menu by default');
});

check('blocking survives a throttled report', () => {
  // The report is rate-limited, but the menu must be suppressed every time —
  // otherwise a second right-click would silently open it.
  const { detector, violations } = makeRightClickHarness({ block: true, throttleMs: 60_000 });
  const first = rightButtonEvent();
  const second = rightButtonEvent();
  detector._handleContextMenu(first);
  detector._handleContextMenu(second);
  assert.equal(violations.length, 1, 'the second report must be throttled away');
  assert.equal(second.defaultPrevented, true, 'the second menu must still be suppressed');
});

check('the detector publishes a state for the host UI', () => {
  const { detector, states } = makeRightClickHarness();
  detector._handleContextMenu(rightButtonEvent());
  const last = states.at(-1);
  assert.equal(last.name, 'rightClick');
  assert.equal(last.state.status, 'violation');
  assert.equal(last.state.count, 1);
  assert.equal(detector.getState().count, 1);
});

check('destroy() before init() is safe', () => {
  // Nothing was registered, so teardown must not reach for a document.
  const { detector } = makeRightClickHarness();
  detector.destroy();
  assert.equal(detector.getState().active, false);
});

// ---------------------------------------------------------------------------
group('keyboard shortcut decision logic');

/**
 * Drives ShortcutsDetector with plain event objects.
 *
 * `init()` needs a real `document`, but `_prepareCombos()` is the same code path
 * init uses, so the parsing rules — including the "warn and skip" behaviour for a
 * typo — are tested here rather than reimplemented in the test.
 */
function makeShortcutHarness(overrides = {}) {
  const violations = [];
  const logs = [];
  const states = [];
  const config = { combos: null, block: false, ...overrides };
  const context = {
    options: {},
    report: (type, details, meta) => violations.push({ type, details, ...meta }),
    log: (level, message, meta) => logs.push({ level, message, meta }),
    emit: () => {},
    setState: (name, state) => states.push({ name, state }),
  };
  const detector = new ShortcutsDetector(config, context);
  detector._prepareCombos(overrides.platform ?? 'other');
  return { detector, violations, logs, states };
}

const keyEvent = (overrides = {}) => ({
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
  isComposing: false,
  key: '',
  code: '',
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  ...overrides,
});

/**
 * Ctrl+Shift+I as Edge actually reports it: holding Shift uppercases `key`, which
 * is why a naive `event.key === 'i'` comparison silently never matches.
 */
const ctrlShiftI = () => keyEvent({ ctrlKey: true, shiftKey: true, key: 'I', code: 'KeyI' });

check('Ctrl+Shift+I produces a shortcut-used violation', () => {
  const { detector, violations } = makeShortcutHarness();
  detector._handleKeyDown(ctrlShiftI());
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'shortcut-used');
  assert.equal(violations[0].detector, 'shortcuts');
  assert.equal(violations[0].details.combo, 'ctrl+shift+i');
  assert.equal(violations[0].details.label, 'devtools');
});

check('the shift-uppercased key still matches', () => {
  const { detector, violations } = makeShortcutHarness();
  // Only `key` is present — a synthetic event, or an engine that omits `code`.
  detector._handleKeyDown(keyEvent({ ctrlKey: true, shiftKey: true, key: 'I' }));
  assert.equal(violations.length, 1, 'the uppercase "I" must be normalised');
});

check('a non-Latin layout still matches, via event.code', () => {
  const { detector, violations } = makeShortcutHarness();
  // A Cyrillic layout reports a different character but the same physical key.
  detector._handleKeyDown(keyEvent({ ctrlKey: true, shiftKey: true, key: 'Ш', code: 'KeyI' }));
  assert.equal(violations.length, 1, 'matching on event.key alone would miss this');
});

check('the report carries the raw key evidence', () => {
  const { detector, violations } = makeShortcutHarness();
  detector._handleKeyDown(ctrlShiftI());
  assert.equal(violations[0].details.key, 'I');
  assert.equal(violations[0].details.code, 'KeyI');
  assert.equal(violations[0].details.blocked, false);
});

check('F12 is matched too', () => {
  const { detector, violations } = makeShortcutHarness();
  detector._handleKeyDown(keyEvent({ key: 'F12', code: 'F12' }));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].details.label, 'devtools');
});

check('modifier sets must match exactly', () => {
  const { detector, violations } = makeShortcutHarness();
  // Ctrl+I is a different shortcut, and Ctrl+Shift+Alt+I must not satisfy a
  // ctrl+shift+i rule — a subset check would wrongly accept both.
  detector._handleKeyDown(keyEvent({ ctrlKey: true, key: 'I', code: 'KeyI' }));
  detector._handleKeyDown(keyEvent({ ctrlKey: true, shiftKey: true, altKey: true, key: 'I', code: 'KeyI' }));
  assert.deepEqual(violations, [], 'only the exact modifier set may fire');
});

check('AltGr cannot trip a ctrl rule', () => {
  // On Windows AltGr sets ctrlKey AND altKey. Typing an "i" that needs AltGr
  // must not look like a shortcut.
  const { detector, violations } = makeShortcutHarness({ combos: ['ctrl+alt+i'] });
  detector._handleKeyDown(keyEvent({ ctrlKey: true, altKey: true, key: 'i', code: 'KeyI' }));
  assert.equal(violations.length, 1, 'a rule that explicitly asks for ctrl+alt is honoured');

  // And no shipped default asks for ctrl+alt, so AltGr cannot fire one.
  for (const combo of DEVTOOLS_COMBOS.other) {
    assert.ok(!(combo.includes('ctrl') && combo.includes('alt')), `unsafe default: ${combo}`);
  }
});

check('a bare key press is ignored', () => {
  const { detector, violations } = makeShortcutHarness();
  detector._handleKeyDown(keyEvent({ key: 'i', code: 'KeyI' }));
  detector._handleKeyDown(keyEvent({ shiftKey: true, key: 'I', code: 'KeyI' }));
  assert.deepEqual(violations, []);
});

check('holding the key does not spam violations', () => {
  const { detector, violations } = makeShortcutHarness();
  detector._handleKeyDown(ctrlShiftI());
  detector._handleKeyDown(keyEvent({ ...ctrlShiftI(), repeat: true }));
  detector._handleKeyDown(keyEvent({ ...ctrlShiftI(), repeat: true }));
  assert.equal(violations.length, 1, 'auto-repeat must not be reported');
});

check('an IME composition is not a shortcut', () => {
  const { detector, violations } = makeShortcutHarness();
  detector._handleKeyDown(keyEvent({ ...ctrlShiftI(), isComposing: true }));
  assert.deepEqual(violations, [], 'mid-composition keys belong to the IME');
});

check('block: true prevents the default, and says so', () => {
  const { detector, violations } = makeShortcutHarness({ block: true });
  const event = ctrlShiftI();
  detector._handleKeyDown(event);
  assert.equal(event.defaultPrevented, true, 'preventDefault is the only way to stop the browser');
  assert.equal(violations[0].details.blocked, true);
});

check('block never touches keys the host did not ask about', () => {
  const { detector } = makeShortcutHarness({ block: true });
  const event = keyEvent({ key: 'a', code: 'KeyA' });
  detector._handleKeyDown(event);
  assert.equal(event.defaultPrevented, false, 'an unmatched keystroke must pass through');
});

check('custom combos replace the default list', () => {
  const { detector, violations } = makeShortcutHarness({ combos: ['ctrl+p'] });
  detector._handleKeyDown(ctrlShiftI());
  assert.deepEqual(violations, [], 'the default devtools combo is gone once combos is set');

  detector._handleKeyDown(keyEvent({ ctrlKey: true, key: 'p', code: 'KeyP' }));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].details.combo, 'ctrl+p');
  assert.equal(violations[0].details.label, null, 'an unknown combo has no label');
});

check('a typo in one combo does not disable the others', () => {
  const { detector, violations, logs } = makeShortcutHarness({
    combos: ['ctrl+shit+i', 'ctrl+shift+i'],
  });
  const warning = logs.find((entry) => entry.level === 'warn');
  assert.ok(warning, 'an unparseable combo must be reported, never silently dropped');
  assert.match(warning.message, /ctrl\+shit\+i/);

  detector._handleKeyDown(ctrlShiftI());
  assert.equal(violations.length, 1, 'the valid combo must still work');
});

check('parseCombo rejects anything that cannot be a shortcut', () => {
  assert.equal(parseCombo('ctrl+shift'), null, 'modifiers with no key');
  assert.equal(parseCombo('shift'), null, 'a lone modifier is not a key');
  assert.equal(parseCombo(''), null);
  assert.equal(parseCombo(42), null);
  assert.equal(parseCombo('ctrl+banana'), null, 'an unknown key name');
  assert.equal(parseCombo('hyper+i'), null, 'an unknown modifier');
});

check('parseCombo normalises order and aliases', () => {
  const combo = parseCombo('Shift+Ctrl+I', 'other');
  assert.equal(combo.raw, 'ctrl+shift+i');
  assert.equal(combo.key, 'i');
  assert.equal(parseCombo('cmd+u', 'mac').raw, 'meta+u');
  assert.equal(parseCombo('ctrl+esc', 'other').key, 'escape');
  // A lone key is valid: F12 has no modifiers. Requiring two tokens here used to
  // reject it, so the shipped f12 default could never match.
  assert.equal(parseCombo('f12', 'other').raw, 'f12');
});

check('mod resolves per platform', () => {
  const mac = parseCombo('mod+shift+i', 'mac');
  const other = parseCombo('mod+shift+i', 'other');
  assert.equal(mac.meta, true);
  assert.equal(mac.ctrl, false);
  assert.equal(other.ctrl, true);
  assert.equal(other.meta, false);
});

check('the shipped defaults cover both platforms', () => {
  assert.ok(DEVTOOLS_COMBOS.other.includes('ctrl+shift+i'));
  assert.ok(DEVTOOLS_COMBOS.mac.includes('meta+alt+i'), 'macOS devtools is Cmd+Opt+I');
  assert.ok(DEVTOOLS_COMBOS.other.includes('f12'));
  assert.ok(DEVTOOLS_COMBOS.mac.includes('f12'));
});

check('detectPlatform falls back to "other" without a navigator', () =>
  assert.equal(detectPlatform(), 'other'));

check('the detector publishes its active combos', () => {
  const { detector, states } = makeShortcutHarness();
  detector._handleKeyDown(ctrlShiftI());
  const last = states.at(-1);
  assert.equal(last.name, 'shortcuts');
  assert.equal(last.state.status, 'violation');
  assert.equal(last.state.count, 1);

  const state = detector.getState();
  assert.ok(state.combos.includes('ctrl+shift+i'), 'the active combos must be inspectable');
  assert.equal(state.lastCombo, 'ctrl+shift+i');
});

check('destroy() before init() is safe', () => {
  const { detector } = makeShortcutHarness();
  detector.destroy();
  assert.equal(detector.getState().active, false);
});

// ---------------------------------------------------------------------------
group('third-party capture software');

/**
 * Drives ThirdPartyDetector without a DOM.
 *
 * `init()` wants `navigator.mediaDevices`, so the decision rules are exercised
 * directly: the matching rules, the scan dedupe, the active-camera check and
 * the screen-share wrapper. That the real browser APIs are actually wired up is
 * proved separately in verify-browser.mjs.
 */
function makeThirdPartyHarness(overrides = {}, camera = null) {
  const violations = [];
  const logs = [];
  const states = [];
  const config = {
    detectVirtualDevices: true,
    detectActiveCamera: true,
    detectScreenShare: true,
    devices: null,
    ignore: null,
    scanIntervalMs: 0,
    checkIntervalMs: 3000,
    throttleMs: 0,
    ...overrides,
  };
  const context = {
    options: {},
    report: (type, details, meta) => violations.push({ type, details, ...meta }),
    log: (level, message, meta) => logs.push({ level, message, meta }),
    emit: () => {},
    setState: (name, state) => states.push({ name, state }),
    getDetector: (name) => (name === 'camera' ? camera : null),
  };
  return { detector: new ThirdPartyDetector(config, context), violations, logs, states };
}

/**
 * Install a fake `navigator.mediaDevices` for the duration of `fn`.
 *
 * `navigator` itself is created when the runtime does not ship one, so this
 * suite never silently skips on an older Node.
 */
function withMediaDevices(media, fn) {
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  }
  const had = Object.prototype.hasOwnProperty.call(globalThis.navigator, 'mediaDevices');
  const previous = globalThis.navigator.mediaDevices;
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: media,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (had) {
      Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        value: previous,
        configurable: true,
        writable: true,
      });
    } else {
      delete globalThis.navigator.mediaDevices;
    }
  }
}

const mediaDevice = (kind, label, deviceId = 'd1') => ({ kind, label, deviceId, groupId: 'g1' });

/** A camera detector stub whose only job is to hand back a live track. */
const cameraWithTrack = (track) => ({ getStream: () => ({ getVideoTracks: () => [track] }) });

const liveTrack = (label, settings = {}) => ({
  label,
  readyState: 'live',
  getSettings: () => settings,
});

check('the built-in list is frozen and covers the common stacks', () => {
  assert.ok(Object.isFrozen(KNOWN_THIRD_PARTY_DEVICES));
  assert.ok(KNOWN_THIRD_PARTY_DEVICES.length >= 20, 'the list should be a real inventory');
  for (const expected of ['obs virtual camera', 'manycam', 'vb-audio', 'blackhole']) {
    assert.ok(KNOWN_THIRD_PARTY_DEVICES.includes(expected), `missing entry: ${expected}`);
  }
});

check('real hardware is never flagged', () => {
  assert.equal(matchThirdPartyDevice('Integrated Camera (04f2:b6d9)'), null);
  assert.equal(matchThirdPartyDevice('HD Webcam'), null);
  assert.equal(matchThirdPartyDevice('Microphone (Realtek(R) Audio)'), null);
  assert.equal(matchThirdPartyDevice(''), null, 'an empty label must not match');
  assert.equal(matchThirdPartyDevice(null), null);
  assert.equal(matchThirdPartyDevice(undefined), null);
  assert.equal(matchThirdPartyDevice(42), null);
});

check('matching is case-insensitive and tolerates vendor decoration', () => {
  assert.equal(matchThirdPartyDevice('OBS Virtual Camera').pattern, 'obs virtual camera');
  assert.equal(matchThirdPartyDevice('OBS Virtual Camera (OBS 30.1.2)').pattern, 'obs virtual camera');
  assert.equal(matchThirdPartyDevice('  obs-camera  ').pattern, 'obs-camera');
});

check('a loopback audio cable is caught by device name', () => {
  // Ordered specific-first, so the device is attributed rather than the vendor.
  assert.equal(matchThirdPartyDevice('CABLE Output (VB-Audio Virtual Cable)').pattern, 'cable output');
  assert.equal(matchThirdPartyDevice('BlackHole 2ch').pattern, 'blackhole');
});

check('the original label is echoed back, not the pattern', () => {
  const match = matchThirdPartyDevice('ManyCam Virtual Webcam');
  assert.equal(match.label, 'ManyCam Virtual Webcam');
  assert.equal(match.pattern, 'manycam');
});

check('extra patterns extend the list and take precedence', () => {
  const options = { extra: ['acme capture'] };
  assert.equal(matchThirdPartyDevice('ACME Capture Device', options).pattern, 'acme capture');
  // Built-ins still apply when nothing in `extra` matches.
  assert.equal(matchThirdPartyDevice('ManyCam', options).pattern, 'manycam');
});

check('ignore silences a false positive without disabling the rest', () => {
  const options = { ignore: ['obs virtual camera'] };
  assert.equal(matchThirdPartyDevice('OBS Virtual Camera', options), null);
  assert.equal(matchThirdPartyDevice('ManyCam', options).pattern, 'manycam');
});

await checkAsync('a scan reports a third-party device and its kind', async () => {
  const { detector, violations } = makeThirdPartyHarness();
  await withMediaDevices(
    {
      enumerateDevices: async () => [
        mediaDevice('videoinput', 'Integrated Camera'),
        mediaDevice('videoinput', 'OBS Virtual Camera'),
      ],
    },
    () => detector.scan()
  );

  assert.equal(violations.length, 1, 'real hardware must not be reported');
  assert.equal(violations[0].type, 'third-party-device');
  assert.equal(violations[0].detector, 'thirdParty');
  assert.equal(violations[0].details.device, 'OBS Virtual Camera');
  assert.equal(violations[0].details.kind, 'camera');
  assert.equal(violations[0].details.matched, 'obs virtual camera');
});

await checkAsync('the report carries no deviceId', async () => {
  // A stable per-origin identifier adds nothing to the evidence and is one more
  // thing to leak; the label already says which device it is.
  const { detector, violations } = makeThirdPartyHarness();
  await withMediaDevices(
    { enumerateDevices: async () => [mediaDevice('videoinput', 'OBS Virtual Camera', 'secret-id')] },
    () => detector.scan()
  );
  assert.equal(violations[0].details.deviceId, undefined);
  assert.ok(!JSON.stringify(violations[0].details).includes('secret-id'));
});

await checkAsync('the same device is reported once across rescans', async () => {
  const { detector, violations } = makeThirdPartyHarness();
  const media = { enumerateDevices: async () => [mediaDevice('videoinput', 'OBS Virtual Camera')] };
  await withMediaDevices(media, () => detector.scan());
  await withMediaDevices(media, () => detector.scan());
  await withMediaDevices(media, () => detector.scan());
  assert.equal(violations.length, 1, 'a periodic rescan must not repeat the same device');
});

await checkAsync('two different devices are reported separately', async () => {
  const { detector, violations } = makeThirdPartyHarness();
  await withMediaDevices(
    {
      enumerateDevices: async () => [
        mediaDevice('videoinput', 'OBS Virtual Camera'),
        mediaDevice('audioinput', 'CABLE Output (VB-Audio Virtual Cable)'),
      ],
    },
    () => detector.scan()
  );
  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((v) => v.details.kind),
    ['camera', 'microphone']
  );
});

await checkAsync('an all-blank device list is treated as blind, not clean', async () => {
  const { detector, violations, logs } = makeThirdPartyHarness();
  await withMediaDevices(
    {
      enumerateDevices: async () => [mediaDevice('videoinput', ''), mediaDevice('audioinput', '')],
    },
    () => detector.scan()
  );

  assert.deepEqual(violations, [], 'a blind scan must not invent violations');
  const notice = logs.find((entry) => /permission/.test(entry.message));
  assert.ok(notice, 'and it must say so, or the host reads the silence as a pass');
  assert.equal(notice.level, 'debug');
});

await checkAsync('the blind-scan notice is logged once, not on every tick', async () => {
  const { detector, logs } = makeThirdPartyHarness();
  const media = { enumerateDevices: async () => [mediaDevice('videoinput', '')] };
  await withMediaDevices(media, () => detector.scan());
  await withMediaDevices(media, () => detector.scan());
  assert.equal(logs.filter((entry) => /permission/.test(entry.message)).length, 1);
});

await checkAsync('a failing enumerateDevices degrades to a warning', async () => {
  const { detector, violations, logs } = makeThirdPartyHarness();
  await withMediaDevices(
    {
      enumerateDevices: async () => {
        throw new Error('boom');
      },
    },
    () => detector.scan()
  );
  assert.deepEqual(violations, []);
  assert.ok(logs.some((entry) => entry.level === 'warn'), 'the failure must be visible');
});

await checkAsync('scan() after destroy() is a no-op', async () => {
  const { detector, violations } = makeThirdPartyHarness();
  detector.destroy();
  await withMediaDevices(
    { enumerateDevices: async () => [mediaDevice('videoinput', 'OBS Virtual Camera')] },
    () => detector.scan()
  );
  assert.deepEqual(violations, []);
});

check('a virtual camera in use is reported', () => {
  const { detector, violations } = makeThirdPartyHarness({}, cameraWithTrack(liveTrack('OBS Virtual Camera')));
  detector._checkActiveCamera();
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'virtual-camera-active');
  assert.equal(violations[0].detector, 'thirdParty');
  assert.equal(violations[0].details.matched, 'obs virtual camera');
});

check('a real camera in use is silent', () => {
  const camera = cameraWithTrack(liveTrack('Integrated Camera (04f2:b6d9)'));
  const { detector, violations } = makeThirdPartyHarness({}, camera);
  detector._checkActiveCamera();
  assert.deepEqual(violations, []);
});

check('a virtual camera is reported once, not on every tick', () => {
  const { detector, violations } = makeThirdPartyHarness({}, cameraWithTrack(liveTrack('OBS Virtual Camera')));
  for (let i = 0; i < 5; i += 1) detector._checkActiveCamera();
  assert.equal(violations.length, 1, 'it is a state, not a repeating event');
});

check('switching away and back reports again', () => {
  const track = liveTrack('OBS Virtual Camera');
  const { detector, violations } = makeThirdPartyHarness(
    {},
    { getStream: () => ({ getVideoTracks: () => [track] }) }
  );
  detector._checkActiveCamera();
  track.label = 'Integrated Camera';
  detector._checkActiveCamera();
  track.label = 'OBS Virtual Camera';
  detector._checkActiveCamera();
  assert.equal(violations.length, 2, 'a supervisor needs to see the swap back');
});

check('a screen capture wearing a camera label is caught', () => {
  // `displaySurface` is set only on tracks produced by getDisplayMedia, so its
  // presence on the "webcam" means the feed is a shared screen.
  const camera = cameraWithTrack(liveTrack('Screen 1', { displaySurface: 'monitor' }));
  const { detector, violations } = makeThirdPartyHarness({}, camera);
  detector._checkActiveCamera();

  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'screen-share-started');
  assert.equal(violations[0].details.source, 'camera-track');
  assert.equal(violations[0].details.displaySurface, 'monitor');
});

check('an ended track is ignored', () => {
  const track = liveTrack('OBS Virtual Camera');
  track.readyState = 'ended';
  const { detector, violations } = makeThirdPartyHarness({}, cameraWithTrack(track));
  detector._checkActiveCamera();
  assert.deepEqual(violations, []);
});

check('no camera detector means no crash', () => {
  const { detector, violations } = makeThirdPartyHarness();
  detector._checkActiveCamera();
  assert.deepEqual(violations, []);
});

await checkAsync('a page screen share is observed and the stream still returned', async () => {
  const { detector, violations } = makeThirdPartyHarness();
  const stream = { getVideoTracks: () => [liveTrack('Entire Screen', { displaySurface: 'monitor' })] };
  const media = { getDisplayMedia: async () => stream };

  const returned = await withMediaDevices(media, () => {
    detector._observeGetDisplayMedia();
    return media.getDisplayMedia();
  });

  assert.equal(returned, stream, 'the wrapper must hand back the real stream');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'screen-share-started');
  assert.equal(violations[0].details.source, 'getDisplayMedia');
  assert.equal(violations[0].details.displaySurface, 'monitor');
});

await checkAsync('a rejected getDisplayMedia stays rejected and is not reported', async () => {
  const { detector, violations } = makeThirdPartyHarness();
  const media = {
    getDisplayMedia: async () => {
      throw new Error('NotAllowedError');
    },
  };

  let error = null;
  await withMediaDevices(media, async () => {
    detector._observeGetDisplayMedia();
    try {
      await media.getDisplayMedia();
    } catch (err) {
      error = err;
    }
  });

  assert.ok(error && /NotAllowedError/.test(error.message), 'the rejection must pass through');
  assert.deepEqual(violations, [], 'a cancelled share is not a share');
});

await checkAsync("destroy() restores the page's own getDisplayMedia", async () => {
  const { detector } = makeThirdPartyHarness();
  const original = async () => ({ getVideoTracks: () => [] });
  const media = { getDisplayMedia: original };

  withMediaDevices(media, () => {
    detector._observeGetDisplayMedia();
    assert.notEqual(media.getDisplayMedia, original, 'the wrapper must be installed');
    detector.destroy();
    assert.equal(
      media.getDisplayMedia,
      original,
      'and removed again — a permanent patch on a standard API is a hijack'
    );
  });
});

check('a browser without getDisplayMedia degrades quietly', () => {
  const { detector, logs } = makeThirdPartyHarness();
  withMediaDevices({}, () => detector._observeGetDisplayMedia());
  assert.ok(logs.some((entry) => entry.level === 'debug'));
});

check('one violation type cannot swallow another', () => {
  // A single shared leading-edge throttle would let the device match consume
  // the window and silently drop a screen-share event microseconds later.
  const { detector, violations } = makeThirdPartyHarness(
    { throttleMs: 60_000 },
    cameraWithTrack(liveTrack('OBS Virtual Camera'))
  );
  detector._checkActiveCamera();
  detector._emit(VIOLATION_TYPES.SCREEN_SHARE_STARTED, { source: 'getDisplayMedia' });
  assert.equal(violations.length, 2, 'each type keeps its own throttle budget');
});

check('throttleMs caps repeats of the same type', () => {
  const { detector, violations } = makeThirdPartyHarness({ throttleMs: 60_000 });
  const details = { device: 'OBS Virtual Camera', kind: 'camera', matched: 'obs virtual camera' };
  detector._emit(VIOLATION_TYPES.THIRD_PARTY_DEVICE, details);
  detector._emit(VIOLATION_TYPES.THIRD_PARTY_DEVICE, details);
  assert.equal(violations.length, 1);
});

check('the detector publishes a state for the host UI', () => {
  const { detector, states } = makeThirdPartyHarness({}, cameraWithTrack(liveTrack('OBS Virtual Camera')));
  detector._checkActiveCamera();
  const last = states.at(-1);
  assert.equal(last.name, 'thirdParty');
  assert.equal(last.state.status, 'violation');
  assert.equal(last.state.count, 1);
  assert.equal(detector.getState().count, 1);
});

check('destroy() before init() is safe', () => {
  const { detector } = makeThirdPartyHarness();
  detector.destroy();
  assert.equal(detector.getState().active, false);
});

// ---------------------------------------------------------------------------
group('clipboard detector');

/**
 * Minimal `document`/`window` stand-ins.
 *
 * Enough for a detector to register and remove its listeners, which is what the
 * DOM-less tests need to prove: the event names, the capture phase, and that
 * teardown really detaches. The genuine events are proved in verify-browser.mjs.
 *
 * `invalidSelectors` lets a test declare which selectors the stand-in should
 * reject, so the "bad configuration" branch can be exercised without a CSS
 * engine.
 */
async function withFakeDom(fn, { invalidSelectors = [] } = {}) {
  const docListeners = [];
  const winListeners = [];

  const track = (list) => ({
    addEventListener(type, handler, capture) {
      list.push({ type, handler, capture });
    },
    removeEventListener(type, handler, capture) {
      const at = list.findIndex(
        (l) => l.type === type && l.handler === handler && l.capture === capture
      );
      if (at !== -1) list.splice(at, 1);
    },
  });

  const fakeDocument = {
    ...track(docListeners),
    visibilityState: 'visible',
    querySelector(selector) {
      if (invalidSelectors.includes(selector)) {
        const err = new Error(`'${selector}' is not a valid selector`);
        err.name = 'SyntaxError';
        throw err;
      }
      return null;
    },
  };

  const fakeWindow = track(winListeners);

  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;

  Object.defineProperty(globalThis, 'document', {
    value: fakeDocument,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: fakeWindow,
    configurable: true,
    writable: true,
  });

  try {
    return await fn({ docListeners, winListeners });
  } finally {
    restoreGlobal('document', hadDocument, previousDocument);
    restoreGlobal('window', hadWindow, previousWindow);
  }
}

function restoreGlobal(name, had, previous) {
  if (had) {
    Object.defineProperty(globalThis, name, { value: previous, configurable: true, writable: true });
  } else {
    delete globalThis[name];
  }
}

function makeClipboardHarness(overrides = {}) {
  const violations = [];
  const logs = [];
  const states = [];
  const config = {
    actions: ['copy', 'cut', 'paste'],
    block: false,
    throttleMs: 0,
    ignoreSelectors: null,
    ...overrides,
  };
  const context = {
    options: {},
    report: (type, details, meta) => violations.push({ type, details, ...meta }),
    log: (level, message, meta) => logs.push({ level, message, meta }),
    emit: () => {},
    setState: (name, state) => states.push({ name, state }),
  };
  return { detector: new ClipboardDetector(config, context), violations, logs, states };
}

/** A clipboard event carrying `text`, with an observable `preventDefault`. */
const clipboardEvent = (text = 'hello', target = null) => ({
  target,
  defaultPrevented: false,
  clipboardData: { getData: (type) => (type === 'text' ? text : '') },
  preventDefault() {
    this.defaultPrevented = true;
  },
});

/** Dispatch to the listener the detector registered for `type`. */
const fireClipboard = (listeners, type, event) =>
  listeners.find((l) => l.type === type).handler(event);

await checkAsync('copy, cut and paste each map to their own violation type', async () => {
  await withFakeDom(async ({ docListeners }) => {
    const { detector, violations } = makeClipboardHarness();
    await detector.init();

    fireClipboard(docListeners, 'copy', clipboardEvent('a'));
    fireClipboard(docListeners, 'cut', clipboardEvent('b'));
    fireClipboard(docListeners, 'paste', clipboardEvent('c'));

    assert.deepEqual(
      violations.map((v) => v.type),
      ['clipboard-copy', 'clipboard-cut', 'clipboard-paste']
    );
    assert.ok(violations.every((v) => v.detector === 'clipboard'));
  });
});

await checkAsync('the clipboard text is never recorded, only its length', async () => {
  await withFakeDom(async ({ docListeners }) => {
    const { detector, violations } = makeClipboardHarness();
    await detector.init();

    fireClipboard(docListeners, 'copy', clipboardEvent('SECRET ANSWER TEXT'));

    assert.equal(violations[0].details.textLength, 'SECRET ANSWER TEXT'.length);
    assert.ok(
      !JSON.stringify(violations[0]).includes('SECRET'),
      'the clipboard contents must never reach a violation'
    );
    assert.equal(violations[0].details.action, 'copy');
  });
});

await checkAsync('listeners are capture-phase and are removed by destroy()', async () => {
  await withFakeDom(async ({ docListeners }) => {
    const { detector } = makeClipboardHarness();
    await detector.init();

    assert.deepEqual(
      docListeners.map((l) => l.type),
      ['copy', 'cut', 'paste']
    );
    // Capture phase: a page calling stopPropagation() in the bubble phase must
    // not be able to hide the gesture.
    assert.ok(docListeners.every((l) => l.capture === true), 'listeners must use the capture phase');

    detector.destroy();
    assert.deepEqual(docListeners, [], 'destroy() must detach every listener');
    assert.equal(detector.getState().active, false);
  });
});

await checkAsync('block:true suppresses every event, including throttled ones', async () => {
  await withFakeDom(async ({ docListeners }) => {
    const { detector, violations } = makeClipboardHarness({ block: true, throttleMs: 60_000 });
    await detector.init();

    const first = clipboardEvent('a');
    const second = clipboardEvent('b');
    fireClipboard(docListeners, 'copy', first);
    fireClipboard(docListeners, 'copy', second);

    assert.equal(violations.length, 1, 'the second copy is inside the throttle window');
    assert.equal(first.defaultPrevented, true);
    assert.equal(
      second.defaultPrevented,
      true,
      'suppression must not be throttled, or a copy would silently go through'
    );
  });
});

await checkAsync('copy and paste have separate throttle budgets', async () => {
  await withFakeDom(async ({ docListeners }) => {
    // A single shared budget would let a copy consume the window and swallow the
    // paste that follows it — two different acts, two different events.
    const { detector, violations } = makeClipboardHarness({ throttleMs: 60_000 });
    await detector.init();

    fireClipboard(docListeners, 'copy', clipboardEvent('a'));
    fireClipboard(docListeners, 'paste', clipboardEvent('b'));
    assert.equal(violations.length, 2, 'a copy must not consume the paste budget');

    fireClipboard(docListeners, 'copy', clipboardEvent('c'));
    assert.equal(violations.length, 2, 'a repeat of the same action is throttled');
  });
});

await checkAsync('an unknown action is reported and does not take the others down', async () => {
  await withFakeDom(async ({ docListeners }) => {
    const { detector, logs } = makeClipboardHarness({ actions: ['copy', 'coppy', 'paste'] });
    await detector.init();

    assert.deepEqual(
      docListeners.map((l) => l.type),
      ['copy', 'paste']
    );
    assert.equal(logs.filter((l) => l.level === 'warn').length, 1);
  });
});

await checkAsync('ignoreSelectors skips the host app own UI', async () => {
  await withFakeDom(
    async ({ docListeners }) => {
      const { detector, violations } = makeClipboardHarness({ ignoreSelectors: ['#toolbar'] });
      await detector.init();

      const inToolbar = {
        tagName: 'BUTTON',
        id: 'copy-question',
        className: '',
        closest: (sel) => (sel === '#toolbar' ? { tagName: 'DIV' } : null),
      };
      const inAnswer = {
        tagName: 'TEXTAREA',
        id: 'answer',
        className: '',
        closest: () => null,
      };

      fireClipboard(docListeners, 'copy', clipboardEvent('q', inToolbar));
      assert.deepEqual(violations, [], "the host's own copy button must not be reported");

      fireClipboard(docListeners, 'copy', clipboardEvent('a', inAnswer));
      assert.equal(violations.length, 1, 'a real copy must still be reported');
    },
    { invalidSelectors: [] }
  );
});

await checkAsync('an invalid ignoreSelectors entry is dropped, not thrown per event', async () => {
  await withFakeDom(
    async ({ docListeners }) => {
      const { detector, logs, violations } = makeClipboardHarness({
        ignoreSelectors: ['#ok', 'nope['],
      });
      await detector.init();

      assert.equal(logs.filter((l) => l.level === 'warn').length, 1);
      // The valid entry must survive, and an event must not throw.
      fireClipboard(docListeners, 'copy', clipboardEvent('a', { tagName: 'P', closest: () => null }));
      assert.equal(violations.length, 1);
    },
    { invalidSelectors: ['nope['] }
  );
});

await checkAsync('the target of a clipboard action is described', async () => {
  await withFakeDom(async ({ docListeners }) => {
    const { detector, violations } = makeClipboardHarness();
    await detector.init();

    fireClipboard(docListeners, 'copy', clipboardEvent('a', { nodeType: 9 }));
    fireClipboard(
      docListeners,
      'paste',
      clipboardEvent('b', { tagName: 'TEXTAREA', id: 'answer', className: 'a b c d' })
    );

    assert.equal(violations[0].details.target, 'document');
    assert.equal(violations[1].details.target, 'textarea#answer.a.b.c');
  });
});

await checkAsync('an event with no clipboardData still reports', async () => {
  await withFakeDom(async ({ docListeners }) => {
    const { detector, violations } = makeClipboardHarness();
    await detector.init();

    fireClipboard(docListeners, 'paste', { target: null, preventDefault() {} });

    assert.equal(violations.length, 1, 'a missing payload must not lose the event itself');
    assert.equal(violations[0].details.textLength, null);
  });
});

await checkAsync('destroy() before init() is safe', async () => {
  const { detector } = makeClipboardHarness();
  detector.destroy();
  assert.equal(detector.getState().active, false);
});

// ---------------------------------------------------------------------------
group('tab close reporting');

function makeTabsHarness(overrides = {}) {
  const violations = [];
  const logs = [];
  const states = [];
  const config = {
    trackWindowBlur: true,
    minHiddenMs: 0,
    throttleMs: 0,
    reportOnClose: false,
    ...overrides,
  };
  const context = {
    options: {},
    report: (type, details, meta) => violations.push({ type, details, ...meta }),
    log: (level, message, meta) => logs.push({ level, message, meta }),
    emit: () => {},
    setState: (name, state) => states.push({ name, state }),
  };
  return { detector: new TabsDetector(config, context), violations, logs, states };
}

const pageHide = (listeners, event) => listeners.find((l) => l.type === 'pagehide').handler(event);

await checkAsync('pagehide is silent while reportOnClose is off', async () => {
  await withFakeDom(async ({ winListeners }) => {
    const { detector, violations } = makeTabsHarness({ reportOnClose: false });
    await detector.init();

    pageHide(winListeners, { persisted: false });
    assert.deepEqual(violations, []);
  });
});

await checkAsync('a page going away reports tab-closed as a terminal violation', async () => {
  await withFakeDom(async ({ winListeners }) => {
    const { detector, violations } = makeTabsHarness({ reportOnClose: true });
    await detector.init();

    pageHide(winListeners, { persisted: false });

    assert.equal(violations.length, 1);
    assert.equal(violations[0].type, 'tab-closed');
    assert.equal(violations[0].detector, 'tabs');
    assert.equal(violations[0].details.wasVisible, true);
    // Terminal routing is what gets it out over sendBeacon; without it the
    // violation dies in the queue with the document.
    assert.equal(violations[0].terminal, true, 'tab-closed must be routed as terminal');
  });
});

await checkAsync('entering the back/forward cache is not a close', async () => {
  await withFakeDom(async ({ winListeners }) => {
    const { detector, violations } = makeTabsHarness({ reportOnClose: true });
    await detector.init();

    pageHide(winListeners, { persisted: true });

    assert.deepEqual(violations, [], 'a bfcache entry keeps the page alive');
    assert.equal(detector.hidden, false, 'the page must not be marked hidden');
  });
});

await checkAsync('closing after switching away records that the page was not visible', async () => {
  await withFakeDom(async ({ winListeners }) => {
    const { detector, violations } = makeTabsHarness({ reportOnClose: true });
    await detector.init();

    // The candidate switched away first, then closed the tab.
    detector.hidden = true;
    pageHide(winListeners, { persisted: false });

    assert.equal(violations[0].details.wasVisible, false);
  });
});

// ---------------------------------------------------------------------------
group('periodic snapshots');

/**
 * `document` with just enough of a canvas for the real `captureFrame` to run.
 *
 * The alternative would be stubbing `captureFrame` itself, which would test the
 * stub instead of the capture path.
 */
async function withFakeCaptureDom(fn) {
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const previousDocument = globalThis.document;

  const fakeDocument = {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: () => 'data:image/jpeg;base64,QUJD',
      };
    },
  };

  Object.defineProperty(globalThis, 'document', {
    value: fakeDocument,
    configurable: true,
    writable: true,
  });

  try {
    return await fn();
  } finally {
    restoreGlobal('document', hadDocument, previousDocument);
  }
}

/** Replace `fetch` for the duration of `fn`, recording every call. */
async function withFakeFetch(fn) {
  const calls = [];
  const previous = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };

  try {
    return await fn(calls);
  } finally {
    if (previous === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous;
  }
}

/** Let the transport's `fetch` promise chain settle. */
const settle = () => new Promise((done) => setTimeout(done, 0));

await checkAsync('a snapshot is emitted, sent, and never counted as a violation', async () => {
  await withFakeCaptureDom(async () => {
    const proctor = new Proctor({ tabs: { enabled: false }, camera: { enabled: true } });
    proctor.started = true;
    proctor.store.markStarted();

    const video = { readyState: 2, videoWidth: 640, videoHeight: 480 };
    proctor.detectors.set('camera', { getVideoElement: () => video });

    const events = [];
    proctor.on(EVENTS.SNAPSHOT, (snapshot) => events.push(snapshot));

    const sent = [];
    proctor.transport.sendSnapshot = (snapshot) => sent.push(snapshot);

    const snapshot = proctor._takeSnapshot('webcam');

    assert.equal(snapshot.source, 'webcam');
    assert.equal(snapshot.width, 640);
    assert.equal(snapshot.height, 480);
    assert.ok(snapshot.dataUrl.startsWith('data:image/jpeg'));
    assert.equal(snapshot.bytes, 3);
    assert.equal(events.length, 1, 'the host must receive a snapshot event');
    assert.equal(sent.length, 1, 'the backend path must be offered the snapshot');
    assert.equal(proctor.getReport().total, 0, 'a snapshot is a sample, not a violation');
    assert.equal(proctor.getReport().score, 100);
  });
});

await checkAsync('no video element means no snapshot and no throw', async () => {
  await withFakeCaptureDom(async () => {
    const proctor = new Proctor({ tabs: { enabled: false } });
    proctor.started = true;
    proctor.store.markStarted();

    const events = [];
    proctor.on(EVENTS.SNAPSHOT, () => events.push(1));

    assert.equal(proctor._takeSnapshot('webcam'), null);
    assert.equal(proctor._takeSnapshot('page'), null);
    assert.deepEqual(events, []);
  });
});

check('snapshotIntervalMs without a camera warns instead of ticking forever', () => {
  const proctor = new Proctor({
    tabs: { enabled: false },
    camera: { enabled: false, snapshotIntervalMs: 5_000 },
  });

  const logs = [];
  proctor.on(EVENTS.LOG, (entry) => logs.push(entry));
  proctor._startSnapshots();

  assert.equal(logs.filter((l) => l.level === 'warn').length, 1);
  assert.equal(proctor._snapshotTimer, null, 'no timer may be left running with no stream');
});

check('a snapshot interval of 0 starts no timer', () => {
  const proctor = new Proctor({ tabs: { enabled: false }, camera: { enabled: true } });
  proctor._startSnapshots();
  assert.equal(proctor._snapshotTimer, null);
});

await checkAsync('a snapshot is posted to snapshotEndpoint, never as a violation', async () => {
  await withFakeFetch(async (calls) => {
    const proctor = new Proctor({
      tabs: { enabled: false },
      backend: {
        enabled: true,
        endpoint: 'https://api.example/violations',
        snapshotEndpoint: 'https://api.example/snapshots',
      },
    });

    proctor.transport.sendSnapshot({ source: 'webcam', at: 'now', bytes: 3, dataUrl: 'data:,' });
    await settle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.example/snapshots');

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.snapshots.length, 1);
    assert.equal(body.snapshots[0].source, 'webcam');
    assert.ok(!('violations' in body), 'a snapshot payload must not masquerade as violations');
  });
});

await checkAsync('without snapshotEndpoint, snapshots fall back to the endpoint', async () => {
  await withFakeFetch(async (calls) => {
    const proctor = new Proctor({
      tabs: { enabled: false },
      backend: { enabled: true, endpoint: 'https://api.example/all' },
    });

    proctor.transport.sendSnapshot({ source: 'page', at: 'now' });
    await settle();

    assert.equal(calls[0].url, 'https://api.example/all');
  });
});

await checkAsync('a snapshot never enters the violation queue and never throws', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };

  try {
    const proctor = new Proctor({
      tabs: { enabled: false },
      backend: { enabled: true, endpoint: 'https://api.example/x' },
    });

    proctor.transport.sendSnapshot({ source: 'webcam', at: 'now' });
    await settle();

    assert.deepEqual(proctor.transport.queue, [], 'a sample must not join the evidence queue');
  } finally {
    if (previous === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous;
  }
});

await checkAsync('with no backend configured, no snapshot request is made', async () => {
  await withFakeFetch(async (calls) => {
    const proctor = new Proctor({ tabs: { enabled: false } });
    proctor.transport.sendSnapshot({ source: 'webcam', at: 'now' });
    await settle();

    assert.deepEqual(calls, [], 'nothing may leave the page unless a backend was configured');
  });
});

await checkAsync('startPageCapture() refuses before the session is running', async () => {
  const proctor = new Proctor({ tabs: { enabled: false }, pageCapture: { enabled: true } });
  // Starting it here would open a share, tick on schedule, and silently produce
  // nothing — `_takeSnapshot()` returns null while the session is not running.
  await assert.rejects(
    () => proctor.startPageCapture(),
    /start the session before capturing the page/
  );
});

await checkAsync('startPageCapture() refuses when pageCapture is disabled', async () => {
  const proctor = new Proctor({ tabs: { enabled: false } });
  proctor.started = true;
  await assert.rejects(() => proctor.startPageCapture(), /pageCapture\.enabled is false/);
});

check('stopPageCapture() is safe when nothing is running', () => {
  const proctor = new Proctor({ tabs: { enabled: false } });
  proctor.stopPageCapture();
  assert.equal(proctor.isPageCapturing(), false);
});

check('stop() releases a page capture even when the session never started', () => {
  const proctor = new Proctor({ tabs: { enabled: false } });

  const released = [];
  proctor._pageCapture = {
    stream: { getTracks: () => [{ stop: () => released.push('track') }] },
    video: { srcObject: {}, remove: () => released.push('video') },
    track: null,
    onEnded: () => {},
  };

  assert.equal(proctor.started, false);
  proctor.stop();

  assert.deepEqual(
    released,
    ['track', 'video'],
    'a shared screen must not outlive stop(), whatever the session state'
  );
  assert.equal(proctor.isPageCapturing(), false);
});

// ---------------------------------------------------------------------------
group('backend payloads');

await checkAsync('an upload carries the session id', async () => {
  await withFakeFetch(async (calls) => {
    const proctor = new Proctor({
      sessionId: 'attempt-42',
      tabs: { enabled: false },
      backend: { enabled: true, endpoint: 'https://api.example/v' },
    });
    proctor.started = true;
    proctor.store.markStarted();

    proctor.reportViolation('tab-hidden', { awayMs: 10 });
    await settle();

    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.sessionId, 'attempt-42', 'the receiver must be able to tell which session this is');
    assert.equal(body.violations.length, 1);
  });
});

await checkAsync('a snapshot upload carries the same session id', async () => {
  await withFakeFetch(async (calls) => {
    const proctor = new Proctor({
      sessionId: 'attempt-42',
      tabs: { enabled: false },
      backend: {
        enabled: true,
        endpoint: 'https://api.example/v',
        snapshotEndpoint: 'https://api.example/s',
      },
    });

    proctor.transport.sendSnapshot({ source: 'webcam', at: 'now' });
    await settle();

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.sessionId, 'attempt-42');
    assert.equal(body.snapshots.length, 1);
    assert.ok(!('violations' in body));
  });
});

await checkAsync('the session id key is always present, even when null', async () => {
  await withFakeFetch(async (calls) => {
    const proctor = new Proctor({
      tabs: { enabled: false },
      backend: { enabled: true, endpoint: 'https://api.example/v' },
    });
    proctor.started = true;
    proctor.store.markStarted();

    proctor.reportViolation('tab-hidden');
    proctor.transport.sendSnapshot({ source: 'page', at: 'now' });
    await settle();

    assert.equal(calls.length, 2);
    for (const call of calls) {
      const body = JSON.parse(call.init.body);
      // A missing key cannot be told apart from an older sender that never
      // sent one; an explicit null can.
      assert.ok('sessionId' in body, `the key must always be present: ${call.init.body}`);
      assert.equal(body.sessionId, null);
    }
  });
});

await checkAsync('the session id is read at send time, not at construction', async () => {
  await withFakeFetch(async (calls) => {
    const proctor = new Proctor({
      tabs: { enabled: false },
      backend: { enabled: true, endpoint: 'https://api.example/v' },
    });

    // What `start(overrides)` effectively does to an already-built transport.
    proctor.options.sessionId = 'set-later';

    proctor.transport.sendSnapshot({ source: 'webcam', at: 'now' });
    await settle();

    assert.equal(JSON.parse(calls[0].init.body).sessionId, 'set-later');
  });
});

// ---------------------------------------------------------------------------
group('session behaviour without a DOM');

const proctor = new Proctor({ tabs: { enabled: true } });
check('constructor does not touch the DOM', () => assert.equal(proctor.started, false));
check('getReport() works before start', () => {
  const report = proctor.getReport();
  assert.equal(report.total, 0);
  assert.equal(report.score, 100);
  assert.equal(report.startedAt, null);
  assert.deepEqual(report.violations, []);
});
check('reportViolation() before start is ignored, not fatal', () =>
  assert.equal(proctor.reportViolation('tab-hidden'), null));
check('listeners can be added and removed', () => {
  let calls = 0;
  const off = proctor.on('log', () => { calls += 1; });
  assert.equal(typeof off, 'function');
  off();
});
check('a throwing listener does not break emit', () => {
  proctor.on('violation', () => { throw new Error('host app bug'); });
  // Must not throw.
  proctor.emitter.emit('violation', { type: 'test' });
});
check('once() fires at most once', () => {
  let calls = 0;
  proctor.once('log', () => { calls += 1; });
  proctor.emitter.emit('log', {});
  proctor.emitter.emit('log', {});
  assert.equal(calls, 1);
});

let startError = null;
try {
  await proctor.start();
} catch (err) {
  startError = err;
}
check('start() rejects in Node', () =>
  assert.ok(startError && /no DOM detected/.test(startError.message), `got: ${startError?.message}`));

let nameError = null;
try {
  await proctor.enableDetector('nonexistent');
} catch (err) {
  nameError = err;
}
check('enableDetector() rejects unknown names', () =>
  assert.ok(nameError && /unknown detector "nonexistent"/.test(nameError.message)));

check('destroy() is idempotent', () => {
  proctor.destroy();
  proctor.destroy();
});

// ---------------------------------------------------------------------------
console.log(`\nAll ${passed} checks passed.`);
