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
  version,
} = esm;

check('Proctor is a constructor', () => assert.equal(typeof Proctor, 'function'));
check('createProctor is a factory', () => assert.equal(typeof createProctor, 'function'));
check('default export is Proctor', () => assert.equal(esm.default, Proctor));
check('version matches package.json', () => assert.equal(version, '0.1.0'));
check('all four detectors are registered', () =>
  assert.deepEqual([...DETECTOR_NAMES], ['tabs', 'camera', 'face', 'audio']));
check('event names are stable', () => {
  assert.equal(EVENTS.VIOLATION, 'violation');
  assert.equal(EVENTS.READY, 'ready');
  assert.equal(EVENTS.DETECTOR_ERROR, 'detector:error');
});
check('violation type ids are the wire format', () => {
  assert.equal(VIOLATION_TYPES.TAB_HIDDEN, 'tab-hidden');
  assert.equal(VIOLATION_TYPES.FACE_MULTIPLE, 'face-multiple');
});
check('only tabs is enabled by default', () => {
  assert.equal(DEFAULT_OPTIONS.tabs.enabled, true);
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
  assert.deepEqual([...cjs.DETECTOR_NAMES], ['tabs', 'camera', 'face', 'audio']);
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
    log: () => {},
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

  return { detector, violations };
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

check('_sample is a no-op before the analyser exists', () => {
  const context = { options: {}, report: () => {}, log: () => {}, emit: () => {}, setState: () => {} };
  const detector = new AudioDetector({ rmsThreshold: 0.08, fftSize: 1024 }, context);
  // Must not throw when called before init().
  detector._sample();
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
