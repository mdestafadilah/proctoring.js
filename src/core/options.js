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
  /**
   * A periodic capture was taken. Payload: Snapshot
   *
   * Deliberately not a violation: a snapshot is a sample, not an accusation,
   * so it never enters the report or the score.
   */
  SNAPSHOT: 'snapshot',
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
  TAB_CLOSED: 'tab-closed',
  WINDOW_BLUR: 'window-blur',
  RIGHT_CLICK: 'right-click',
  SHORTCUT_USED: 'shortcut-used',
  CLIPBOARD_COPY: 'clipboard-copy',
  CLIPBOARD_CUT: 'clipboard-cut',
  CLIPBOARD_PASTE: 'clipboard-paste',
  CAMERA_DISABLED: 'camera-disabled',
  CAMERA_MUTED: 'camera-muted',
  CAMERA_DENIED: 'camera-denied',
  FACE_NOT_DETECTED: 'face-not-detected',
  FACE_MULTIPLE: 'face-multiple',
  FACE_LOOKING_AWAY: 'face-looking-away',
  AUDIO_TOO_LOUD: 'audio-too-loud',
  AUDIO_MULTIPLE_VOICES: 'audio-multiple-voices',
  THIRD_PARTY_DEVICE: 'third-party-device',
  VIRTUAL_CAMERA_ACTIVE: 'virtual-camera-active',
  SCREEN_SHARE_STARTED: 'screen-share-started',
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
  /**
   * Leaving the page is not by itself evidence of anything — every candidate
   * closes the tab when they finish. High only because it is terminal: there is
   * no later violation to put it in context with.
   */
  [VIOLATION_TYPES.TAB_CLOSED]: SEVERITY.HIGH,
  [VIOLATION_TYPES.WINDOW_BLUR]: SEVERITY.MEDIUM,
  [VIOLATION_TYPES.RIGHT_CLICK]: SEVERITY.MEDIUM,
  [VIOLATION_TYPES.SHORTCUT_USED]: SEVERITY.HIGH,
  /** Copying question text out and pasting an answer in are the two halves of
   *  the same act, so they share a severity; a host that cares about only one
   *  direction can override either via `options.severity`. */
  [VIOLATION_TYPES.CLIPBOARD_COPY]: SEVERITY.MEDIUM,
  [VIOLATION_TYPES.CLIPBOARD_CUT]: SEVERITY.MEDIUM,
  [VIOLATION_TYPES.CLIPBOARD_PASTE]: SEVERITY.MEDIUM,
  [VIOLATION_TYPES.CAMERA_DISABLED]: SEVERITY.CRITICAL,
  [VIOLATION_TYPES.CAMERA_MUTED]: SEVERITY.HIGH,
  [VIOLATION_TYPES.CAMERA_DENIED]: SEVERITY.CRITICAL,
  [VIOLATION_TYPES.FACE_NOT_DETECTED]: SEVERITY.MEDIUM,
  [VIOLATION_TYPES.FACE_MULTIPLE]: SEVERITY.HIGH,
  [VIOLATION_TYPES.FACE_LOOKING_AWAY]: SEVERITY.LOW,
  [VIOLATION_TYPES.AUDIO_TOO_LOUD]: SEVERITY.LOW,
  [VIOLATION_TYPES.AUDIO_MULTIPLE_VOICES]: SEVERITY.MEDIUM,
  /**
   * Merely *installed* is medium: a virtual camera on the machine is a
   * capability, not yet an act. Actually being used is high, below.
   */
  [VIOLATION_TYPES.THIRD_PARTY_DEVICE]: SEVERITY.MEDIUM,
  [VIOLATION_TYPES.VIRTUAL_CAMERA_ACTIVE]: SEVERITY.HIGH,
  [VIOLATION_TYPES.SCREEN_SHARE_STARTED]: SEVERITY.HIGH,
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
    /**
     * Report `tab-closed` when the page is really going away.
     *
     * Off by default: every candidate closes the tab when they finish, and only
     * the host knows whether that is worth recording. `pagehide` fires on close,
     * reload and navigation alike, and delivery is best-effort — `sendBeacon` is
     * the only channel that survives teardown, and even that can be dropped.
     * A missing `tab-closed` therefore means "unknown", never "clean".
     */
    reportOnClose: false,
  },

  /**
   * Emit `violation` for right-click / context-menu use. No permissions needed.
   *
   * Off by default: a right-click is ordinary behaviour on most pages, and only
   * the host app knows whether it is suspicious in its context. Grouped with
   * `tabs` because it is the other detector that costs no permission prompt.
   */
  rightClick: {
    enabled: false,
    /**
     * Also suppress the browser's own menu. Opt-in, because silently changing
     * how the host page behaves is not a library's call to make.
     */
    block: false,
    /**
     * Treat a secondary-button `pointerdown` as a right-click too. It fires
     * before `contextmenu` and still fires on pages that swallow the menu.
     */
    detectPointerDown: true,
    /**
     * A `contextmenu` arriving this soon after a reported `pointerdown` is the
     * same gesture, not a second one. Deliberately independent of `throttleMs`.
     */
    dedupeMs: 400,
    /** Minimum gap between two reported right-clicks. 0 disables the cap. */
    throttleMs: 500,
    /** Record tag/id/classes of the element that was right-clicked. */
    captureTarget: true,
  },

  /**
   * Emit `violation` for copy / cut / paste. No permissions needed.
   *
   * Off by default: copying text is ordinary behaviour, and in an exam it may be
   * exactly what the candidate is meant to do. The host decides.
   *
   * What this detector does *not* do is read the clipboard. `textLength` is
   * measured from the event's own `clipboardData`, which the browser has already
   * handed the page; the text itself is never stored, logged or sent. Reading
   * the real clipboard needs a permission prompt and would turn a behavioural
   * signal into content surveillance.
   */
  clipboard: {
    enabled: false,
    /** Which events to report. Any subset of 'copy' | 'cut' | 'paste'. */
    actions: ['copy', 'cut', 'paste'],
    /**
     * Call `preventDefault()`, stopping the clipboard operation outright.
     * Opt-in: silently breaking copy/paste changes how the host page behaves.
     */
    block: false,
    /**
     * Minimum gap between two reports of the *same* action. Guards against
     * editors that fire more than one event per gesture. It is not what keeps
     * copy and paste apart — those are separate actions with separate budgets.
     */
    throttleMs: 250,
    /**
     * Elements to ignore, as CSS selectors. For the host's own UI: a "copy
     * question" button must not be reported as the candidate copying.
     */
    ignoreSelectors: null,
  },

  /**
   * Emit `violation` for keyboard shortcuts — by default the developer-tools and
   * view-source combinations. No permissions needed.
   *
   * Off by default for the same reason as `rightClick`: these keys are ordinary
   * in most pages, and only the host knows whether they are suspicious.
   */
  shortcuts: {
    enabled: false,
    /**
     * Combos to watch, e.g. `['ctrl+shift+i', 'ctrl+p']`. `null` uses the
     * platform's developer-tools list (see `DEVTOOLS_COMBOS`).
     *
     * Syntax: `ctrl`, `shift`, `alt`, `meta`, and `mod` (which resolves to `meta`
     * on macOS and `ctrl` elsewhere), then one key. Matched with `event.code`
     * *or* `event.key`, so a non-Latin layout still works.
     */
    combos: null,
    /**
     * Also call `preventDefault()`, which is the only thing that stops the
     * browser acting on the shortcut. Opt-in, and best-effort: DevTools can still
     * be opened from the browser menu.
     */
    block: false,
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
    /**
     * Capture a still of the preview every N ms and emit `snapshot`.
     *
     * 0 disables it. Off by default for the same reason as
     * `report.captureScreenshots`: continuously photographing a candidate
     * creates a retention obligation, and only the host can accept that.
     */
    snapshotIntervalMs: 0,
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
    /**
     * Report when the spectral score exceeds this. Read only when
     * `detectMultipleVoices` is on.
     *
     * NOT CALIBRATED. Realistic spectra measure 0.01-0.12, so this default of 0.5
     * is unreachable in practice and the violation never fires. Calibrate against
     * your own audio before relying on it.
     */
    voiceThreshold: 0.5,
    /** FFT size for the analyser; higher is more frequency resolution. */
    fftSize: 1024,
    /** Smoothing for the analyser, 0..1. */
    smoothingTimeConstant: 0.8,
    /**
     * Score the spectrum in an attempt to spot several speakers at once.
     *
     * EXPERIMENTAL — it does not count speakers. The score rises with volume
     * alone and is dominated by the room's noise floor, so it cannot separate
     * "several people talking" from "one person in a noisy room". See
     * `computeSpectralDensity` in `detectors/audio.js` for the measurements.
     * Enabling it logs a warning. Off by default.
     */
    detectMultipleVoices: false,
    throttleMs: 3000,
  },

  /**
   * Emit `violation` for third-party screen-sharing / streaming / remote-access
   * software, as far as a web page can see it at all.
   *
   * What this can and cannot do, stated plainly because the name oversells it
   * otherwise:
   *
   *  - It **cannot** see that TeamViewer, AnyDesk, Zoom or Discord are running.
   *    No web API exposes other processes, and nothing about a remote-desktop
   *    session is visible to page script. A detector that claimed otherwise
   *    would be guessing.
   *  - It **can** see the *synthetic capture devices* those tools install —
   *    `OBS Virtual Camera`, `ManyCam`, `VB-Audio Virtual Cable`, … — because
   *    `enumerateDevices()` lists them. That is a real, checkable signal, and
   *    it is the main thing this detector is for.
   *  - It **can** see whether the camera actually in use is one of those
   *    virtual devices, or is a screen capture wearing a camera's label.
   *  - It **can** see a screen share started *by this page*, because
   *    `getDisplayMedia` is observable. A share started from another
   *    application is not.
   *
   * Off by default: it is most useful alongside `camera`, and the device scan
   * only sees anything once camera/microphone permission has been granted (see
   * `detectVirtualDevices`).
   */
  thirdParty: {
    enabled: false,
    /**
     * Scan `enumerateDevices()` for known virtual/loopback devices, and rescan
     * on `devicechange` so plugging OBS in mid-exam is caught.
     *
     * Caveat that matters: browsers blank out `label` until the user has
     * granted access to that kind at least once. With no permission the scan
     * runs but sees nothing, which is why it logs when it comes back empty
     * rather than pretending the machine is clean.
     */
    detectVirtualDevices: true,
    /**
     * Report when the *live* camera is a virtual device, or is a screen capture
     * instead of a camera. Needs `camera.enabled`; reads that detector's track
     * rather than opening a second stream.
     */
    detectActiveCamera: true,
    /** Observe `getDisplayMedia` so a page-initiated screen share is recorded. */
    detectScreenShare: true,
    /** Extra lowercase substrings to treat as third-party, on top of the built-ins. */
    devices: null,
    /** Lowercase substrings that suppress a match — for known-good lab hardware. */
    ignore: null,
    /** Cadence for the device rescan, in ms. 0 disables the timer (event-only). */
    scanIntervalMs: 15000,
    /** Cadence for the active-camera check, in ms. */
    checkIntervalMs: 3000,
    throttleMs: 2000,
  },

  /**
   * Periodic stills of the shared screen, emitted as `snapshot`.
   *
   * Off by default, and it cannot be turned on silently even if it is: a page
   * cannot rasterise its own DOM, so the only zero-dependency route is
   * `getDisplayMedia()`, which the browser only allows from a user gesture and
   * which makes the candidate pick a surface and grant screen sharing. Call
   * `proctor.startPageCapture()` from a click handler; `start()` never does it.
   *
   * Because the surface is the candidate's choice, `displaySurface` is a hint,
   * not a guarantee, and the capture stops the moment they hit "Stop sharing".
   */
  pageCapture: {
    enabled: false,
    /** Capture cadence, in ms. */
    intervalMs: 30000,
    /** Downscale target in pixels. 0 keeps the captured resolution. */
    maxWidth: 640,
    /** JPEG quality, 0..1. */
    quality: 0.6,
    /**
     * Which surface to ask for: 'browser' (a tab), 'window' or 'monitor'.
     * Advisory — the picker is the candidate's, and they may choose otherwise.
     */
    displaySurface: 'browser',
  },

  /** Deliver violations to an HTTP endpoint via fetch. Off by default. */
  backend: {
    enabled: false,
    /**
     * Endpoint URL. When null, built-in uploaders fall back to `#storage`
     * inside the host app; see src/core/store.js.
     */
    endpoint: null,
    /**
     * Separate endpoint for periodic snapshots. A snapshot is far bulkier than
     * a violation and usually belongs in object storage, so sharing one handler
     * for both is rarely what a host wants. Falls back to `endpoint`.
     */
    snapshotEndpoint: null,
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
