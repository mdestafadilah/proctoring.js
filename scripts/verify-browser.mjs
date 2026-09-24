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
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:5180';
const passed = [];

// Derived from this file rather than hardcoded, so the script works from any
// checkout. `outputs/` is gitignored, so a fresh clone has no such directory and
// the run would otherwise die on its very last step.
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'outputs');
mkdirSync(OUT_DIR, { recursive: true });

function ok(label) {
  passed.push(label);
  console.log(`  ok  ${label}`);
}

const page = await launchEdge({
  port: 9361,
  profileDir: `${process.env.TEMP}\\pjs-edge-profile`,
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
  assert.deepEqual(api.detectors, ['tabs', 'rightClick', 'shortcuts', 'camera', 'face', 'audio']);
  assert.equal(api.version, '0.3.0');
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
  // 10. No console noise.
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
