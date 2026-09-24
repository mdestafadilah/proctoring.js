import { VIOLATION_TYPES } from '../core/options.js';
import { throttle, describeTarget } from '../core/utils.js';

/**
 * Copy / cut / paste detector.
 *
 * A proctored assessment cares about two directions: question text leaving the
 * page (copy/cut) and outside text arriving in it (paste). Both are visible as
 * plain DOM events, so this costs no permission and no user gesture.
 *
 * Two deliberate limits:
 *
 *  1. **The clipboard is never read.** `navigator.clipboard.readText()` needs a
 *     permission prompt and would turn a behavioural signal into content
 *     surveillance. The length recorded here is measured from the event's own
 *     `clipboardData`, which the browser has already handed the page; the text
 *     itself is discarded on the same line it is measured.
 *  2. **Only this page is observable.** A paste into another application, or a
 *     copy made in a different tab, never reaches these listeners. Silence means
 *     "not here", not "not happening".
 *
 * Off by default: copying text is ordinary behaviour, and in many exams it is
 * exactly what the candidate is supposed to do.
 */
export class ClipboardDetector {
  static name = 'clipboard';
  static requires = [];

  constructor(config, context) {
    this.config = config;
    this.context = context;
    this.counts = { copy: 0, cut: 0, paste: 0 };
    this._destroyed = false;

    /** action -> the listener actually registered on `document`. */
    this._handlers = new Map();
    /** Selectors resolved at init, so an invalid one cannot throw per event. */
    this._ignore = [];

    /**
     * One throttle per action, deliberately not one shared across the detector.
     * A copy and the paste that follows it are two acts, and a single leading
     * budget would let the first swallow the second.
     */
    this._emitters = new Map();
  }

  async init() {
    const actions = this._resolveActions();
    this._ignore = this._resolveIgnoreSelectors();

    for (const action of actions) {
      const handler = (event) => this._onClipboardEvent(action, event);
      /**
       * Capture phase on `document`, matching the right-click detector: a page
       * that calls `stopPropagation()` in the bubble phase would otherwise be
       * able to hide the gesture from proctoring.
       */
      document.addEventListener(action, handler, true);
      this._handlers.set(action, handler);
    }

    this.context.setState('clipboard', {
      active: true,
      status: 'running',
      actions,
      counts: { ...this.counts },
    });
    return true;
  }

  /** Configured actions, with unknown ones reported rather than swallowed. */
  _resolveActions() {
    const configured = Array.isArray(this.config.actions) ? this.config.actions : [];
    const valid = [];

    for (const action of configured) {
      if (Object.prototype.hasOwnProperty.call(ACTION_TYPES, action)) {
        if (!valid.includes(action)) valid.push(action);
      } else {
        // A typo must not take the valid entries down with it, but it must not
        // be silent either — a detector that quietly watches nothing is worse
        // than one that refuses to start.
        this.context.log('warn', `Ignoring unknown clipboard action "${action}"`);
      }
    }

    return valid;
  }

  /** Validate selectors once; `closest()` would otherwise throw per event. */
  _resolveIgnoreSelectors() {
    const configured = Array.isArray(this.config.ignoreSelectors) ? this.config.ignoreSelectors : [];
    const valid = [];

    for (const selector of configured) {
      try {
        document.querySelector(selector);
        valid.push(selector);
      } catch {
        this.context.log('warn', `Ignoring invalid clipboard ignoreSelectors entry "${selector}"`);
      }
    }

    return valid;
  }

  _onClipboardEvent(action, event) {
    if (this._destroyed) return;

    const target = event?.target ?? null;
    if (this._isIgnored(target)) return;

    /**
     * Suppression is not throttled. The right-click detector learned this the
     * hard way: calling `preventDefault()` only for events that survive the
     * throttle lets a second copy inside the window go through silently, which
     * is precisely what `block` was turned on to prevent.
     */
    if (this.config.block && typeof event?.preventDefault === 'function') {
      event.preventDefault();
    }

    this._emitter(action)({ target, event });
  }

  _isIgnored(target) {
    if (this._ignore.length === 0) return false;
    if (!target || typeof target.closest !== 'function') return false;

    return this._ignore.some((selector) => target.closest(selector) !== null);
  }

  _emitter(action) {
    let emit = this._emitters.get(action);

    if (!emit) {
      emit = throttle(
        ({ target, event }) => this._report(action, target, event),
        this.config.throttleMs
      );
      this._emitters.set(action, emit);
    }

    return emit;
  }

  _report(action, target, event) {
    this.counts[action] += 1;

    const details = {
      action,
      target: describeTarget(target),
      /** Length only — see the class comment. */
      textLength: measureClipboardText(event),
      at: new Date().toISOString(),
    };

    this.context.setState('clipboard', {
      active: true,
      status: 'violation',
      counts: { ...this.counts },
    });
    this.context.log('warn', `Clipboard ${action} on ${details.target ?? 'the page'}`);
    this.context.report(ACTION_TYPES[action], details, { detector: 'clipboard' });
  }

  /** Current state, exposed for a status indicator in the host UI. */
  getState() {
    return {
      active: !this._destroyed,
      actions: [...this._handlers.keys()],
      counts: { ...this.counts },
    };
  }

  destroy() {
    for (const [action, handler] of this._handlers) {
      document.removeEventListener(action, handler, true);
    }

    this._handlers.clear();
    this._emitters.clear();
    this._ignore = [];
    this._destroyed = true;
    this.context.setState('clipboard', { active: false, status: 'destroyed' });
  }
}

/** DOM event name -> violation type. */
const ACTION_TYPES = Object.freeze({
  copy: VIOLATION_TYPES.CLIPBOARD_COPY,
  cut: VIOLATION_TYPES.CLIPBOARD_CUT,
  paste: VIOLATION_TYPES.CLIPBOARD_PASTE,
});

/**
 * Length of the text carried by a clipboard event, or null when unavailable.
 *
 * Read from the event's own `clipboardData` — already in this page's memory by
 * virtue of the event having fired — so no permission is involved and the system
 * clipboard is never touched. The string is dropped immediately; only the count
 * survives this function.
 */
function measureClipboardText(event) {
  try {
    const data = event?.clipboardData;
    if (!data || typeof data.getData !== 'function') return null;

    const text = data.getData('text');
    return typeof text === 'string' ? text.length : null;
  } catch {
    // `getData` throws once a paste event's data has already been consumed.
    return null;
  }
}
