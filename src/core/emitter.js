/**
 * Minimal event emitter.
 *
 * Why not Node's `events`? This package ships to browsers via UMD/CDN, where
 * `require('events')` does not exist. A ~40 line emitter keeps the bundle
 * dependency-free and lets us guarantee that a throwing listener cannot break
 * the proctoring session.
 */
export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @returns {() => void} unsubscribe function
   */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`proctoring.js: listener for "${event}" must be a function`);
    }
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /** Subscribe for a single emission. */
  once(event, handler) {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      handler(payload);
    });
    return unsubscribe;
  }

  off(event, handler) {
    const set = this._listeners.get(event);
    if (!set) return;
    if (handler) set.delete(handler);
    else set.clear();
    if (set.size === 0) this._listeners.delete(event);
  }

  /**
   * Emit to all listeners.
   *
   * Listener exceptions are caught and reported instead of propagating: a bug
   * in the host application's `onViolation` handler must never stop camera or
   * audio monitoring mid-exam.
   */
  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;

    // Copy first: a listener may unsubscribe during iteration.
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        this._reportListenerError(event, err);
      }
    }
  }

  _reportListenerError(event, err) {
    const onLog = this._logHandler;
    if (typeof onLog === 'function') {
      onLog('error', `Listener for "${event}" threw`, { error: err });
      return;
    }
    // Last resort so the failure is not swallowed silently.
    if (typeof console !== 'undefined') {
      console.error(`[proctoring.js] listener for "${event}" threw:`, err);
    }
  }

  removeAllListeners() {
    this._listeners.clear();
  }

  listenerCount(event) {
    return this._listeners.get(event)?.size ?? 0;
  }
}
