import { VIOLATION_TYPES } from '../core/options.js';
import { every, throttle, clamp } from '../core/utils.js';
import { loadFaceApiProvider } from '../face/providers.js';

/**
 * Face detector.
 *
 * Three independent signals, from cheapest to most informative:
 *  1. no face visible for longer than `awayGraceMs`  -> face-not-detected
 *  2. more than `maxFaces` faces visible             -> face-multiple
 *  3. face present but nose off-centre               -> face-looking-away
 *
 * Inference never runs faster than `intervalMs` (default 500ms). Running face
 * detection per animation frame would pin a core for the entire exam, and exam
 * laptops are usually cheap.
 */
export class FaceDetector {
  static name = 'face';

  constructor(config, context) {
    this.config = config;
    this.context = context;

    this.api = null;
    this.detectorOptions = null;
    this.videoElement = null;
    this.awaySince = 0;
    this.awayReported = false;
    this.multiFaceSince = 0;
    this.lookAwayStreak = 0;
    this.stopPolling = null;
    this.inferring = false;

    this._emit = throttle((type, details) => {
      this.context.report(type, details, { detector: 'face' });
    }, config.throttleMs);
  }

  async init() {
    this.videoElement = this._requiresCameraStream();
    if (!this.videoElement) return false;

    // Wait for real pixels before loading ~2MB of model weights over the wire.
    await waitForVideoReady(this.videoElement);

    const { api, modelUrl, source } = await loadFaceApiProvider(
      this.config.provider,
      this.config.providerOptions
    );
    this.api = api;

    // TensorFlow must have a ready backend *before* any net is loaded or
    // invoked. Skipping this throws "The highest priority backend 'wasm' has
    // not yet been initialized" — which is exactly the bug that made the
    // original muka.js unusable.
    const backend = await ensureBackend(api, this.context);

    await loadModels(api, modelUrl, this.config, this.context);

    this.detectorOptions = this._buildDetectorOptions();

    // A closed eye is not a violation, but face-api's default input size of 416
    // is slow on low-end hardware; 320 keeps it responsive without losing a
    // single centred face.
    this.context.setState('face', {
      active: true,
      status: 'running',
      source,
      modelUrl,
      backend,
    });

    this.stopPolling = every(this.config.intervalMs, () => this._tick());
    return true;
  }

  /**
   * The face detector does not open its own camera. Sharing one stream avoids a
   * second permission prompt and halves the encoding cost of two VideoStreams.
   */
  _requiresCameraStream() {
    const explicit = resolveElement(this.config.videoElement);
    if (explicit) return explicit;

    // Fall back to the camera detector's element when available.
    const camera = this.context.getDetector?.('camera');
    if (camera?.getVideoElement) return camera.getVideoElement();

    throw new Error(
      'proctoring.js: face detection needs a running video element. ' +
        'Enable `camera` (recommended) or pass `face.videoElement`.'
    );
  }

  _buildDetectorOptions() {
    const opts = new this.api.TinyFaceDetectorOptions({
      inputSize: 320,
      scoreThreshold: this.config.minConfidence,
    });
    return opts;
  }

  async _tick() {
    if (this.inferring) return;
    const video = this.videoElement;

    if (!video || video.readyState < 2 || !video.videoWidth) return;

    this.inferring = true;
    try {
      const detections = await this.api.detectAllFaces(video, this.detectorOptions);
      this._evaluate(detections, video);
    } catch (err) {
      // A single failed frame (e.g. a seek during teardown) must not kill the
      // loop; log once at debug level and carry on.
      this.context.log('debug', 'Face inference failed for one frame', { error: err });
    } finally {
      this.inferring = false;
    }
  }

  _evaluate(detections, video) {
    const now = Date.now();
    const faceCount = detections.length;

    if (faceCount > 0) this.lastSeenAt = now;

    this.context.setState('face', {
      active: true,
      status: 'running',
      faceCount,
      lastSeenAt: this.lastSeenAt || null,
    });

    // --- 1. no face -----------------------------------------------------
    if (faceCount === 0) {
      if (!this.awaySince) this.awaySince = now;
      const awayMs = now - this.awaySince;

      if (
        this.config.requireFace &&
        !this.awayReported &&
        awayMs >= this.config.awayGraceMs
      ) {
        this.awayReported = true;
        this._emit(VIOLATION_TYPES.FACE_NOT_DETECTED, { awayMs, faceCount });
        this.context.setState('face', { active: true, status: 'no-face', faceCount });
      }
      return;
    }

    // A face is back: reset the absence window.
    this.awaySince = 0;
    this.awayReported = false;

    // --- 2. too many faces ----------------------------------------------
    if (faceCount > this.config.maxFaces) {
      if (!this.multiFaceSince) this.multiFaceSince = now;
      const forMs = now - this.multiFaceSince;

      if (forMs >= this.config.multiFaceConfirmMs) {
        this._emit(VIOLATION_TYPES.FACE_MULTIPLE, {
          faceCount,
          maxFaces: this.config.maxFaces,
          forMs,
          confidences: detections.map((d) => round(d.score ?? d.detection?.score)),
        });
        this.context.setState('face', { active: true, status: 'multiple-faces', faceCount });
        // Reset so the next occurrence needs a fresh confirmation window.
        this.multiFaceSince = 0;
      }
      return;
    }
    this.multiFaceSince = 0;

    // --- 3. looking away --------------------------------------------------
    const box = detections[0].box || detections[0].detection?.box;
    if (box) this._checkGaze(box, video, faceCount);
  }

  /**
   * Approximate head pose from the bounding box.
   *
   * Deliberately not using landmarks: 68-point landmarks need a second model and
   * add latency, while the box centre is already a good proxy for "the student
   * turned away and only half their face is in frame".
   */
  _checkGaze(box, video, faceCount) {
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;

    // Without real dimensions every ratio is meaningless — a `|| 1` fallback
    // would turn "unknown size" into "definitely looking away" and fire a false
    // violation. `_tick` already guards this; the check is repeated here so the
    // method is safe to call directly.
    if (!videoW || !videoH) return;

    const centerX = (box.x + box.width / 2) / videoW;
    const centerY = (box.y + box.height / 2) / videoH;

    // Normalised distance from the middle of the frame, 0 = dead centre.
    const offsetX = Math.abs(centerX - 0.5) / 0.5;
    const offsetY = Math.abs(centerY - 0.5) / 0.5;
    const offset = Math.max(offsetX, offsetY);

    if (offset <= this.config.lookAwayTolerance) {
      this.lookAwayStreak = 0;
      return;
    }

    // Require two consecutive samples: a single off-centre frame is just motion.
    this.lookAwayStreak += 1;
    if (this.lookAwayStreak < 2) return;
    this.lookAwayStreak = 0;

    this._emit(VIOLATION_TYPES.FACE_LOOKING_AWAY, {
      faceCount,
      offset: round(offset),
      tolerance: this.config.lookAwayTolerance,
      box: {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
    });
  }

  getState() {
    return {
      active: Boolean(this.api),
      status: this.api ? 'running' : 'stopped',
      provider: this.config.provider,
      intervalMs: this.config.intervalMs,
    };
  }

  destroy() {
    if (this.stopPolling) this.stopPolling();
    this.stopPolling = null;
    this.videoElement = null;
    // `api` is intentionally kept: the module and its weights stay cached on the
    // page so restarting a session does not re-download them.
    this.api = null;
    this.inferring = false;
    this.context.setState('face', { active: false, status: 'destroyed' });
  }
}

/**
 * Ensure TensorFlow has an initialised backend before any net is used.
 *
 * face-api ships its own bundled tfjs and registers several backends, but does
 * not activate one. Until `tf.ready()` resolves, every net call throws
 * "The highest priority backend 'wasm' has not yet been initialized".
 *
 * Backends are tried in order of usefulness for face detection: WebGL (GPU,
 * fastest), WASM (good on machines without a usable GPU), CPU (always present).
 * A backend that is not registered at all is skipped rather than attempted,
 * because `setBackend` on a missing backend throws rather than falling back.
 *
 * @returns {Promise<string|null>} the active backend name, or null if the
 *   namespace exposes no tfjs handle (a custom provider may hide it).
 */
async function ensureBackend(api, context) {
  const tf = api.tf;
  if (!tf || typeof tf.ready !== 'function') {
    // Nothing to configure; let face-api do whatever it does internally.
    return null;
  }

  const registered = (name) => {
    try {
      // `findBackend` exists on modern tfjs; older builds only have getBackend.
      return typeof tf.findBackend === 'function' ? Boolean(tf.findBackend(name)) : true;
    } catch {
      return false;
    }
  };

  for (const name of ['webgl', 'wasm', 'cpu']) {
    if (!registered(name)) continue;
    try {
      await tf.setBackend(name);
      await tf.ready();
      const active = typeof tf.getBackend === 'function' ? tf.getBackend() : name;
      context.log('info', `Face detection running on the "${active}" backend`);
      return active;
    } catch (err) {
      context.log('debug', `Backend "${name}" unavailable, trying the next one`, { error: err });
    }
  }

  // Last resort: whatever tfjs picks by default. If this throws, the caller
  // surfaces it as a detector:error, which is the correct outcome.
  await tf.ready();
  return typeof tf.getBackend === 'function' ? tf.getBackend() : null;
}

/**
 * Load the smallest set of models that satisfies the enabled checks.
 * `tinyFaceDetector` is ~190KB versus ~5MB for SSD MobileNet, and is accurate
 * enough for a webcam at arm's length.
 *
 * Readiness is confirmed through `isLoaded` rather than the return value of
 * `loadFromUri`: some face-api builds resolve with `undefined`, so trusting the
 * return value reports a false failure on an otherwise working load.
 */
async function loadModels(api, modelUrl, config, context) {
  const nets = api.nets;
  if (!nets?.tinyFaceDetector) {
    throw new Error('proctoring.js: the resolved face-api namespace has no `nets.tinyFaceDetector`');
  }

  // face-api rejects a model URL without a trailing slash.
  const base = modelUrl.endsWith('/') ? modelUrl : `${modelUrl}/`;

  if (!nets.tinyFaceDetector.isLoaded) {
    try {
      await nets.tinyFaceDetector.loadFromUri(base);
    } catch (err) {
      throw new Error(
        `proctoring.js: failed to load face models from "${base}". ` +
          `Check that the model files are reachable and match face-api ${config.provider}. ` +
          `(${err?.message || err})`
      );
    }
  }

  if (!nets.tinyFaceDetector.isLoaded) {
    throw new Error(
      `proctoring.js: face models at "${base}" did not report as loaded. ` +
        `Verify the URL serves tiny_face_detector_model-weights_manifest.json and its .bin.`
    );
  }

  context.log('info', `Face models loaded from ${base}`);
}

/** Poll until the video element has real dimensions. */
function waitForVideoReady(video, timeoutMs = 15000) {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onReady);
    };
    const onReady = () => {
      if (video.videoWidth > 0) {
        cleanup();
        resolve();
      }
    };
    const poll = setInterval(onReady, 100);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('proctoring.js: the video element never produced frames'));
    }, timeoutMs);

    video.addEventListener('loadeddata', onReady);
  });
}

function resolveElement(target) {
  if (!target) return null;
  if (typeof target === 'string') return document.querySelector(target);
  if (typeof target === 'object' && target.nodeType === 1) return target;
  return null;
}

function round(value) {
  return typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
}

export { clamp };
