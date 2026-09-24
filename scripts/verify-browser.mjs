/**
 * Browser verification for proctoring.js.
 *
 * Proves the parts that Node cannot: that the detectors actually attach to real
 * DOM events and produce violations. Focused on `tabs`, which is the only
 * detector enabled by default and the one every consumer gets.
 *
 * Run headful-free via Edge + CDP. The driver is vendored at ./lib/cdp.mjs.
 */
import { launchEdge, tmpProfile, resolveBrowserPath, DEFAULT_EDGE_PATHS } from './lib/cdp.mjs';
import { version } from './lib/pkg.mjs';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:5180';
const passed = [];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Derived from this file rather than hardcoded, so the script works from any
// checkout. `outputs/` is gitignored, so a fresh clone has no such directory and
// the run would otherwise die on its very last step.
const OUT_DIR = resolve(REPO_ROOT, 'outputs');
mkdirSync(OUT_DIR, { recursive: true });

function ok(label) {
  passed.push(label);
  console.log(`  ok  ${label}`);
}

const page = await launchEdge({
  port: 9361,
  profileDir: tmpProfile('pjs-edge-profile'),
  // A synthetic webcam + microphone and auto-accepted permission, so the
  // camera, audio and screenshot checks run on any machine (CI included) with
  // no hardware and no prompt. The autoplay flag lets AudioContext start
  // without a user gesture, which headless runs never produce.
  extraArgs: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
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
  assert.deepEqual(api.detectors, ['tabs', 'rightClick', 'shortcuts', 'clipboard', 'camera', 'face', 'audio', 'thirdParty']);
  assert.equal(api.version, version);
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
  // 7. Audio detector against a real microphone stream.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: audio detector');

  const audio = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');

    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      tabs: { enabled: false },
      // A very low threshold so a false positive on silence would be caught.
      audio: { enabled: true, rmsThreshold: 0.001, loudGraceMs: 200, throttleMs: 0 },
    });

    const events = [];
    proctor.on('detector:ready', ({ detector }) => events.push({ ready: detector }));
    proctor.on('detector:error', ({ detector, error }) =>
      events.push({ failed: detector, message: error.message })
    );
    proctor.on('violation', (v) => events.push({ type: v.type, details: v.details }));

    await proctor.start();
    await new Promise((r) => setTimeout(r, 1200));

    const state = proctor.getDetectorState('audio');
    const detector = proctor.getDetector('audio');
    // Hold the context reference: destroy() nulls the detector's own field, so
    // the state must be read through this handle afterwards.
    const ctx = detector?.audioContext ?? null;
    const ctxBefore = ctx?.state ?? null;
    const report = proctor.getReport();

    proctor.destroy();
    const ctxClosed = ctx ? ctx.state === 'closed' : null;

    return {
      events,
      ready: events.some((e) => e.ready === 'audio'),
      failed: events.find((e) => e.failed === 'audio') ?? null,
      state,
      ctxBefore,
      ctxClosed,
      types: Object.keys(report.countsByType),
    };
  })()`);

  const audioFailed = audio.events.find((e) => e.failed === 'audio');
  assert.ok(!audioFailed, `audio detector failed to initialise: ${audioFailed?.message ?? 'unknown'}`);
  assert.ok(
    audio.events.some((e) => e.ready === 'audio'),
    `audio detector never became ready: ${JSON.stringify(audio.events)}`
  );
  ok('audio detector initialises with a live microphone stream');

  assert.ok(audio.state, 'audio detector must publish a state');
  assert.equal(audio.state.status, 'running', `unexpected status: ${audio.state.status}`);
  assert.equal(
    typeof audio.state.rms,
    'number',
    `the sampler never ran — no rms published: ${JSON.stringify(audio.state)}`
  );
  ok(`loudness sampling runs (rms=${audio.state.rms.toFixed(4)}, ctx=${audio.ctxBefore})`);

  // Edge's synthetic microphone emits silence. That makes this a false-positive
  // test: a silent room must never be reported as noise, even with the
  // threshold set absurdly low. The loud path is covered deterministically by
  // the stubbed-analyser tests in verify.mjs.
  assert.deepEqual(
    audio.types,
    [],
    `a silent room must not produce violations, got: ${JSON.stringify(audio.types)}`
  );
  ok('a silent room produces no false "audio-too-loud" violation');

  assert.equal(audio.ctxClosed, true, 'destroy() must close the AudioContext');
  ok('destroy() closes the AudioContext (microphone is released)');

  // ---------------------------------------------------------------------
  // 8. Right-click detector against genuine input.
  //    A synthetic `dispatchEvent` would only prove a listener exists. A real
  //    right-click pushed through the browser's input pipeline proves the
  //    wiring, the capture phase, and the menu suppression.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: right-click detector');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Aim at a dead rectangle: clicking the demo's own controls would start a
  // camera and could navigate the page out from under the test.
  await page.evaluate(`(() => {
    const probe = document.createElement('div');
    probe.id = 'pjs-probe';
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:160px;height:80px;z-index:2147483647;background:#eee';
    document.body.appendChild(probe);
    return true;
  })()`);

  const PROBE = { x: 80, y: 40 };
  const mouse = (type, button, buttons) =>
    page.send('Input.dispatchMouseEvent', {
      type,
      x: PROBE.x,
      y: PROBE.y,
      button,
      buttons,
      clickCount: 1,
    });

  const click = async (button) => {
    await mouse('mousePressed', button, button === 'right' ? 2 : 1);
    await mouse('mouseReleased', button, 0);
    await sleep(200);
  };

  const setup = (overrides) =>
    page.evaluate(`(async () => {
      const { Proctor } = await import('/src/index.js');
      const proctor = new Proctor({
        logLevel: 'silent',
        report: { persist: false },
        tabs: { enabled: false },
        rightClick: ${JSON.stringify(overrides)},
      });
      window.__pjsEvents = [];
      window.__pjsPrevented = null;
      proctor.on('violation', (v) => window.__pjsEvents.push(v));
      // Registered after the detector and in the bubble phase, so it can only
      // report the decision the detector already made during the capture phase.
      document.addEventListener('contextmenu', (e) => {
        window.__pjsPrevented = e.defaultPrevented;
      });
      await proctor.start();
      window.__pjs = proctor;
      return { pointerListener: Boolean(proctor.getDetector('rightClick')?._onPointerDown) };
    })()`);

  const teardown = () =>
    page.evaluate(`(() => {
      const out = {
        events: window.__pjsEvents ?? [],
        prevented: window.__pjsPrevented,
        state: window.__pjs?.getDetectorState('rightClick') ?? null,
      };
      window.__pjs?.destroy();
      return out;
    })()`);

  // (a) A synthetic event, purely to pin the default posture: report, and do
  //     not touch the page.
  const synthetic = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');
    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      tabs: { enabled: false },
      rightClick: { enabled: true, block: false, detectPointerDown: false, throttleMs: 0 },
    });
    const events = [];
    proctor.on('violation', (v) => events.push(v));
    await proctor.start();

    const probe = document.getElementById('pjs-probe');
    // dispatchEvent returns false when a listener called preventDefault().
    const notPrevented = probe.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    );
    await new Promise((r) => setTimeout(r, 60));

    const report = proctor.getReport();
    proctor.destroy();
    return { events, notPrevented, report };
  })()`);

  assert.equal(synthetic.events.length, 1, 'a contextmenu event must be reported');
  const rightClickViolation = synthetic.events[0];
  assert.equal(rightClickViolation.type, 'right-click');
  assert.equal(rightClickViolation.severity, 'medium', 'right-click should default to medium severity');
  assert.equal(rightClickViolation.detector, 'rightClick');
  assert.equal(rightClickViolation.details.target, 'div#pjs-probe', 'the target element must be recorded');
  assert.equal(rightClickViolation.details.blocked, false);
  ok('a contextmenu event produces a "right-click" violation naming its target');

  assert.equal(synthetic.notPrevented, true, 'block:false must leave the page alone');
  ok('block:false does not suppress the menu');

  assert.equal(synthetic.report.countsByType['right-click'], 1);
  assert.equal(synthetic.report.worstSeverity, 'medium');
  assert.ok(synthetic.report.score < 100, 'the score must react to a right-click');
  ok(`the report aggregates right-clicks (score=${synthetic.report.score})`);

  // (b) Genuine input, shipped defaults: a real left click must be silent, a
  //     real right click must fire once and must suppress the native menu.
  const attached = await setup({ enabled: true, block: true });
  assert.equal(attached.pointerListener, true, 'pointerdown must be watched by default');
  ok('the detector attaches its pointerdown listener by default');

  await click('left');
  assert.equal(
    await page.evaluate('window.__pjsEvents.length'),
    0,
    'a real left click must never be reported'
  );
  ok('a real left click produces no violation');

  await click('right');
  const real = await teardown();

  assert.equal(
    real.events.length,
    1,
    `one right-click must be one violation, got ${JSON.stringify(real.events.map((e) => e.details?.source))}`
  );
  assert.equal(real.events[0].type, 'right-click');
  assert.equal(real.events[0].details.target, 'div#pjs-probe');
  ok(`a real right-click is detected once (source=${real.events[0].details.source})`);

  assert.equal(
    real.prevented,
    true,
    'block:true must preventDefault the real context menu, in the capture phase'
  );
  ok('block:true suppresses the real context menu');

  assert.equal(real.state?.count, 1, 'the detector must publish how many right-clicks it saw');
  ok('the detector publishes its own state');

  // (c) With pointerdown disabled the genuine `contextmenu` event alone must
  //     still be caught — this is what proves the capture-phase listener works
  //     on a real gesture rather than only on a synthetic one.
  const ctxOnly = await setup({ enabled: true, block: true, detectPointerDown: false });
  assert.equal(ctxOnly.pointerListener, false, 'pointerdown must be off when disabled');

  await click('right');
  const contextMenuOnly = await teardown();

  assert.equal(
    contextMenuOnly.events.length,
    1,
    `a real right-click must reach the contextmenu listener: ${JSON.stringify(contextMenuOnly.events)}`
  );
  assert.equal(
    contextMenuOnly.events[0].details.source,
    'contextmenu',
    'the browser must have generated a genuine contextmenu event'
  );
  ok('the contextmenu listener alone catches a real right-click');

  // (d) Regression guard: with the rate limit switched off, dedupe must still
  //     collapse the gesture. Relying on `throttleMs` for this produced two
  //     violations per real right-click.
  await setup({ enabled: true, block: true, throttleMs: 0 });
  await click('right');
  const unthrottled = await teardown();

  assert.equal(
    unthrottled.events.length,
    1,
    `throttleMs:0 must not double-count a gesture, got ${JSON.stringify(unthrottled.events.map((e) => e.details?.source))}`
  );
  ok('throttleMs:0 does not double-count a single gesture');

  await page.evaluate('document.getElementById("pjs-probe")?.remove()');

  // ---------------------------------------------------------------------
  // 9. Keyboard shortcut detector against genuine key events.
  //    These are pushed through the browser's input pipeline with
  //    Input.dispatchKeyEvent, which is the only way to prove the shortcut
  //    path works: a page-scripted KeyboardEvent cannot trigger a browser
  //    shortcut, so it cannot prove the detector sees what a user produces.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: keyboard shortcuts');

  // CDP modifier bitmask.
  const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

  const setupShortcuts = (overrides) =>
    page.evaluate(`(async () => {
      const { Proctor } = await import('/src/index.js');
      const proctor = new Proctor({
        logLevel: 'silent',
        report: { persist: false },
        tabs: { enabled: false },
        shortcuts: ${JSON.stringify(overrides)},
      });
      window.__pjsKeyEvents = [];
      window.__pjsKeyPrevented = null;
      proctor.on('violation', (v) => window.__pjsKeyEvents.push(v));
      // Bubble phase, registered after the detector, so it can only observe the
      // decision the capture-phase listener already made.
      document.addEventListener('keydown', (e) => {
        window.__pjsKeyPrevented = e.defaultPrevented;
      });
      await proctor.start();
      window.__pjs = proctor;
      return { combos: proctor.getDetector('shortcuts')?.getState().combos ?? [] };
    })()`);

  const teardownShortcuts = () =>
    page.evaluate(`(() => {
      const out = {
        events: window.__pjsKeyEvents ?? [],
        prevented: window.__pjsKeyPrevented,
        state: window.__pjs?.getDetectorState('shortcuts') ?? null,
      };
      window.__pjs?.destroy();
      return out;
    })()`);

  /** A genuine shortcut: rawKeyDown, no text, or the browser treats it as typing. */
  const pressShortcut = async ({ key, code, modifiers, vk }) => {
    await page.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
    await sleep(150);
  };

  /** A genuine typed character, which does carry text. */
  const pressCharacter = async ({ key, code, vk }) => {
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      text: key,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
    await sleep(150);
  };

  // (a) Synthetic first, to pin the default posture without opening DevTools.
  const syntheticKey = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');
    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      tabs: { enabled: false },
      shortcuts: { enabled: true, block: false },
    });
    const events = [];
    proctor.on('violation', (v) => events.push(v));
    await proctor.start();

    // Shift uppercases key, which is the case a naive comparison misses.
    const notPrevented = document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true,
        bubbles: true, cancelable: true,
      })
    );
    await new Promise((r) => setTimeout(r, 60));

    const report = proctor.getReport();
    proctor.destroy();
    return { events, notPrevented, report };
  })()`);

  assert.equal(syntheticKey.events.length, 1, 'a Ctrl+Shift+I keydown must be reported');
  const shortcut = syntheticKey.events[0];
  assert.equal(shortcut.type, 'shortcut-used');
  assert.equal(shortcut.severity, 'high', 'a devtools shortcut should default to high severity');
  assert.equal(shortcut.detector, 'shortcuts');
  assert.equal(shortcut.details.combo, 'ctrl+shift+i');
  assert.equal(shortcut.details.label, 'devtools');
  assert.equal(shortcut.details.blocked, false);
  ok('Ctrl+Shift+I produces a "shortcut-used" violation labelled "devtools"');

  assert.equal(syntheticKey.notPrevented, true, 'block:false must leave the shortcut alone');
  ok('block:false does not swallow the keystroke');

  assert.equal(syntheticKey.report.countsByType['shortcut-used'], 1);
  assert.equal(syntheticKey.report.worstSeverity, 'high');
  ok(`the report aggregates shortcuts (score=${syntheticKey.report.score})`);

  // (b) Genuine keys. `block: true` is deliberate: it is what stops Edge from
  //     actually opening DevTools mid-run, and it doubles as the proof that the
  //     capture-phase listener runs before the browser acts.
  const shortcutAttached = await setupShortcuts({ enabled: true, block: true });
  assert.ok(
    shortcutAttached.combos.includes('ctrl+shift+i'),
    `the platform default must include the devtools combo: ${JSON.stringify(shortcutAttached.combos)}`
  );
  ok(`the detector resolved ${shortcutAttached.combos.length} default combos for this platform`);

  await pressCharacter({ key: 'i', code: 'KeyI', vk: 73 });
  assert.equal(
    await page.evaluate('window.__pjsKeyEvents.length'),
    0,
    'a plain "i" must never be reported'
  );
  ok('a genuine plain "i" produces no violation');

  await pressShortcut({ key: 'I', code: 'KeyI', modifiers: MOD.ctrl | MOD.shift, vk: 73 });
  const realShortcut = await teardownShortcuts();

  assert.equal(
    realShortcut.events.length,
    1,
    `one Ctrl+Shift+I must be one violation, got ${JSON.stringify(realShortcut.events.map((e) => e.details?.combo))}`
  );
  assert.equal(realShortcut.events[0].details.combo, 'ctrl+shift+i');
  assert.equal(realShortcut.events[0].details.key, 'I', 'the raw evidence must be recorded');
  ok('a genuine Ctrl+Shift+I is detected (key="I", the shift-uppercased form)');

  assert.equal(
    realShortcut.prevented,
    true,
    'block:true must preventDefault in the capture phase, before the browser opens DevTools'
  );
  ok('block:true suppresses the real devtools shortcut');

  assert.equal(realShortcut.state?.count, 1, 'the detector must publish how many shortcuts it saw');
  ok('the detector publishes its own state');

  // (c) A custom combo, with the key only reachable through event.code: with
  //     Shift held a US layout reports "(" while code stays Digit9.
  const custom = await setupShortcuts({ enabled: true, block: true, combos: ['ctrl+shift+9'] });
  assert.deepEqual(custom.combos, ['ctrl+shift+9'], 'combos must replace the defaults');

  await pressShortcut({ key: 'I', code: 'KeyI', modifiers: MOD.ctrl | MOD.shift, vk: 73 });
  assert.equal(
    await page.evaluate('window.__pjsKeyEvents.length'),
    0,
    'the default devtools combo must no longer fire once combos is set'
  );
  ok('custom combos replace the shipped default list');

  await pressShortcut({ key: '(', code: 'Digit9', modifiers: MOD.ctrl | MOD.shift, vk: 57 });
  const digit = await teardownShortcuts();

  assert.equal(
    digit.events.length,
    1,
    `Ctrl+Shift+9 must match through event.code, got ${JSON.stringify(digit.events.map((e) => e.details?.code))}`
  );
  assert.equal(digit.events[0].details.combo, 'ctrl+shift+9');
  assert.equal(digit.events[0].details.code, 'Digit9');
  assert.equal(digit.events[0].details.label, null, 'an unknown combo has no label');
  ok('a custom combo matches through event.code when the layout prints another character');

  // (d) An unrelated key must still reach the page even while block is on.
  const passthrough = await setupShortcuts({ enabled: true, block: true });
  await pressCharacter({ key: 'a', code: 'KeyA', vk: 65 });

  assert.equal(
    await page.evaluate('window.__pjsKeyEvents.length'),
    0,
    'an ordinary keystroke must not be reported'
  );
  assert.equal(
    await page.evaluate('window.__pjsKeyPrevented'),
    false,
    'block must never swallow a keystroke the host did not ask about'
  );
  await teardownShortcuts();
  ok('block:true leaves unrelated keystrokes alone');

  // ---------------------------------------------------------------------
  // 10. Third-party capture software.
  //
  //     This machine has no OBS installed, so the honest result of a scan is
  //     silence — and that is asserted, because a detector that fires on a
  //     clean machine is worse than no detector. The scan -> match -> report
  //     path is then proved by declaring the browser's *own* fake device label
  //     as a pattern, which exercises the real enumerateDevices() output
  //     without needing third-party software on the box.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: third-party capture software');

  const helper = await page.evaluate(`(async () => {
    const { matchThirdPartyDevice, KNOWN_THIRD_PARTY_DEVICES } = await import('/src/index.js');
    return {
      hit: matchThirdPartyDevice('OBS Virtual Camera'),
      miss: matchThirdPartyDevice('Integrated Camera'),
      empty: matchThirdPartyDevice(''),
      count: KNOWN_THIRD_PARTY_DEVICES.length,
    };
  })()`);

  assert.equal(helper.hit?.pattern, 'obs virtual camera');
  assert.equal(helper.miss, null, 'real hardware must not be flagged');
  assert.equal(helper.empty, null, 'an empty label must never match everything');
  assert.ok(helper.count >= 20, 'the shipped device list must be real');
  ok(`the matcher and its ${helper.count}-entry device list ship in the browser build`);

  const scan = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');

    // Readable labels require permission, exactly as a proctored page would have
    // obtained through its camera detector.
    let granted = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      granted = true;
      for (const track of stream.getTracks()) track.stop();
    } catch (err) {
      return { granted: false, message: String(err) };
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const labelled = devices.filter((d) => d.label);
    const probe = labelled.find((d) => d.kind === 'videoinput');

    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      thirdParty: {
        enabled: true,
        detectActiveCamera: false,
        scanIntervalMs: 0,
        devices: probe ? [probe.label] : null,
      },
    });

    const events = [];
    proctor.on('violation', (v) => events.push(v));
    await proctor.start();

    const state = proctor.getDetectorState('thirdParty');
    const report = proctor.getReport();
    proctor.destroy();

    return {
      granted,
      labelledCount: labelled.length,
      probeLabel: probe ? probe.label : null,
      events,
      state,
      total: report.total,
    };
  })()`);

  assert.equal(scan.granted, true, `fake device must be grantable: ${scan.message ?? ''}`);
  assert.ok(scan.labelledCount > 0, 'labels must be readable once permission is granted');
  assert.equal(scan.state?.status, 'running', 'the detector must reach a running state');

  const reported = scan.events.filter((v) => v.details?.device === scan.probeLabel);
  assert.equal(
    reported.length,
    1,
    `the declared pattern must be reported exactly once, got ${JSON.stringify(scan.events.map((v) => v.details))}`
  );
  assert.equal(reported[0].type, 'third-party-device');
  assert.equal(reported[0].detector, 'thirdParty');
  assert.ok(
    scan.events.every((v) => v.type === 'third-party-device'),
    'a clean machine must produce no other third-party violation'
  );
  ok(`a real enumerateDevices() scan reports a matched device (${scan.probeLabel})`);

  const wrapper = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');
    const original = navigator.mediaDevices.getDisplayMedia;
    const hadApi = typeof original === 'function';

    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      // Screen-share observation only; the other two signals are proved above.
      thirdParty: { enabled: true, detectVirtualDevices: false, detectActiveCamera: false },
    });

    await proctor.start();
    const patched = navigator.mediaDevices.getDisplayMedia !== original;
    const patchedIsCallable = typeof navigator.mediaDevices.getDisplayMedia === 'function';

    proctor.destroy();
    return {
      hadApi,
      patched,
      patchedIsCallable,
      restored: navigator.mediaDevices.getDisplayMedia === original,
    };
  })()`);

  assert.equal(wrapper.hadApi, true, 'Edge must expose getDisplayMedia');
  assert.equal(wrapper.patched, true, 'the wrapper must land on the real MediaDevices object');
  assert.equal(wrapper.patchedIsCallable, true, 'and must still be callable');
  assert.equal(
    wrapper.restored,
    true,
    'destroy() must remove it — a permanent patch on a standard API is indistinguishable from a hijack'
  );
  ok('getDisplayMedia is wrapped while running, and restored on destroy');

  // ---------------------------------------------------------------------
  // 10b. The live-camera signal, against a real MediaStreamTrack.
  //
  //      The Node suite can only hand `_checkActiveCamera()` a stubbed track,
  //      so the part that actually matters is proved here: the detector reads
  //      the camera detector's *own* track rather than opening a second stream
  //      — in a real session a second stream means a second permission prompt
  //      — and a genuine camera is never reported. OBS is not installed on this
  //      machine, so the honest result is silence, and that is asserted.
  // ---------------------------------------------------------------------

  const cameraWatch = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');

    // Counting calls is the only honest way to show no second stream is
    // opened. The demo page never calls getUserMedia itself, so every call
    // counted here belongs to the library.
    const media = navigator.mediaDevices;
    const originalGetUserMedia = media.getUserMedia;
    let calls = 0;
    media.getUserMedia = function (...args) {
      calls += 1;
      return originalGetUserMedia.apply(this, args);
    };

    const video = document.createElement('video');
    video.id = 'cam-watch';
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);

    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      tabs: { enabled: false },
      camera: { enabled: true, videoElement: '#cam-watch', throttleMs: 0 },
      // Only the camera signal. The device scan and the getDisplayMedia
      // wrapper are proved above; leaving them off makes any violation here
      // attributable to the live track alone.
      thirdParty: {
        enabled: true,
        detectVirtualDevices: false,
        detectScreenShare: false,
        detectActiveCamera: true,
        checkIntervalMs: 40,
      },
    });

    const events = [];
    proctor.on('violation', (v) => events.push({ type: v.type, details: v.details }));
    proctor.on('detector:error', ({ detector, error }) =>
      events.push({ failed: detector, message: error.message })
    );

    try {
      await proctor.start();
      const callsAfterStart = calls;

      const track = proctor.getDetector('camera')?.getStream?.()?.getVideoTracks?.()[0] ?? null;

      // getSettings() is the call the detector makes on every tick, so a
      // throw here would be a live bug on real hardware.
      let settings = null;
      let settingsError = null;
      try {
        settings = track ? { ...track.getSettings() } : null;
      } catch (err) {
        settingsError = String(err);
      }

      const label = track ? track.label : null;
      const readyState = track ? track.readyState : null;

      // Several checkIntervalMs ticks. A real camera must stay silent on every
      // one of them — a detector that fires on ordinary hardware is worse than
      // no detector at all.
      await new Promise((done) => setTimeout(done, 320));

      return {
        callsAfterStart,
        label,
        readyState,
        settings,
        settingsError,
        events,
        status: proctor.getDetectorState('thirdParty')?.status ?? null,
      };
    } finally {
      proctor.destroy();
      media.getUserMedia = originalGetUserMedia;
      video.remove();
    }
  })()`);

  assert.equal(
    cameraWatch.callsAfterStart,
    1,
    `thirdParty must reuse the camera stream instead of opening its own (saw ${cameraWatch.callsAfterStart} getUserMedia calls)`
  );
  ok('third-party detection reuses the camera stream (no second permission prompt)');

  assert.equal(
    cameraWatch.settingsError,
    null,
    `getSettings() threw on a real track: ${cameraWatch.settingsError}`
  );
  assert.equal(cameraWatch.readyState, 'live', 'the camera track must be live while watched');
  assert.ok(cameraWatch.label, 'a granted camera track must expose a label');
  assert.equal(cameraWatch.status, 'running', 'the detector must report a running state');
  ok(`the live track is readable (label="${cameraWatch.label}", settings keys=${Object.keys(cameraWatch.settings ?? {}).length})`);

  assert.deepEqual(
    cameraWatch.events,
    [],
    `a real camera must produce no violation and no error: ${JSON.stringify(cameraWatch.events)}`
  );
  ok('a real camera is never reported as a virtual device');

  // ---------------------------------------------------------------------
  // 10c. The same path, with a match forced.
  //
  //      The label that *is* on this machine is declared as a pattern, so the
  //      detector has to match the live track's own label — and report it once
  //      on change, not once per tick.
  // ---------------------------------------------------------------------

  const cameraMatch = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');

    // Labels stay blank until permission is granted, so ask first — exactly
    // what a proctored page's own camera detector does.
    const probe = await navigator.mediaDevices.getUserMedia({ video: true });
    const label = probe.getVideoTracks()[0]?.label ?? null;
    for (const t of probe.getTracks()) t.stop();
    if (!label) return { label: null, events: [] };

    const video = document.createElement('video');
    video.id = 'cam-match';
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);

    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      tabs: { enabled: false },
      camera: { enabled: true, videoElement: '#cam-match', throttleMs: 0 },
      thirdParty: {
        enabled: true,
        detectVirtualDevices: false,
        detectScreenShare: false,
        detectActiveCamera: true,
        checkIntervalMs: 40,
        devices: [label],
      },
    });

    const events = [];
    proctor.on('violation', (v) => events.push({ type: v.type, details: v.details }));
    proctor.on('detector:error', ({ detector, error }) =>
      events.push({ failed: detector, message: error.message })
    );

    try {
      await proctor.start();
      // Long enough for many checkIntervalMs ticks: a state must be reported
      // once on change, not once per tick.
      await new Promise((done) => setTimeout(done, 320));
      return { label, events };
    } finally {
      proctor.destroy();
      video.remove();
    }
  })()`);

  assert.ok(cameraMatch.label, 'a camera label must be readable once permission is granted');

  const virtual = cameraMatch.events.filter((v) => v.type === 'virtual-camera-active');
  assert.equal(
    virtual.length,
    1,
    `a virtual camera must be reported exactly once across many ticks, got ${virtual.length}: ${JSON.stringify(cameraMatch.events)}`
  );
  assert.equal(virtual[0].details.device, cameraMatch.label, 'the report must name the live track');
  assert.equal(
    virtual[0].details.matched,
    cameraMatch.label.trim().toLowerCase(),
    'the report must name the pattern that matched'
  );
  assert.equal(
    cameraMatch.events.some((v) => v.type === 'third-party-device'),
    false,
    'with the device scan off, the camera path must not also report a scan hit'
  );
  ok(`the live camera track is matched once, not once per tick (matched="${virtual[0].details.matched}")`);

  // ---------------------------------------------------------------------
  // 11. Clipboard detector against genuine keystrokes.
  //    A synthetic `dispatchEvent` would only prove a listener exists. Ctrl+C
  //    pushed through the browser's own input pipeline proves the capture-phase
  //    wiring, which is the part a page could otherwise hide.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: clipboard detector');

  const clipSetup = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');

    const input = document.createElement('textarea');
    input.id = 'clip-probe';
    input.value = 'exam question text';
    document.body.appendChild(input);
    input.focus();
    input.select();

    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      tabs: { enabled: false },
      clipboard: { enabled: true, throttleMs: 0, block: false },
    });

    window.__clip = { events: [], prevented: [] };
    proctor.on('violation', (v) => window.__clip.events.push({ type: v.type, details: v.details }));

    // Registered in the bubble phase, so it runs *after* the detector's
    // capture-phase listener and can observe what the detector suppressed.
    document.addEventListener('copy', (e) => window.__clip.prevented.push(e.defaultPrevented));

    await proctor.start();
    window.__clipProctor = proctor;

    return { status: proctor.getDetectorState('clipboard')?.status ?? null };
  })()`);

  assert.equal(clipSetup.status, 'running', 'the clipboard detector must reach a running state');
  ok('the clipboard detector attaches in a real page');

  const selectAll = () =>
    page.evaluate(`(() => {
      const input = document.getElementById('clip-probe');
      input.focus();
      input.select();
      return input.value.length;
    })()`);

  await selectAll();
  await pressShortcut({ key: 'c', code: 'KeyC', modifiers: MOD.ctrl, vk: 67 });
  await selectAll();
  await pressShortcut({ key: 'x', code: 'KeyX', modifiers: MOD.ctrl, vk: 88 });
  await selectAll();
  await pressShortcut({ key: 'v', code: 'KeyV', modifiers: MOD.ctrl, vk: 86 });

  const clipResult = await page.evaluate(`(() => {
    const proctor = window.__clipProctor;
    proctor.destroy();
    document.getElementById('clip-probe')?.remove();
    return { ...window.__clip, total: proctor.getReport().total };
  })()`);

  assert.deepEqual(
    clipResult.events.map((e) => e.type).sort(),
    ['clipboard-copy', 'clipboard-cut', 'clipboard-paste'],
    `expected one violation per real keystroke, got ${JSON.stringify(clipResult.events)}`
  );
  ok('a real Ctrl+C / Ctrl+X / Ctrl+V each produce their own violation');

  assert.ok(
    clipResult.events.every((e) => e.details.target === 'textarea#clip-probe'),
    `each violation must name the element it happened in: ${JSON.stringify(clipResult.events.map((e) => e.details.target))}`
  );
  ok('each clipboard violation names the element it happened in');

  assert.ok(
    clipResult.events.every((e) => typeof e.details.textLength === 'number'),
    `the selection length must be measured: ${JSON.stringify(clipResult.events.map((e) => e.details))}`
  );
  assert.ok(
    !JSON.stringify(clipResult.events).includes('exam question text'),
    'the clipboard contents must never appear in a violation'
  );
  ok('the length is recorded and the clipboard contents are not');

  assert.equal(clipResult.prevented.some(Boolean), false, 'block:false must not suppress the copy');
  ok('block:false leaves the real clipboard operation alone');

  // Now the opposite posture: `block: true` must suppress a genuine copy, which
  // is only observable through `defaultPrevented` on a later listener.
  const clipBlocked = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');

    const input = document.createElement('textarea');
    input.id = 'clip-blocked';
    input.value = 'do not copy me';
    document.body.appendChild(input);
    input.focus();
    input.select();

    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      tabs: { enabled: false },
      clipboard: { enabled: true, block: true, throttleMs: 0 },
    });

    window.__blocked = [];
    document.addEventListener('copy', (e) => window.__blocked.push(e.defaultPrevented));

    await proctor.start();
    window.__blockedProctor = proctor;
    return true;
  })()`);

  assert.equal(clipBlocked, true);
  await page.evaluate(`(() => {
    const input = document.getElementById('clip-blocked');
    input.focus();
    input.select();
  })()`);
  await pressShortcut({ key: 'c', code: 'KeyC', modifiers: MOD.ctrl, vk: 67 });

  const blockedResult = await page.evaluate(`(() => {
    const proctor = window.__blockedProctor;
    const prevented = window.__blocked.slice();
    proctor.destroy();
    document.getElementById('clip-blocked')?.remove();
    return prevented;
  })()`);

  assert.ok(
    blockedResult.some(Boolean),
    `block:true must call preventDefault on a real copy: ${JSON.stringify(blockedResult)}`
  );
  ok('block:true suppresses a genuine copy in the real input pipeline');

  // ---------------------------------------------------------------------
  // 12. Tab close, delivered while the document is going away.
  //
  //     A synthetic PageTransitionEvent, but dispatched on the *real* window and
  //     consumed by the *real* listener. What matters here is the delivery path:
  //     the transport's own `pagehide` flush has already run by the time the
  //     detector reports, so a queued send would be lost. `sendBeacon` is
  //     stubbed, so this proves the routing without touching the network.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: tab close');

  const tabClose = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');

    const ENDPOINT = 'https://proctor.invalid/collect';
    const proctor = new Proctor({
      sessionId: 'beacon-session',
      logLevel: 'silent',
      report: { persist: false },
      tabs: { enabled: true, reportOnClose: true },
      backend: { enabled: true, endpoint: ENDPOINT },
    });

    const beacons = [];
    const bodies = [];
    const originalBeacon = navigator.sendBeacon;
    navigator.sendBeacon = (url, blob) => {
      beacons.push({ url, size: blob ? blob.size : 0 });
      // The body is what actually reaches the endpoint, so read it rather than
      // trusting the payload builder.
      bodies.push(blob && typeof blob.text === 'function' ? blob.text() : Promise.resolve(null));
      return true;
    };

    const violations = [];
    proctor.on('violation', (v) => violations.push({ type: v.type, details: v.details }));

    const sent = [];
    const originalSend = proctor.transport.send.bind(proctor.transport);
    proctor.transport.send = (violation, options) => {
      sent.push({ type: violation.type, terminal: options ? options.terminal === true : false });
      return originalSend(violation, options);
    };

    await proctor.start();

    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    await new Promise((done) => setTimeout(done, 60));

    const beaconBodies = await Promise.all(bodies);

    proctor.destroy();
    navigator.sendBeacon = originalBeacon;

    return { violations, sent, beacons, beaconBodies, endpoint: ENDPOINT };
  })()`);

  assert.equal(tabClose.violations.length, 1, `expected one tab-closed: ${JSON.stringify(tabClose.violations)}`);
  assert.equal(tabClose.violations[0].type, 'tab-closed');
  assert.equal(tabClose.violations[0].details.wasVisible, true);
  ok('a real pagehide reports tab-closed');

  assert.equal(tabClose.sent[0].terminal, true, 'tab-closed must be routed as terminal');
  ok('tab-closed is routed past the queue, which has already been flushed');

  assert.equal(
    tabClose.beacons.length,
    1,
    `the violation must leave over sendBeacon, got ${JSON.stringify(tabClose.beacons)}`
  );
  assert.equal(tabClose.beacons[0].url, tabClose.endpoint);
  assert.ok(tabClose.beacons[0].size > 0, 'the beacon payload must not be empty');
  ok('the violation is beaconed out with the document, not lost with it');

  // The size only proves *something* left. Read the body, because the whole
  // point of adding `sessionId` is that the receiver can identify the session
  // from a payload that arrives while the page is already gone.
  const beaconBody = JSON.parse(tabClose.beaconBodies[0]);
  assert.equal(
    beaconBody.sessionId,
    'beacon-session',
    `the beacon body must carry the session id: ${tabClose.beaconBodies[0]}`
  );
  assert.equal(beaconBody.violations.length, 1);
  assert.equal(beaconBody.violations[0].type, 'tab-closed');
  ok('the beaconed body carries the session id and the violation');

  // ---------------------------------------------------------------------
  // 13. Periodic snapshots.
  //     Webcam first: a real JPEG from the live track, on a timer, with the
  //     report untouched. Then page capture, which needs getDisplayMedia.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: periodic snapshots');

  const snapshots = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');

    const video = document.createElement('video');
    video.id = 'snap-preview';
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);

    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      tabs: { enabled: false },
      camera: {
        enabled: true,
        videoElement: '#snap-preview',
        throttleMs: 0,
        snapshotIntervalMs: 60,
      },
    });

    const shots = [];
    const violations = [];
    proctor.on('snapshot', (s) =>
      shots.push({ source: s.source, bytes: s.bytes, width: s.width, height: s.height, head: s.dataUrl.slice(0, 22) })
    );
    proctor.on('violation', (v) => violations.push({ type: v.type }));

    await proctor.start();
    await new Promise((done) => setTimeout(done, 420));

    const report = proctor.getReport();
    proctor.destroy();
    video.remove();

    return { shots, violations, total: report.total, score: report.score };
  })()`);

  assert.ok(
    snapshots.shots.length >= 2,
    `expected several snapshots from a 60ms interval, got ${snapshots.shots.length}`
  );
  assert.ok(
    snapshots.shots.every((s) => s.source === 'webcam'),
    'every webcam snapshot must be labelled as such'
  );
  assert.ok(
    snapshots.shots.every((s) => s.head.startsWith('data:image/jpeg')),
    `snapshots must be JPEG data URLs, got ${JSON.stringify(snapshots.shots[0])}`
  );
  assert.ok(
    snapshots.shots.every((s) => s.bytes > 0 && s.width > 0 && s.height > 0),
    `every snapshot must carry real pixels: ${JSON.stringify(snapshots.shots[0])}`
  );
  ok(`webcam snapshots capture real frames (${snapshots.shots.length} taken, ${snapshots.shots[0].bytes} bytes)`);

  assert.equal(snapshots.total, 0, 'a snapshot is a sample, not a violation');
  assert.equal(snapshots.score, 100);
  assert.deepEqual(snapshots.violations, [], 'snapshots must not disturb the report');
  ok('snapshots never enter the report or the score');

  // Page capture. `getDisplayMedia` is gated on transient activation, which a
  // scripted run cannot produce — but Edge's fake-UI flag auto-accepts, so this
  // either proves a real page frame or records the honest refusal.
  const pageCapture = await page.evaluate(`(async () => {
    const { Proctor } = await import('/src/index.js');

    const proctor = new Proctor({
      logLevel: 'silent',
      report: { persist: false },
      tabs: { enabled: false },
      pageCapture: { enabled: true, intervalMs: 80, maxWidth: 320 },
    });

    const shots = [];
    proctor.on('snapshot', (s) => shots.push({ source: s.source, bytes: s.bytes }));

    await proctor.start();

    let started = false;
    let error = null;
    try {
      await proctor.startPageCapture();
      started = true;
    } catch (err) {
      error = err.name + ': ' + err.message;
    }

    if (started) await new Promise((done) => setTimeout(done, 420));

    const capturing = proctor.isPageCapturing();
    proctor.stopPageCapture();
    const afterStop = proctor.isPageCapturing();
    proctor.destroy();

    return { started, error, shots, capturing, afterStop };
  })()`);

  if (pageCapture.started) {
    assert.equal(pageCapture.capturing, true, 'isPageCapturing() must be true while running');
    assert.ok(
      pageCapture.shots.length >= 2,
      `expected page snapshots on an 80ms interval, got ${pageCapture.shots.length}`
    );
    assert.ok(
      pageCapture.shots.every((s) => s.source === 'page' && s.bytes > 0),
      `page snapshots must be real frames: ${JSON.stringify(pageCapture.shots[0])}`
    );
    ok(`page capture takes real frames from the shared surface (${pageCapture.shots.length})`);
  } else {
    // A refusal is a legitimate outcome, but it must be a clear one.
    assert.match(
      String(pageCapture.error),
      /NotAllowedError|InvalidStateError|AbortError/,
      `an unusable getDisplayMedia must fail with a named error, got ${pageCapture.error}`
    );
    ok(`page capture refused cleanly without a gesture (${pageCapture.error})`);
  }

  assert.equal(pageCapture.afterStop, false, 'stopPageCapture() must release the surface');
  ok('stopPageCapture() releases the shared surface');

  // ---------------------------------------------------------------------
  // 14. Browser discovery is configurable and portable.
  //
  //     All four CDP suites depend on finding a browser, and that path used to
  //     be Windows-only — both the candidate list and the profile directory,
  //     which was built from `%TEMP%`. These checks pin the two properties that
  //     make the suites runnable elsewhere: a configurable override, and a
  //     candidate list that is not Windows-only.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: driver discovery');

  const realBrowser = resolveBrowserPath();
  assert.ok(
    realBrowser && existsSync(realBrowser),
    `the driver must find a browser on this machine, got ${realBrowser}`
  );
  ok('the driver finds a browser on this machine with no EDGE_PATH set');

  const hasWindows = DEFAULT_EDGE_PATHS.some((path) => /^[A-Za-z]:\\/.test(path));
  const hasPosix = DEFAULT_EDGE_PATHS.some((path) => path.startsWith('/'));
  assert.ok(hasWindows, 'the Windows candidates must stay in the list');
  assert.ok(
    hasPosix,
    `the candidate list must cover Linux too: ${JSON.stringify(DEFAULT_EDGE_PATHS)}`
  );
  ok('the built-in candidate list covers Windows and POSIX paths');

  const previousEdgePath = process.env.EDGE_PATH;
  try {
    process.env.EDGE_PATH = realBrowser;
    assert.equal(resolveBrowserPath(), realBrowser);
    ok('EDGE_PATH overrides the built-in candidates');

    // A path that is set but wrong must stop the run. Silently testing a
    // different browser than the one you configured is the failure that would
    // never be noticed, because every check would still pass.
    process.env.EDGE_PATH = '/no/such/browser';
    assert.throws(
      () => resolveBrowserPath(),
      /EDGE_PATH points at nothing/,
      'a wrong EDGE_PATH must fail loudly'
    );
    ok('a wrong EDGE_PATH stops the run instead of falling back silently');

    assert.throws(
      () => resolveBrowserPath({ edgePath: '/no/such/browser' }),
      /points at nothing/,
      'a wrong edgePath argument must fail the same way'
    );
    ok('a wrong edgePath argument fails the same way');

    process.env.EDGE_PATH = '   ';
    assert.equal(resolveBrowserPath(), realBrowser, 'a blank EDGE_PATH counts as unset');
    ok('a blank EDGE_PATH is treated as unset');
  } finally {
    if (previousEdgePath === undefined) delete process.env.EDGE_PATH;
    else process.env.EDGE_PATH = previousEdgePath;
  }

  // The profile must live outside the repo on every platform: `%TEMP%` does not
  // exist on Linux, where the old template string produced a *relative* path and
  // dropped the profile inside the working tree — the one place it must not be,
  // because Vite watches those files and reloads mid-check.
  const probeProfile = tmpProfile('pjs-probe');
  assert.ok(isAbsolute(probeProfile), `the profile path must be absolute, got ${probeProfile}`);
  assert.ok(
    !resolve(probeProfile).toLowerCase().startsWith(REPO_ROOT.toLowerCase()),
    `the profile must live outside the repo, got ${probeProfile}`
  );
  ok('tmpProfile() yields an absolute path outside the repository');

  // ---------------------------------------------------------------------
  // 15. No console noise.
  // ---------------------------------------------------------------------
  console.log('\nBrowser: console');
  const realErrors = page.errors.filter(
    // The demo page intentionally logs a fetch warning; ignore our own noise.
    (e) => !/proctoring\.js/.test(String(e))
  );
  assert.deepEqual(realErrors, [], `unexpected console errors: ${JSON.stringify(realErrors)}`);
  ok('console is clean');

  await page.screenshot(resolve(OUT_DIR, 'verify-demo.png'));

  console.log(`\nAll ${passed.length} browser checks passed.`);
} finally {
  await page.close();
}
