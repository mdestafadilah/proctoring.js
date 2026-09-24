import { Emitter } from './emitter.js';
import { ViolationStore } from './store.js';
import { BackendTransport } from './transport.js';
import { DEFAULT_OPTIONS, EVENTS, LOG_LEVELS, VIOLATION_TYPES, SEVERITY } from './options.js';
import { mergeOptions, isBrowser, isSecureContext } from './utils.js';
import { captureFrame, isVisualViolation } from './screenshot.js';
import { createDetector, DETECTOR_NAMES } from '../detectors/index.js';

/**
 * Proctoring session.
 *
 * Lifecycle:
 *   const proctor = new Proctor({ camera: { enabled: true } })
 *   proctor.on('violation', v => console.log(v))
 *   await proctor.start()
 *   ...
 *   const report = proctor.stop()
 *
 * The class owns orchestration and nothing else: each capability lives in
 * `src/detectors/*` and talks to this class only through `reportViolation` and
 * the `detector:ready`/`detector:error` events.
 */
export class Proctor {
  /**
   * @param {object} [options] see src/core/options.js
   */
  constructor(options = {}) {
    this.options = mergeOptions(DEFAULT_OPTIONS, options);
    this.emitter = new Emitter();
    this.emitter._logHandler = (level, message, meta) => this._log(level, message, meta);

    this.store = new ViolationStore(this.options, this.emitter);
    this.transport = new BackendTransport(this.options.backend, () => this.getReport());

    /** @type {Map<string, object>} */
    this.detectors = new Map();
    this.started = false;
    this.destroyed = false;

    if (this.options.report.persist && !this.options.sessionId) {
      // A restored session without an id is almost always a reload mid-exam;
      // surfacing it as a violation is the whole point of persistence.
      this._restoreInterruptedSession();
    }
  }

  // -- public API ----------------------------------------------------------

  /** Subscribe to an event. Returns an unsubscribe function. */
  on(event, handler) {
    return this.emitter.on(event, handler);
  }

  once(event, handler) {
    return this.emitter.once(event, handler);
  }

  off(event, handler) {
    this.emitter.off(event, handler);
  }

  /**
   * Start every enabled detector.
   *
   * Resolves even when an individual detector fails to initialise (a denied
   * camera must not stop tab monitoring). Failures surface through the
   * `detector:error` event.
   */
  async start(overrides = {}) {
    if (this.destroyed) throw new Error('proctoring.js: session was destroyed');
    if (this.started) return this;

    if (!isBrowser) {
      const err = new Error('proctoring.js: no DOM detected — this library is browser-only');
      this.emitter.emit(EVENTS.ERROR, err);
      throw err;
    }

    if (overrides && Object.keys(overrides).length > 0) {
      this.options = mergeOptions(this.options, overrides);
    }

    this.store.markStarted();
    this.started = true;

    const context = this._buildContext();
    const enabled = DETECTOR_NAMES.filter((name) => this.options[name]?.enabled !== false && this._isEnabled(name));

    await Promise.all(enabled.map((name) => this._setupDetector(name, context)));

    this.emitter.emit(EVENTS.STARTED, {
      startedAt: new Date(this.store.startedAt).toISOString(),
      detectors: [...this.detectors.keys()],
    });

    return this;
  }

  /** Stop all detectors and return the final report. */
  stop() {
    if (!this.started) return this.getReport();

    for (const [name, detector] of this.detectors) {
      try {
        detector.destroy();
      } catch (err) {
        this._log('error', `Detector "${name}" threw during teardown`, { error: err });
      }
    }
    this.detectors.clear();

    this.started = false;
    this.store.markStopped();
    this.transport.flush().catch(() => {
      /* Reported through the log channel already. */
    });

    const report = this.getReport();
    this.emitter.emit(EVENTS.STOPPED, { report });
    return report;
  }

  /** Current report snapshot. Safe to call at any time. */
  getReport() {
    return this.store.buildReport({
      score: this.store.score(),
      detectors: Object.keys(this.options).filter((k) => DETECTOR_NAMES.includes(k)),
      detectorStates: { ...this.store.detectorStates },
    });
  }

  /** Violation list, optionally filtered by minimum severity. */
  getViolations(minSeverity = null) {
    return this.store.filterBySeverity(minSeverity);
  }

  /** True when at least one violation of `type` was recorded. */
  hasViolation(type) {
    return (this.store.counts[type] || 0) > 0;
  }

  /** Live status of one detector, e.g. `camera.state`. */
  getDetector(name) {
    return this.detectors.get(name) || null;
  }

  getDetectorState(name) {
    return this.store.getDetectorState(name);
  }

  /** Enable a detector after start. Re-runs its initialisation. */
  async enableDetector(name) {
    assertDetectorName(name);
    if (!this.started) {
      this.options[name].enabled = true;
      return false;
    }
    if (this.detectors.has(name)) return false;

    await this._setupDetector(name, this._buildContext());
    this.emitter.emit(EVENTS.DETECTOR_ENABLED, { detector: name });
    return true;
  }

  /** Disable a detector and release its resources. */
  disableDetector(name) {
    assertDetectorName(name);
    this.options[name].enabled = false;

    const detector = this.detectors.get(name);
    if (!detector) return false;

    try {
      detector.destroy();
    } finally {
      this.detectors.delete(name);
      this.store.setDetectorState(name, { active: false });
    }
    this.emitter.emit(EVENTS.DETECTOR_DISABLED, { detector: name });
    return true;
  }

  /** Reset violations but keep detectors running. */
  clearViolations() {
    this.store.clear();
    this.store.markStarted();
  }

  /**
   * Tear down everything and release every listener.
   *
   * Also closes the session window if the caller never called `stop()`. Without
   * this, `destroy()` silently produced a report with `endedAt: null`, which
   * reads downstream as "still running".
   */
  destroy() {
    if (this.started) {
      this.stop();
    } else if (!this.store.endedAt && this.store.startedAt) {
      this.store.markStopped();
    }
    this.transport.destroy();
    this.emitter.removeAllListeners();
    this.destroyed = true;
  }

  /**
   * Called by detectors. Public so a host app can log its own custom
   * violations into the same report (e.g. a suspicious copy/paste).
   *
   * @param {string} type
   * @param {object} [details]
   * @param {object} [meta] { detector, severity, timestamp }
   * @returns {object|null}
   */
  reportViolation(type, details = {}, meta = {}) {
    if (!this.started) {
      this._log('warn', `Ignored violation "${type}" because the session is not running`, { type });
      return null;
    }

    const violation = this.store.add(type, details, meta);
    if (!violation) return null;

    // Capture before sending: the transport may upload synchronously (batching
    // disabled), and the frame is part of the evidence we want to upload.
    if (this.options.report.captureScreenshots) {
      this._captureScreenshot(violation);
    }

    this.transport.send(violation);
    return violation;
  }

  /**
   * Attach a webcam frame to a visual violation.
   *
   * Reads the video element from the camera detector rather than storing a
   * reference here, so a disabled camera cleanly yields no screenshot instead of
   * a stale element.
   */
  _captureScreenshot(violation) {
    const { screenshotTypes, screenshotMaxWidth, screenshotQuality } = this.options.report;

    if (!isVisualViolation(violation.type, violation.detector, screenshotTypes)) return;

    const video = this.detectors.get('camera')?.getVideoElement?.();
    if (!video) return;

    const dataUrl = captureFrame(video, {
      maxWidth: screenshotMaxWidth,
      quality: screenshotQuality,
    });

    if (!dataUrl) {
      this._log('debug', 'Screenshot capture produced no frame', { type: violation.type });
      return;
    }

    const attached = this.store.attachScreenshot(violation, dataUrl);
    if (!attached) {
      this._log('warn', 'Screenshot dropped: the in-memory budget is exhausted', {
        type: violation.type,
      });
    }
  }

  // -- internals -----------------------------------------------------------

  _isEnabled(name) {
    return this.options[name]?.enabled === true;
  }

  /** Shared services handed to each detector. */
  _buildContext() {
    return {
      options: this.options,
      /**
       * Detector-facing violation sink. Binds the detector name so individual
       * detectors cannot forget to identify themselves.
       */
      report: (type, details, meta = {}) =>
        this.reportViolation(type, details, { ...meta, detector: meta.detector || undefined }),
      log: (level, message, meta) => this._log(level, message, meta),
      emit: (event, payload) => this.emitter.emit(event, payload),
      setState: (detector, state) => this.store.setDetectorState(detector, state),
      /**
       * Lets one detector reuse another's resource. The face detector relies on
       * this to share the camera stream instead of prompting a second time.
       */
      getDetector: (name) => this.detectors.get(name) || null,
    };
  }

  async _setupDetector(name, context) {
    let detector;
    try {
      detector = createDetector(name, this.options[name], context);
    } catch (err) {
      this._emitDetectorError(name, err);
      return;
    }

    this.detectors.set(name, detector);
    this.store.setDetectorState(name, { active: true, status: 'starting' });

    try {
      await detector.init();
      this.store.setDetectorState(name, { active: true, status: 'running' });
      this.emitter.emit(EVENTS.DETECTOR_READY, { detector: name });
      this._log('info', `Detector "${name}" ready`);
    } catch (err) {
      // An unusable detector is removed rather than left half-initialised, so
      // `isRunning('camera')` never reports a broken camera as healthy.
      this.detectors.delete(name);
      this.store.setDetectorState(name, { active: false, status: 'failed', error: err?.message });
      this._emitDetectorError(name, err);
    }
  }

  _emitDetectorError(name, err) {
    this._log('error', `Detector "${name}" failed to initialise`, { error: err });
    this.emitter.emit(EVENTS.DETECTOR_ERROR, { detector: name, error: err });
  }

  /**
   * Detect evidence of a previous session that never called `stop()`.
   * A reload during an exam is itself worth flagging.
   */
  _restoreInterruptedSession() {
    const restored = this.store.restore();
    if (restored && this.store.startedAt && !this.store.endedAt) {
      this._interrupted = {
        startedAt: this.store.startedAt,
        violations: this.store.violations.length,
      };
      // Reset counters so the new session starts clean, but remember the fact.
      this.store.violations = [];
      this.store.counts = Object.create(null);
    }
  }

  _log(level, message, meta) {
    const threshold = LOG_LEVELS[this.options.logLevel] ?? LOG_LEVELS.warn;
    const weight = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    this.emitter.emit(EVENTS.LOG, { level, message, meta });
    if (weight > threshold) return;

    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (typeof console !== 'undefined' && typeof sink === 'function') {
      sink(`[proctoring.js] ${message}`, meta ?? '');
    }
  }
}

function assertDetectorName(name) {
  if (!DETECTOR_NAMES.includes(name)) {
    throw new Error(
      `proctoring.js: unknown detector "${name}". Expected one of: ${DETECTOR_NAMES.join(', ')}`
    );
  }
}

// `isSecureContext` is re-exported through utils for detectors that need it.
export { EVENTS, VIOLATION_TYPES, SEVERITY, isSecureContext };

/** Convenience factory so consumers can write `createProctor(...)`. */
export function createProctor(options) {
  return new Proctor(options);
}

export default Proctor;
