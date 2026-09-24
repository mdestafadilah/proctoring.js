/**
 * Canonical event names.
 *
 * Exported as a frozen object so consumers can do `Proctor.EVENTS.READY`
 * instead of hardcoding strings, while the string values stay stable and
 * greppable in logs.
 */
export const EVENTS = Object.freeze({
  /** Session constructed and environment validated. */
  READY: 'ready',
  /** `start()` completed; all enabled detectors are now active. */
  STARTED: 'started',
  /** A detector raised a violation. Payload: Violation */
  VIOLATION: 'violation',
  /** An individual detector finished initialising. Payload: { detector } */
  DETECTOR_READY: 'detector:ready',
  /** A detector failed to initialise. Payload: { detector, error } */
  DETECTOR_ERROR: 'detector:error',
  /** A detector was explicitly enabled at runtime. Payload: { detector } */
  DETECTOR_ENABLED: 'detector:enabled',
  /** A detector was explicitly disabled at runtime. Payload: { detector } */
  DETECTOR_DISABLED: 'detector:disabled',
  /** Diagnostic log line. Payload: { level, message, meta } */
  LOG: 'log',
  /** `stop()` completed. Payload: { report } */
  STOPPED: 'stopped',
  /** Session-level failure (e.g. no DOM, insecure context). Payload: Error */
  ERROR: 'error',
});

/** Violation types. Keys are stable identifiers; values are the wire format. */
export const VIOLATION_TYPES = Object.freeze({
  TAB_HIDDEN: 'tab-hidden',
  WINDOW_BLUR: 'window-blur',
  CAMERA_DISABLED: 'camera-disabled',
  CAMERA_MUTED: 'camera-muted',
  CAMERA_DENIED: 'camera-denied',
  FACE_NOT_DETECTED: 'face-not-detected',
  FACE_MULTIPLE: 'face-multiple',
  FACE_LOOKING_AWAY: 'face-looking-away',
  AUDIO_TOO_LOUD: 'audio-too-loud',
  AUDIO_MULTIPLE_VOICES: 'audio-multiple-voices',
});

/** Severity levels, ordered from least to most severe. */
export const SEVERITY = Object.freeze({
  INFO: 'info',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const SEVERITY_WEIGHT = {
  [SEVERITY.INFO]: 0,
  [SEVERITY.LOW]: 1,
  [SEVERITY.MEDIUM]: 2,
  [SEVERITY.HIGH]: 3,
  [SEVERITY.CRITICAL]: 4,
};

/** Default severity per violation type. Overridable via `options.severity`. */
export const DEFAULT_SEVERITY = Object.freeze({
  [VIOLATION_TYPES.TAB_HIDDEN]: SEVERITY.HIGH,
  [VIOLATION_TYPES.WINDOW_BLUR]: SEVERITY.MEDIUM,
  [VIOLATION_TYPES.CAMERA_DISABLED]: SEVERITY.CRITICAL,
  [VIOLATION_TYPES.CAMERA_MUTED]: SEVERITY.HIGH,
  [VIOLATION_TYPES.CAMERA_DENIED]: SEVERITY.CRITICAL,
  [VIOLATION_TYPES.FACE_NOT_DETECTED]: SEVERITY.MEDIUM,
  [VIOLATION_TYPES.FACE_MULTIPLE]: SEVERITY.HIGH,
  [VIOLATION_TYPES.FACE_LOOKING_AWAY]: SEVERITY.LOW,
  [VIOLATION_TYPES.AUDIO_TOO_LOUD]: SEVERITY.LOW,
  [VIOLATION_TYPES.AUDIO_MULTIPLE_VOICES]: SEVERITY.MEDIUM,
});

export function severityWeight(severity) {
  return SEVERITY_WEIGHT[severity] ?? 0;
}

/**
 * Default options.
 *
 * Every detector is OFF by default except `tabs`, which is dependency-free and
 * needs no permission prompt. Camera/face/audio require either a user gesture or
 * an explicit privacy consent, so opting in is the correct default for a
 * library that will be embedded in other people's exam pages.
 */
export const DEFAULT_OPTIONS = {
  /** Arbitrary session id supplied by the host app (exam attempt, user id...). */
  sessionId: null,

  /** Reserved for server-side correlation. */
  metadata: {},

  /** Emit `violation` for tab switch / window blur. No permissions needed. */
  tabs: {
    enabled: true,
    /** Also fire on window blur, not just document visibility change. */
    trackWindowBlur: true,
    /** Ignore violations shorter than this (ms) — filters alt-tab flicker. */
    /**
     * Minimum time the page must stay hidden before it counts.
     * Guards against instantaneous focus loss when opening a native menu.
     */
    minHiddenMs: 0,
    throttleMs: 300,
  },

  camera: {
    enabled: false,
    /** Preview element to attach the stream to. Selector, element, or null. */
    videoElement: null,
    width: 640,
    height: 480,
    facingMode: 'user',
    /** Report when the video track is muted (camera covered / revoked). */
    detectMuted: true,
    /** Report when the track ends (device unplugged, permission revoked). */
    detectEnded: true,
    /** Report when no frames are arriving even though the track is live. */
    /** Poll cadence for mute/ended checks, in ms. */
    checkIntervalMs: 1000,
    throttleMs: 2000,
  },

  face: {
    enabled: false,
    /** Must reference an already-running camera (selector or MediaStream). */
    videoElement: null,
    /**
     * Source of face-api. `cdn` lazy-loads `@vladmandic/face-api` from jsDelivr
     * and its matching model weights; `module` expects the peer dependency to be
     * installed by the host app; `custom` uses whatever is on `globalThis`.
     */
    provider: 'cdn',
    /** See src/face/providers.js for the shape of a custom provider. */
    providerOptions: {},
    /** How often to run inference. 500ms is a good accuracy/CPU trade-off. */
    intervalMs: 500,
    /** Detection confidence threshold, 0..1. */
    minConfidence: 0.5,
    /** Require at least one face. */
    requireFace: true,
    /** Report when zero faces are visible for `awayGraceMs`. */
    awayGraceMs: 2000,
    /** Report when more than one face is visible. */
    maxFaces: 1,
    /** Report when the nose drifts outside the frame box by this ratio. */
    lookAwayTolerance: 0.25,
    /** Require this many faces before firing a multiple-faces violation. */
    multiFaceConfirmMs: 0,
    throttleMs: 3000,
  },

  audio: {
    enabled: false,
    /** RMS level (0..1) above which the room is considered too loud. */
    rmsThreshold: 0.08,
    /** Report sustained loudness only after this many ms. */
    loudGraceMs: 1500,
    /** Report when detected voice/whistle activity exceeds `voiceThreshold`. */
    voiceThreshold: 0.5,
    /** FFT size for the analyser; higher is more frequency resolution. */
    fftSize: 1024,
    /** Smoothing for the analyser, 0..1. */
    smoothingTimeConstant: 0.8,
    /** Treat the input as speech and try to count speakers. */
    detectMultipleVoices: false,
    throttleMs: 3000,
  },

  /** Deliver violations to an HTTP endpoint via fetch. Off by default. */
  backend: {
    enabled: false,
    /**
     * Endpoint URL. When null, built-in uploaders fall back to `#storage`
     * inside the host app; see src/core/store.js.
     */
    endpoint: null,
    method: 'POST',
    headers: {},
    /** Send as a JSON body (true) or keepalive beacon for page-unload (false). */
    /** Batch violations and flush every N ms. 0 = send immediately. */
    batchIntervalMs: 0,
    /** Queue violations while offline and flush on reconnect. */
    offlineQueue: true,
    /** Include the full report snapshot in every request. */
    includeReport: false,
    /** Retry count for failed requests. */
    retries: 2,
    /** Base delay between retries (exponential backoff). */
    retryDelayMs: 1000,
    /** Abort a request after this many ms. */
    timeoutMs: 10000,
    /** Only upload violations at or above this severity. null = all. */
    minSeverity: null,
  },

  /** Keep an in-memory + sessionStorage trail of everything that happened. */
  report: {
    /** Persist the report so it survives a page reload. */
    persist: true,
    storageKey: 'proctoring.js:report',
    /** Cap the stored violations to avoid unbounded growth. */
    maxViolations: 1000,
    /**
     * Attach a downscaled webcam frame to visual violations (camera/face).
     *
     * Off by default: capturing a candidate's image may create a notification
     * obligation, and it is the host app's decision to accept that.
     */
    captureScreenshots: false,
    /** Downscale target for captured frames, in pixels. 0 = native size. */
    screenshotMaxWidth: 320,
    /** JPEG quality for captured frames, 0..1. */
    screenshotQuality: 0.6,
    /**
     * Which violation types get a frame. `null` means "camera and face only".
     * Use an explicit list to narrow or widen it.
     */
    screenshotTypes: null,
    /**
     * Total budget for in-memory screenshots, in bytes. Once exceeded, new
     * frames are dropped and `droppedScreenshots` is incremented.
     */
    screenshotBudgetBytes: 8 * 1024 * 1024,
  },

  /** Log level: 'silent' | 'error' | 'warn' | 'info' | 'debug'. */
  logLevel: 'warn',

  /** Extra severity overrides, e.g. { 'tab-hidden': 'critical' }. */
  severity: {},
};

export const LOG_LEVELS = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});
