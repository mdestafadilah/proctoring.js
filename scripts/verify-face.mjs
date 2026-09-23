/**
 * Face detector verification.
 *
 * Kept separate from verify-browser.mjs because it downloads ~2MB of model
 * weights from jsDelivr, which would slow the main check down.
 *
 * This is the highest-risk part of the library: the library bundle and the model
 * weights must come from the same face-api version, or detection silently
 * produces garbage with no error. A green run here proves the pinned CDN URLs
 * resolve, TensorFlow.js initialises in the browser, and inference executes.
 *
 * The synthetic camera has no face in it, so the expected outcome is a
 * `face-not-detected` violation — which is itself the proof that inference ran
 * and returned zero detections.
 *
 *   bun scripts/verify-face.mjs
 */
import { launchEdge } from 'file:///C:/Users/asus/.workbuddy-ai/skills/windows-edge-cdp-ui-verify/scripts/cdp.mjs';
import { strict as assert } from 'node:assert';

const BASE = 'http://localhost:5180';
const passed = [];
const ok = (label) => {
  passed.push(label);
  console.log(`  ok  ${label}`);
};

const page = await launchEdge({
  port: 9366,
  profileDir: `${process.env.TEMP}\\pjs-face-profile`,
  extraArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  startupTimeoutMs: 30000,
});

try {
  await page.goto('/demo.html', { baseUrl: BASE });
  await page.waitFor('document.getElementById("btnStart") !== null', 'demo page rendered');

  // ---------------------------------------------------------------------
  // 1. The CDN provider resolves and the pinned URLs are reachable.
  // ---------------------------------------------------------------------
  console.log('\nFace: CDN provider');

  const cdn = await page.evaluate(`(async () => {
    const { CDN_DEFAULTS, FACE_API_VERSION } = await import('/src/index.js');
    const results = {};
    for (const [key, url] of Object.entries(CDN_DEFAULTS)) {
      try {
        const res = await fetch(url, { method: 'GET' });
        results[key] = { status: res.status, ok: res.ok, bytes: (await res.arrayBuffer()).byteLength };
      } catch (err) {
        results[key] = { error: String(err) };
      }
    }
    return { version: FACE_API_VERSION, urls: CDN_DEFAULTS, results };
  })()`);

  assert.equal(cdn.results.scriptUrl.status, 200, `script URL failed: ${JSON.stringify(cdn.results.scriptUrl)}`);
  ok(`face-api ${cdn.version} bundle is reachable (${Math.round(cdn.results.scriptUrl.bytes / 1024)} KB)`);

  assert.equal(cdn.results.modelUrl.status, 200, `model URL failed: ${JSON.stringify(cdn.results.modelUrl)}`);
  ok('model directory is reachable');

  // ---------------------------------------------------------------------
  // 2. The model weights the detector actually loads are downloadable.
  //    `tinyFaceDetector` is the only net the detector requests by default.
  // ---------------------------------------------------------------------
  console.log('\nFace: model weights');

  const weights = await page.evaluate(`(async () => {
    const { CDN_DEFAULTS } = await import('/src/index.js');
    const base = CDN_DEFAULTS.modelUrl;
    const files = [
      'tiny_face_detector_model-weights_manifest.json',
      'tiny_face_detector_model.bin',
    ];
    const out = {};
    for (const file of files) {
      const res = await fetch(base + file);
      out[file] = { status: res.status, bytes: (await res.arrayBuffer()).byteLength };
    }
    return out;
  })()`);

  assert.equal(weights['tiny_face_detector_model-weights_manifest.json'].status, 200);
  assert.ok(weights['tiny_face_detector_model.bin'].bytes > 1000, 'weights .bin looks empty');
  ok(`weights resolve (manifest + ${Math.round(weights['tiny_face_detector_model.bin'].bytes / 1024)} KB binary)`);

  // ---------------------------------------------------------------------
  // 3. End-to-end: detector initialises, loads models, runs inference.
  // ---------------------------------------------------------------------
  console.log('\nFace: detector pipeline');

  const face = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');

    const video = document.createElement('video');
    video.id = 'face-preview';
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);

    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      tabs: { enabled: false },
      // Camera provides the stream; face reuses it.
      camera: { enabled: true, videoElement: '#face-preview' },
      face: {
        enabled: true,
        intervalMs: 300,
        awayGraceMs: 600,
        minConfidence: 0.3,
        throttleMs: 0,
      },
    });

    const events = [];
    proctor.on('detector:ready', ({ detector }) => events.push({ ready: detector }));
    proctor.on('detector:error', ({ detector, error }) =>
      events.push({ failed: detector, message: error.message })
    );
    proctor.on('violation', (v) => events.push({ type: v.type, details: v.details }));

    const startedAt = Date.now();
    await proctor.start();
    const initMs = Date.now() - startedAt;

    // Let inference run a few cycles.
    await new Promise((r) => setTimeout(r, 2500));

    const state = proctor.getDetectorState('face');
    const report = proctor.getReport();
    proctor.destroy();
    video.remove();

    return { events, initMs, state, total: report.total, types: Object.keys(report.countsByType) };
  })()`);

  const faceFailed = face.events.find((e) => e.failed === 'face');
  assert.ok(
    !faceFailed,
    `face detector failed to initialise: ${faceFailed?.message ?? 'unknown'}`
  );
  assert.ok(
    face.events.some((e) => e.ready === 'face'),
    `face detector never became ready: ${JSON.stringify(face.events)}`
  );
  ok(`face detector initialises and loads models (${face.initMs} ms)`);

  assert.ok(face.state, 'face detector must publish a state');
  assert.equal(face.state.status, 'running');
  assert.equal(
    typeof face.state.faceCount,
    'number',
    `inference did not run — no faceCount published: ${JSON.stringify(face.state)}`
  );
  ok(`inference executes and reports a face count (${face.state.faceCount} faces in a synthetic scene)`);

  // The synthetic device shows an abstract pattern, so zero faces is expected.
  // The point is that a violation was produced *by inference*, not by a timeout.
  assert.ok(
    face.types.includes('face-not-detected'),
    `expected a face-not-detected violation, got: ${JSON.stringify(face.types)}`
  );
  const notDetected = face.events.find((e) => e.type === 'face-not-detected');
  assert.equal(notDetected.details.faceCount, 0, 'the violation must record the observed count');
  ok('no-face condition produces a "face-not-detected" violation with the observed count');

  assert.deepEqual(page.errors, [], `console errors: ${JSON.stringify(page.errors)}`);
  ok('console is clean');

  console.log(`\nAll ${passed.length} face checks passed.`);
} finally {
  await page.close();
}
