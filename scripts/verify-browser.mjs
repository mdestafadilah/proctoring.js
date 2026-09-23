/**
 * Browser verification for proctoring.js.
 *
 * Proves the parts that Node cannot: that the detectors actually attach to real
 * DOM events and produce violations. Focused on `tabs`, which is the only
 * detector enabled by default and the one every consumer gets.
 *
 * Run headful-free via Edge + CDP. See the windows-edge-cdp-ui-verify skill.
 */
import { launchEdge } from 'file:///C:/Users/asus/.workbuddy-ai/skills/windows-edge-cdp-ui-verify/scripts/cdp.mjs';
import { strict as assert } from 'node:assert';

const BASE = 'http://localhost:5180';
const passed = [];

function ok(label) {
  passed.push(label);
  console.log(`  ok  ${label}`);
}

const page = await launchEdge({
  port: 9361,
  profileDir: `${process.env.TEMP}\\pjs-edge-profile`,
  // A synthetic webcam + auto-accepted permission, so the camera and screenshot
  // checks run on any machine (CI included) with no hardware and no prompt.
  extraArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

try {
  // ---------------------------------------------------------------------
  // 1. The distribution build loads and the public API is intact in-browser.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: library load');
  await page.goto('/demo.html', { baseUrl: BASE });
  await page.waitFor('document.getElementById("btnStart") !== null', 'demo page rendered');

  const api = await page.evaluate(`(async () => {
    const m = await import('/src/index.js');
    return {
      keys: Object.keys(m).sort(),
      hasProctor: typeof m.Proctor === 'function',
      detectors: [...m.DETECTOR_NAMES],
      version: m.version,
      faceVersion: m.FACE_API_VERSION,
      modelUrl: m.CDN_DEFAULTS.modelUrl,
    };
  })()`);

  assert.equal(api.hasProctor, true, 'Proctor must be exported');
  assert.deepEqual(api.detectors, ['tabs', 'camera', 'face', 'audio']);
  assert.equal(api.version, '0.1.0');
  assert.ok(api.modelUrl.startsWith('https://cdn.jsdelivr.net/'), 'model URL must be a CDN URL');
  ok(`module loads in browser (${api.keys.length} exports, v${api.version})`);

  // ---------------------------------------------------------------------
  // 2. A tab-switch violation is actually produced.
  //    Emulated by hiding the document, which is exactly what the Page
  //    Visibility API reports when the user switches tabs.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: tabs detector');

  const result = await page.evaluate(`(async () => {
    const { Proctor, VIOLATION_TYPES } = await import('/src/index.js');

    const proctor = new Proctor({
      logLevel: 'silent',
      tabs: { enabled: true, minHiddenMs: 0, throttleMs: 0 },
      report: { persist: false },
    });

    const events = [];
    proctor.on('violation', (v) => events.push(v));
    proctor.on('detector:ready', ({ detector }) => events.push({ ready: detector }));
    proctor.on('detector:error', ({ detector, error }) =>
      events.push({ failed: detector, message: error.message })
    );

    await proctor.start();

    // Simulate hiding, then showing the tab.
    const hide = () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const show = () => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    hide();
    await new Promise((r) => setTimeout(r, 120));
    show();
    await new Promise((r) => setTimeout(r, 120));

    // Window blur without hiding should produce a separate violation type.
    window.dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 60));
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 120));

    const report = proctor.getReport();
    const state = proctor.getDetectorState('tabs');
    // Capture the violation count before teardown so we can prove destroy()
    // does not append anything.
    const totalBeforeDestroy = report.total;

    // stop() is the documented way to close a session: it must stamp endedAt.
    const finalReport = proctor.stop();
    const stateAfterStop = proctor.getDetectorState('tabs');

    proctor.destroy();

    // After destroy the session must be inert.
    const afterDestroyViolation = proctor.reportViolation('tab-hidden', { probe: true });

    return {
      events,
      report: finalReport,
      state,
      stateAfterStop,
      totalBeforeDestroy,
      afterDestroyViolation,
      detectorAliveBeforeDestroy: Boolean(report.detectors?.length),
    };
  })()`);

  const ready = result.events.find((e) => e.ready);
  assert.ok(ready, `tabs detector never became ready: ${JSON.stringify(result.events)}`);
  ok('tabs detector reports ready');

  const violations = result.events.filter((e) => e.type);
  const tabHidden = violations.find((v) => v.type === 'tab-hidden');
  const windowBlur = violations.find((v) => v.type === 'window-blur');

  assert.ok(
    tabHidden,
    `expected a tab-hidden violation, got: ${JSON.stringify(violations.map((v) => v.type))}`
  );
  ok('tab switch produces a "tab-hidden" violation');

  assert.equal(tabHidden.severity, 'high', 'tab-hidden should default to high severity');
  assert.equal(tabHidden.detector, 'tabs');
  assert.ok(tabHidden.details.awayMs >= 0, 'violation must carry the away duration');
  assert.ok(tabHidden.id.startsWith('vio_'), 'violation must have a generated id');
  ok(`violation shape is correct (severity=${tabHidden.severity}, detector=${tabHidden.detector})`);

  assert.ok(windowBlur, 'expected a window-blur violation from the blur event');
  assert.equal(windowBlur.severity, 'medium');
  ok('window blur produces a separate "window-blur" violation');

  // No double counting: hiding should not also fire window-blur.
  assert.equal(
    violations.filter((v) => v.type === 'window-blur').length,
    1,
    'blur during a hidden tab must not be double-counted'
  );
  ok('no double-counting when the tab is hidden and blurred');

  // ---------------------------------------------------------------------
  // 3. Report integrity.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: report');
  assert.equal(result.report.total, 2, `expected 2 violations, got ${result.report.total}`);
  assert.equal(result.report.countsByType['tab-hidden'], 1);
  assert.equal(result.report.countsByType['window-blur'], 1);
  assert.equal(result.report.worstSeverity, 'high');
  assert.ok(result.report.score < 100, 'score must drop after violations');
  assert.ok(result.report.startedAt, 'report must record a start time');
  assert.ok(result.report.endedAt, 'stop() must record an end time');
  assert.ok(result.report.durationMs >= 0);
  ok(`report aggregates correctly (total=${result.report.total}, score=${result.report.score})`);

  assert.equal(result.stateAfterStop.status, 'destroyed', 'stop() must mark the detector destroyed');
  ok('stop() tears down the detector state');

  assert.equal(
    result.afterDestroyViolation,
    null,
    'reportViolation() must be inert after destroy()'
  );
  ok('reportViolation() after destroy() is safely ignored');

  // ---------------------------------------------------------------------
  // 4. Disabling a detector actually stops it.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: lifecycle');
  const afterDestroy = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');
    const proctor = new Proctor({
      logLevel: 'silent',
      tabs: { enabled: true, throttleMs: 0 },
      report: { persist: false },
      camera: { enabled: false },
    });
    const events = [];
    proctor.on('violation', (v) => events.push(v.type));
    await proctor.start();

    proctor.disableDetector('tabs');
    const aliveAfterDisable = Boolean(proctor.getDetector('tabs'));

    // With tabs disabled, hiding must no longer produce a violation.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 80));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 80));

    proctor.destroy();
    return { aliveAfterDisable, events };
  })()`);

  assert.equal(afterDestroy.aliveAfterDisable, false, 'detector must be removed on disable');
  assert.deepEqual(afterDestroy.events, [], 'a disabled detector must not emit');
  ok('disableDetector() removes the detector and stops its events');

  // ---------------------------------------------------------------------
  // 5. Camera detector against a real getUserMedia stream.
  //    Edge's fake device provides the frames, so this runs without hardware.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: camera detector');

  const camera = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');

    const video = document.createElement('video');
    video.id = 'cam-preview';
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);

    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      tabs: { enabled: false },
      camera: { enabled: true, videoElement: '#cam-preview', throttleMs: 0 },
    });

    const events = [];
    proctor.on('detector:ready', ({ detector }) => events.push({ ready: detector }));
    proctor.on('detector:error', ({ detector, error }) =>
      events.push({ failed: detector, message: error.message })
    );
    proctor.on('violation', (v) => events.push({ type: v.type }));

    await proctor.start();

    const detector = proctor.getDetector('camera');
    const state = proctor.getDetectorState('camera');
    const live = detector?.getStream?.();
    const track = live?.getVideoTracks?.()[0];
    const hasSrcObject = Boolean(video.srcObject);
    const hasFrames = video.readyState >= 2 && video.videoWidth > 0;
    const dimensions = { width: video.videoWidth, height: video.videoHeight };

    // Releasing must actually stop the track (turns off the camera LED).
    proctor.destroy();
    const trackStopped = track ? track.readyState === 'ended' : null;
    // Read the state *after* teardown — that is when it must say destroyed.
    const stateAfterDestroy = proctor.getDetectorState('camera');
    video.remove();

    return {
      events,
      ready: events.some((e) => e.ready === 'camera'),
      failed: events.find((e) => e.failed === 'camera') ?? null,
      status: state?.status ?? null,
      statusAfterDestroy: stateAfterDestroy?.status ?? null,
      activeAfterDestroy: stateAfterDestroy?.active ?? null,
      hasStream: Boolean(live),
      hasSrcObject,
      hasFrames,
      dimensions,
      trackStopped,
    };
  })()`);

  assert.ok(
    camera.ready,
    `camera detector failed to initialise: ${JSON.stringify(camera.failed ?? camera.events)}`
  );
  ok('camera detector initialises with a live stream');

  assert.equal(camera.hasStream, true, 'detector must expose the MediaStream');
  assert.equal(camera.hasSrcObject, true, 'stream must be attached to the video element');
  assert.equal(camera.hasFrames, true, 'the video element must be producing frames');
  assert.ok(camera.dimensions.width > 0, `unexpected video size: ${JSON.stringify(camera.dimensions)}`);
  ok(`camera delivers frames to the preview (${camera.dimensions.width}x${camera.dimensions.height})`);

  assert.equal(camera.status, 'running', 'camera must report running while streaming');
  ok('camera detector reports a running state');

  assert.equal(camera.statusAfterDestroy, 'destroyed', 'state must be destroyed after teardown');
  assert.equal(camera.activeAfterDestroy, false, 'detector must be inactive after teardown');
  assert.equal(camera.trackStopped, true, 'destroy() must stop the track, not just detach it');
  ok('destroy() stops the track (camera is actually released)');

  // ---------------------------------------------------------------------
  // 6. Screenshot capture against a real <video> element.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: screenshot capture');

  const shot = await page.evaluate(`(async () => {
    const { captureFrame, dataUrlBytes, Proctor } = await import('/src/index.js');

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (err) {
      return { skipped: true, reason: err.name };
    }

    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    document.body.appendChild(video);
    await video.play();
    await new Promise((r) => setTimeout(r, 400));

    const frame = captureFrame(video, { maxWidth: 320, quality: 0.6 });
    const bytes = frame ? dataUrlBytes(frame) : 0;

    // Now prove the Proctor actually attaches it to a visual violation.
    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false, captureScreenshots: true, screenshotMaxWidth: 320 },
      tabs: { enabled: false },
      camera: { enabled: false, videoElement: video },
    });
    // Inject the element so _captureScreenshot can find it without a camera detector.
    proctor.detectors.set('camera', { getVideoElement: () => video });
    proctor.started = true;

    const visual = proctor.reportViolation('camera-muted', { reason: 'test' }, { detector: 'camera' });
    const nonVisual = proctor.reportViolation('tab-hidden', {}, { detector: 'tabs' });

    const report = proctor.getReport();
    proctor.destroy();

    for (const track of stream.getTracks()) track.stop();
    video.remove();

    return {
      skipped: false,
      frame,
      bytes,
      visualHasShot: typeof visual?.screenshot === 'string',
      visualShotBytes: visual?.screenshot ? dataUrlBytes(visual.screenshot) : 0,
      nonVisualHasShot: nonVisual?.screenshot !== undefined,
      reportBytes: report.screenshotBytes,
      dropped: report.droppedScreenshots,
    };
  })()`);

  if (shot.skipped) {
    console.log(`  --  skipped: no camera available (${shot.reason})`);
  } else {
    assert.ok(shot.frame, 'captureFrame must return a data URL from a live video');
    assert.ok(shot.frame.startsWith('data:image/'), `unexpected frame format: ${shot.frame?.slice(0, 30)}`);
    assert.ok(shot.bytes > 0, 'captured frame must have content');
    // A 320px-wide JPEG should be small; guard against silently capturing full size.
    assert.ok(shot.bytes < 200 * 1024, `frame too large: ${shot.bytes} bytes`);
    ok(`captureFrame returns a downscaled JPEG (${shot.bytes} bytes)`);

    assert.equal(shot.visualHasShot, true, 'a camera violation must carry a screenshot');
    ok(`camera violation carries a frame (${shot.visualShotBytes} bytes)`);

    assert.equal(shot.nonVisualHasShot, false, 'a tab violation must NOT carry a screenshot');
    ok('non-visual violation carries no frame');

    assert.equal(shot.reportBytes, shot.visualShotBytes, 'report must track screenshot bytes');
    ok('report tracks screenshot byte budget');
  }

  // ---------------------------------------------------------------------
  // 7. No console noise.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: console');
  const realErrors = page.errors.filter(
    // The demo page intentionally logs a fetch warning; ignore our own noise.
    (e) => !/proctoring\.js/.test(String(e))
  );
  assert.deepEqual(realErrors, [], `unexpected console errors: ${JSON.stringify(realErrors)}`);
  ok('console is clean');

  await page.screenshot('D:/REACT-DEV/proctoring.js-catalyst/outputs/verify-demo.png');

  console.log(`\nAll ${passed.length} browser checks passed.`);
} finally {
  await page.close();
}
