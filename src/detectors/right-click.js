import { VIOLATION_TYPES } from '../core/options.js';
import { throttle, describeTarget } from '../core/utils.js';

/**
 * Right-click / context-menu detector.
 *
 * Two signals feed one violation:
 *
 *  - `contextmenu` on `document`, in the **capture** phase. This is the
 *    canonical signal: it covers a mouse right-click, the keyboard Menu key,
 *    Shift+F10, and a long-press on Android. The capture phase matters — a host
 *    page that calls `stopPropagation()` in a bubble-phase listener would
 *    otherwise hide the event from a detector that listens on `document` in the
 *    bubble phase, and a proctoring signal must not be that easy to silence.
 *  - A secondary-button `pointerdown`. It fires *before* `contextmenu` and still
 *    fires when the page swallows the menu. Optional, on by default.
 *
 * One gesture must produce one violation, so the `contextmenu` that follows a
 * reported `pointerdown` is suppressed within `dedupeMs`. A separate leading-edge
 * `throttleMs` caps how often a right-click spammer can write to the report —
 * kept separate so that setting `throttleMs: 0` disables rate limiting without
 * also disabling deduplication.
 *
 * Note on scope: this observes the *page*, not the machine. A candidate who
 * right-clicks outside the document (desktop, another app) produces nothing
 * here; that is what `tabs`/`camera` are for.
 */
export class RightClickDetector {
  static name = 'rightClick';
  static requires = [];

  constructor(config, context) {
    this.config = config;
    this.context = context;

    this.count = 0;
    this.lastAt = 0;
    this.blockedCount = 0;
    this._lastPointerDownAt = 0;
    this._destroyed = false;

    this._onContextMenu = null;
    this._onPointerDown = null;

    /**
     * Leading-edge on purpose: the first signal of a gesture reports
     * immediately and the duplicate is dropped. A trailing-edge throttle would
     * delay the violation and attribute it to the wrong moment in the timeline.
     */
    this._emit = throttle((details) => this._report(details), config.throttleMs);
  }

  async init() {
    this._onContextMenu = (event) => this._handleContextMenu(event);
    document.addEventListener('contextmenu', this._onContextMenu, true);

    if (this.config.detectPointerDown) {
      this._onPointerDown = (event) => this._handlePointerDown(event);
      document.addEventListener('pointerdown', this._onPointerDown, true);
    }

    this.context.setState('rightClick', { active: true, status: 'running', count: 0 });
    return true;
  }

  /**
   * `block` is applied to *every* contextmenu event, including ones whose report
   * is dropped. Otherwise a second right-click inside the throttle window would
   * silently open the menu.
   */
  _handleContextMenu(event) {
    if (this.config.block) {
      this.blockedCount += 1;
      event?.preventDefault?.();
    }

    /**
     * The pointerdown of this same gesture has already reported it.
     *
     * Deduplicated structurally rather than through `throttleMs`, because those
     * are two different rules: "one gesture is one violation" must still hold
     * when the host sets `throttleMs: 0` to opt out of rate limiting. Relying on
     * the throttle here produced two violations per click for exactly that
     * configuration.
     */
    if (this._lastPointerDownAt && Date.now() - this._lastPointerDownAt <= this.config.dedupeMs) {
      // Consume the window so a later keyboard Menu key is not swallowed by a
      // stale pointerdown.
      this._lastPointerDownAt = 0;
      return;
    }

    this._emit(this._describe(event, 'contextmenu'));
  }

  _handlePointerDown(event) {
    // `button` is 2 for the secondary (right) mouse button. A touch or pen
    // long-press surfaces through `contextmenu` instead, so it is not lost.
    if (event?.button !== 2) return;

    this._lastPointerDownAt = Date.now();
    this._emit(this._describe(event, 'pointerdown'));
  }

  _describe(event, source) {
    return {
      source,
      /**
       * Whether the menu was suppressed for this gesture. For a pointerdown the
       * suppression happens microseconds later on the matching contextmenu, so
       * the configuration is the honest answer for both sources.
       */
      blocked: this.config.block === true,
      x: typeof event?.clientX === 'number' ? Math.round(event.clientX) : null,
      y: typeof event?.clientY === 'number' ? Math.round(event.clientY) : null,
      target: this.config.captureTarget ? describeTarget(event?.target) : null,
      at: new Date().toISOString(),
    };
  }

  _report(details) {
    this.count += 1;
    this.lastAt = Date.now();

    this.context.setState('rightClick', {
      active: true,
      status: 'violation',
      count: this.count,
      lastAt: new Date(this.lastAt).toISOString(),
    });
    this.context.log('warn', `Right-click detected on ${details.target ?? 'the page'}`);
    this.context.report(VIOLATION_TYPES.RIGHT_CLICK, details, { detector: 'rightClick' });
  }

  /** Current state, exposed for a status indicator in the host UI. */
  getState() {
    return {
      active: !this._destroyed,
      count: this.count,
      lastAt: this.lastAt,
      blockedCount: this.blockedCount,
    };
  }

  destroy() {
    if (this._onContextMenu) {
      document.removeEventListener('contextmenu', this._onContextMenu, true);
    }
    if (this._onPointerDown) {
      document.removeEventListener('pointerdown', this._onPointerDown, true);
    }

    this._onContextMenu = null;
    this._onPointerDown = null;
    this._destroyed = true;
    this.context.setState('rightClick', { active: false, status: 'destroyed' });
  }
}
