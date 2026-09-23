import { EVENTS, VIOLATION_TYPES, DEFAULT_SEVERITY, severityWeight } from './options.js';
import { uid } from './utils.js';
import { dataUrlBytes } from './screenshot.js';

/**
 * Violation store + report builder.
 *
 * Keeps the authoritative session trail. Deliberately separate from the
 * transport layer: the report must stay correct and readable even when the
 * network is unavailable, because it is the artifact an examiner reviews.
 */
export class ViolationStore {
  /**
   * @param {object} options resolved options
   * @param {import('./emitter.js').Emitter} emitter
   */
  constructor(options, emitter) {
    this.options = options;
    this.emitter = emitter;
    this.startedAt = null;
    this.endedAt = null;

    /** @type {Array<object>} */
    this.violations = [];

    /** Counter per violation type, so hosts can render a simple scoreboard. */
    this.counts = Object.create(null);

    /** Live per-detector state, useful for a "current status" indicator. */
    this.detectorStates = Object.create(null);

    /** Running total of in-memory screenshot bytes, against the budget. */
    this.screenshotBytes = 0;
    /** Frames discarded because the budget was exhausted. */
    this.droppedScreenshots = 0;
  }

  markStarted() {
    this.startedAt = Date.now();
    this.endedAt = null;
    this._persist();
  }

  markStopped() {
    this.endedAt = Date.now();
    this._persist();
  }

  /**
   * Record a violation.
   *
   * @param {string} type one of VIOLATION_TYPES
   * @param {object} [details] detector-specific payload (kept JSON-safe)
   * @param {object} [meta]  { detector, severity, timestamp }
   * @returns {object|null} the stored violation, or null if deduplicated
   */
  add(type, details = {}, meta = {}) {
    // A detector should never emit while stopped; guard here so a stray timer
    // cannot corrupt the final report after the session was closed.
    if (this.endedAt) return null;

    const severity = meta.severity || this.options.severity[type] || DEFAULT_SEVERITY[type] || 'medium';

    const violation = {
      id: uid('vio'),
      type,
      severity,
      detector: meta.detector || null,
      timestamp: meta.timestamp || Date.now(),
      elapsedMs: this.startedAt ? (meta.timestamp || Date.now()) - this.startedAt : 0,
      details: sanitize(details),
    };

    this.violations.push(violation);
    this.counts[type] = (this.counts[type] || 0) + 1;

    // Enforce the cap by dropping the oldest entries: recent behaviour matters
    // far more than the first five minutes of a three-hour exam.
    const max = this.options.report.maxViolations;
    if (this.violations.length > max) {
      const dropped = this.violations.splice(0, this.violations.length - max);
      this.droppedCount = (this.droppedCount || 0) + dropped.length;
    }

    this._persist();
    this.emitter.emit(EVENTS.VIOLATION, violation);
    return violation;
  }

  /** Update the live state of a detector (not a violation). */
  setDetectorState(detector, state) {
    this.detectorStates[detector] = { ...state, at: Date.now() };
  }

  /**
   * Attach a captured frame to an existing violation.
   *
   * Kept separate from `add()` because capture needs the video element, which
   * the store has no business knowing about. Returns false when the frame was
   * dropped, so the caller can surface that rather than assume success.
   *
   * @param {object} violation returned by `add()`
   * @param {string|null} dataUrl
   * @returns {boolean}
   */
  attachScreenshot(violation, dataUrl) {
    if (!violation || typeof dataUrl !== 'string' || dataUrl.length === 0) return false;

    const budget = this.options.report.screenshotBudgetBytes;
    const bytes = dataUrlBytes(dataUrl);

    // Over budget: drop the frame but keep the violation. The textual evidence
    // ("camera was muted at 12:03") is what matters most; the image is a bonus.
    if (this.screenshotBytes + bytes > budget) {
      this.droppedScreenshots += 1;
      return false;
    }

    violation.screenshot = dataUrl;
    this.screenshotBytes += bytes;
    this._persist();
    return true;
  }

  getDetectorState(detector) {
    return this.detectorStates[detector] || null;
  }

  /** Violations at or above a severity, used for `backend.minSeverity`. */
  filterBySeverity(minSeverity) {
    if (!minSeverity) return this.violations;
    const min = severityWeight(minSeverity);
    return this.violations.filter((v) => severityWeight(v.severity) >= min);
  }

  /** Build an immutable snapshot of the session. */
  buildReport(extra = {}) {
    const endedAt = this.endedAt || Date.now();
    return {
      sessionId: this.options.sessionId,
      metadata: this.options.metadata,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      endedAt: this.endedAt ? new Date(endedAt).toISOString() : null,
      generatedAt: new Date().toISOString(),
      durationMs: this.startedAt ? endedAt - this.startedAt : 0,
      total: this.violations.length,
      droppedCount: this.droppedCount || 0,
      countsByType: { ...this.counts },
      worstSeverity: this.worstSeverity(),
      violations: this.violations.map((v) => ({ ...v })),
      screenshotBytes: this.screenshotBytes,
      droppedScreenshots: this.droppedScreenshots,
      ...extra,
    };
  }

  worstSeverity() {
    let worst = null;
    for (const v of this.violations) {
      if (worst === null || severityWeight(v.severity) > severityWeight(worst)) {
        worst = v.severity;
      }
    }
    return worst;
  }

  /** A simple 0..100 cleanliness score, handy for dashboards. */
  score() {
    if (this.violations.length === 0) return 100;
    const penalty = this.violations.reduce((sum, v) => {
      const weights = { info: 0, low: 1, medium: 3, high: 6, critical: 12 };
      return sum + (weights[v.severity] ?? 3);
    }, 0);
    return Math.max(0, Math.round(100 - penalty));
  }

  clear() {
    this.violations = [];
    this.counts = Object.create(null);
    this.droppedCount = 0;
    this.detectorStates = Object.create(null);
    this.screenshotBytes = 0;
    this.droppedScreenshots = 0;
    this.startedAt = null;
    this.endedAt = null;
    this._clearPersisted();
  }

  // -- persistence ---------------------------------------------------------
  // Wrapped in try/catch throughout: sessionStorage throws in private mode on
  // some browsers and when the quota is exceeded, and proctoring must not die
  // because of a storage failure.

  _storage() {
    if (!this.options.report.persist) return null;
    try {
      return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
    } catch {
      return null;
    }
  }

  _persist() {
    const storage = this._storage();
    if (!storage) return;
    try {
      const snapshot = {
        startedAt: this.startedAt,
        endedAt: this.endedAt,
        counts: this.counts,
        droppedCount: this.droppedCount || 0,
        detectorStates: this.detectorStates,
        /**
         * Screenshots are stripped before persisting.
         *
         * A single 320px JPEG is ~8KB base64; a few hundred of them would exceed
         * the typical 5MB sessionStorage quota, and `setItem` throws when the
         * quota is hit. Losing the whole report to keep the images would be the
         * wrong trade — the persisted copy exists to survive a reload, and the
         * images are still present in memory for the live session.
         */
        violations: this.violations.slice(-200).map(stripScreenshot),
      };
      storage.setItem(this.options.report.storageKey, JSON.stringify(snapshot));
    } catch {
      // Quota exceeded or storage disabled — the in-memory report still works.
    }
  }

  /** Rehydrate a report that was interrupted by a reload or crash. */
  restore() {
    const storage = this._storage();
    if (!storage) return false;
    try {
      const raw = storage.getItem(this.options.report.storageKey);
      if (!raw) return false;
      const snapshot = JSON.parse(raw);
      if (!snapshot || typeof snapshot !== 'object') return false;

      this.startedAt = snapshot.startedAt ?? null;
      this.endedAt = snapshot.endedAt ?? null;
      this.counts = snapshot.counts || Object.create(null);
      this.droppedCount = snapshot.droppedCount || 0;
      this.detectorStates = snapshot.detectorStates || Object.create(null);
      this.violations = Array.isArray(snapshot.violations) ? snapshot.violations : [];
      return true;
    } catch {
      return false;
    }
  }

  _clearPersisted() {
    const storage = this._storage();
    if (!storage) return;
    try {
      storage.removeItem(this.options.report.storageKey);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Copy a violation without its screenshot, for storage.
 * Returns the original object untouched when there is nothing to strip, so the
 * common path allocates nothing extra.
 */
function stripScreenshot(violation) {
  if (!violation || violation.screenshot === undefined) return violation;
  const { screenshot, ...rest } = violation;
  return rest;
}

/**
 * Make a payload JSON-safe.
 *
 * Detectors may accidentally pass a MediaStream, a DOM node, or an Error. Those
 * would either throw inside JSON.stringify or bloat the report, so anything
 * non-serializable is replaced with a short descriptor.
 */
export function sanitize(value, depth = 0) {
  if (depth > 4) return '[depth-limit]';
  if (value == null) return value;

  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'function') return '[function]';
  if (type === 'bigint') return Number(value);

  if (type === 'object') {
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    if (typeof MediaStream !== 'undefined' && value instanceof MediaStream) {
      return '[MediaStream]';
    }
    if (typeof Node !== 'undefined' && value instanceof Node) {
      return `[${value.nodeName || 'Node'}]`;
    }
    if (Array.isArray(value)) {
      // Keep arrays bounded — a 60-element landmark array is fine, 10k is not.
      return value.slice(0, 64).map((item) => sanitize(item, depth + 1));
    }
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = sanitize(value[key], depth + 1);
    }
    return out;
  }

  return String(value);
}

export { VIOLATION_TYPES };
