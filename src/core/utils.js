/**
 * Small internal helpers shared across detectors.
 *
 * Everything here must stay dependency-free and safe to evaluate in a
 * non-browser environment (SSR/tests), because `proctoring.js` is imported at
 * module scope. Anything touching `window`/`document` must be guarded.
 */

/** True when running in a real browser with DOM + WebRTC APIs available. */
export const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

/** True when the current document is a secure context (required for getUserMedia). */
export function isSecureContext() {
  if (!isBrowser) return false;
  // localhost is treated as secure by browsers, so check the flag directly.
  return window.isSecureContext === true;
}

/**
 * Resolve a dotted path (e.g. "audio.rmsThreshold") against an options object.
 * Used only for log messages, never for control flow.
 */
export function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/**
 * Merge user options over defaults, two levels deep.
 *
 * Deep-merging exactly two levels is deliberate: the options shape is fixed
 * (detector -> provider -> primitive) and a generic recursive merge would let a
 * malformed option silently replace a whole detector config object.
 */
export function mergeOptions(defaults, overrides) {
  const out = { ...defaults };
  if (!overrides) return out;

  for (const key of Object.keys(overrides)) {
    const value = overrides[key];
    if (value === undefined) continue;

    const base = defaults[key];
    if (isPlainObject(base) && isPlainObject(value)) {
      out[key] = { ...base, ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Trailing-edge throttle. Keeps the *first* call immediate (so the user sees
 * instant feedback) and drops calls that arrive within `wait` ms of it.
 *
 * Used for high-frequency detectors — otherwise a loud room would emit
 * thousands of violations per second.
 */
export function throttle(fn, wait) {
  let last = 0;
  return function throttled(...args) {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      return fn.apply(this, args);
    }
    return undefined;
  };
}

/**
 * Run an async check on an interval, guaranteeing that a slow check can never
 * overlap with itself. Returns a stop function.
 */
export function every(intervalMs, task) {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await task();
    } finally {
      running = false;
    }
  };

  const id = setInterval(tick, intervalMs);
  // Kick off immediately so the first sample is not delayed by one interval.
  tick();

  return () => {
    stopped = true;
    clearInterval(id);
  };
}

/** Generate a reasonably unique id without pulling in a dependency. */
export function uid(prefix = 'pjs') {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** Build a structured-clone-safe snapshot of a violating media element. */
export function summarizeError(err) {
  if (err == null) return null;
  if (typeof err === 'string') return { name: 'Error', message: err };
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
  };
}

/** Clamp a number into [min, max]; non-finite input falls back to `fallback`. */
export function clamp(value, min, max, fallback = min) {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, num));
}
