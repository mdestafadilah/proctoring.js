import { VIOLATION_TYPES } from '../core/options.js';
import { throttle } from '../core/utils.js';

/**
 * Tab / window focus detector.
 *
 * Uses the Page Visibility API, which is the only reliable way to know that the
 * user switched tabs — `blur` alone also fires for devtools, native context
 * menus, and clicking browser chrome, so it is treated as a weaker signal.
 *
 * No permissions and no user gesture required, which is why it is the only
 * detector enabled by default.
 */
export class TabsDetector {
  static name = 'tabs';
  static requires = [];

  constructor(config, context) {
    this.config = config;
    this.context = context;
    this.hidden = false;
    this.hiddenSince = 0;
    this.blurred = false;
    this._destroyed = false;

    this._onVisibility = null;
    this._onBlur = null;
    this._onFocus = null;
    this._onPageHide = null;
    this._onPageShow = null;

    this._emitHidden = throttle((details) => {
      this.context.report(VIOLATION_TYPES.TAB_HIDDEN, details, { detector: 'tabs' });
    }, config.throttleMs);

    this._emitBlur = throttle((details) => {
      this.context.report(VIOLATION_TYPES.WINDOW_BLUR, details, { detector: 'tabs' });
    }, config.throttleMs);
  }

  async init() {
    const doc = document;

    this._onVisibility = () => {
      const isHidden = doc.visibilityState === 'hidden';

      if (isHidden && !this.hidden) {
        this.hidden = true;
        this.hiddenSince = Date.now();
        this.context.log('debug', 'Page became hidden');
        return;
      }

      if (!isHidden && this.hidden) {
        this.hidden = false;
        const awayMs = Date.now() - this.hiddenSince;

        // Below the threshold this is normal UI behaviour (opening a native
        // select, switching to a password manager), not a proctoring event.
        if (awayMs >= this.config.minHiddenMs) {
          this._reportAway(VIOLATION_TYPES.TAB_HIDDEN, awayMs);
        }
        this.hiddenSince = 0;
      }
    };

    if (this.config.trackWindowBlur) {
      this._onBlur = () => {
        // When the tab is hidden the visibility handler already owns reporting;
        // emitting both would double-count a single alt-tab.
        if (document.visibilityState === 'hidden') return;
        if (this.blurred) return;
        this.blurred = true;
        this._blurredSince = Date.now();
      };

      this._onFocus = () => {
        if (!this.blurred) return;
        this.blurred = false;
        const awayMs = Date.now() - this._blurredSince;

        if (this.hidden) {
          // Focus returned together with visibility; the visibility handler wins.
          return;
        }
        if (awayMs >= this.config.minHiddenMs) {
          this._reportAway(VIOLATION_TYPES.WINDOW_BLUR, awayMs);
        }
        this._blurredSince = 0;
      };

      window.addEventListener('blur', this._onBlur);
      window.addEventListener('focus', this._onFocus);
    }

    doc.addEventListener('visibilitychange', this._onVisibility);

    /**
     * `pagehide` is the last reliable moment before the document goes away. It
     * fires for a close, a reload and a navigation alike, and no API separates
     * the three — so `tab-closed` means "the page went away", not specifically
     * "the tab was closed". Best-effort by nature: `beforeunload` may not run at
     * all, and the report may still be dropped on the way out.
     */
    this._onPageHide = (event) => {
      /**
       * `persisted` means the page is entering the back/forward cache rather
       * than going away. It is kept alive and will be resumed, so nothing has
       * been abandoned and reporting here would be a false positive.
       */
      if (event?.persisted) return;

      // Read before mutating: closing while still looking at the page and
      // closing after switching away are different events to a proctor.
      const wasVisible = !this.hidden;

      if (wasVisible) {
        this.hidden = true;
        this.hiddenSince = Date.now();
      }

      if (!this.config.reportOnClose) return;

      this.context.setState('tabs', { active: true, status: 'closed', hidden: true });
      this.context.log('warn', 'Page is going away (tab closed, reloaded or navigated)');
      this.context.report(
        VIOLATION_TYPES.TAB_CLOSED,
        { at: new Date().toISOString(), wasVisible },
        /**
         * `terminal` routes this past the queue and straight to `sendBeacon`.
         * The transport's own `pagehide` flush has already run by now, and the
         * `fetch` a queued send would start is cancelled with the document.
         */
        { detector: 'tabs', terminal: true }
      );
    };
    window.addEventListener('pagehide', this._onPageHide);

    this.context.setState('tabs', { active: true, status: 'running', hidden: false });
    return true;
  }

  _reportAway(type, awayMs) {
    const details = { awayMs, at: new Date().toISOString() };

    if (type === VIOLATION_TYPES.TAB_HIDDEN) {
      this.context.setState('tabs', { active: true, status: 'violation', hidden: false });
      this.context.log('warn', `Tab was hidden for ${awayMs}ms`);
      this._emitHidden(details);
    } else {
      this.context.log('warn', `Window lost focus for ${awayMs}ms`);
      this._emitBlur(details);
    }
  }

  /** Current state, exposed for a status indicator in the host UI. */
  getState() {
    return {
      active: !this._destroyed,
      hidden: this.hidden,
      blurred: this.blurred,
      hiddenForMs: this.hidden ? Date.now() - this.hiddenSince : 0,
    };
  }

  destroy() {
    if (this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._onBlur) window.removeEventListener('blur', this._onBlur);
    if (this._onFocus) window.removeEventListener('focus', this._onFocus);
    if (this._onPageHide) window.removeEventListener('pagehide', this._onPageHide);

    this._onVisibility = null;
    this._onBlur = null;
    this._onFocus = null;
    this._onPageHide = null;
    this._destroyed = true;
    this.context.setState('tabs', { active: false, status: 'destroyed' });
  }
}
