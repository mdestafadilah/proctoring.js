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
  version,
} = esm;

check('Proctor is a constructor', () => assert.equal(typeof Proctor, 'function'));
check('createProctor is a factory', () => assert.equal(typeof createProctor, 'function'));
check('default export is Proctor', () => assert.equal(esm.default, Proctor));
check('version matches package.json', () => assert.equal(version, pkg.version));
check('every detector is registered', () =>
  assert.deepEqual(
    [...DETECTOR_NAMES],
    ['tabs', 'rightClick', 'shortcuts', 'camera', 'face', 'audio']
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
});
check('only tabs is enabled by default', () => {
  assert.equal(DEFAULT_OPTIONS.tabs.enabled, true);
  assert.equal(DEFAULT_OPTIONS.rightClick.enabled, false);
  assert.equal(DEFAULT_OPTIONS.shortcuts.enabled, false);
  assert.equal(DEFAULT_OPTIONS.camera.enabled, false);
  assert.equal(DEFAULT_OPTIONS.face.enabled, false);
  assert.equal(DEFAULT_OPTIONS.audio.enabled, false);
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
    ['tabs', 'rightClick', 'shortcuts', 'camera', 'face', 'audio']
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
