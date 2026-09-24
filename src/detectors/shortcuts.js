import { VIOLATION_TYPES } from '../core/options.js';

/**
 * Keyboard-shortcut detector.
 *
 * Ships with the "developer tools / view source" shortcuts, which is the usual
 * way a candidate tries to inspect or edit an exam page:
 *
 *   Windows / Linux   Ctrl+Shift+I  Ctrl+Shift+J  Ctrl+Shift+K  Ctrl+Shift+C
 *                     Ctrl+U  F12
 *   macOS             Cmd+Opt+I  Cmd+Opt+J  Cmd+Opt+K  Cmd+Shift+C  Cmd+U  F12
 *
 * `combos` is a plain list of strings, so the same detector covers copy/paste,
 * print, or a host's own bindings without new code.
 *
 * Two deliberate choices:
 *
 *  - `keydown`, not `keyup`. Only `keydown` is cancellable, and cancelling is the
 *    only thing that stops the browser from acting on the shortcut.
 *  - `document`, capture phase. A page that calls `stopPropagation()` in a
 *    bubble-phase listener must not be able to hide the keystroke.
 *
 * Honest scope: this sees a *keystroke*, not the tool. DevTools opened from the
 * menu, with the mouse, or from another window produces nothing here, and once
 * DevTools has focus the page stops receiving keydown entirely. It is a signal
 * for human review, not prevention.
 */
export class ShortcutsDetector {
  static name = 'shortcuts';
  static requires = [];

  constructor(config, context) {
    this.config = config;
    this.context = context;

    this.count = 0;
    this.lastCombo = null;
    this._destroyed = false;
    this._onKeyDown = null;
    this._combos = [];
  }

  async init() {
    this._prepareCombos(detectPlatform());

    this._onKeyDown = (event) => this._handleKeyDown(event);
    document.addEventListener('keydown', this._onKeyDown, true);

    this.context.setState('shortcuts', {
      active: true,
      status: 'running',
      count: 0,
      combos: this._combos.map((c) => c.raw),
    });
    return true;
  }

  /**
   * Parse the configured combos into matchers.
   *
   * An unparseable combo is a typo in the host's config. It is skipped with a
   * warning rather than thrown, so one bad entry does not disable the good ones —
   * but it is never silent, because a combo that can never match is the worst
   * kind of bug to debug.
   */
  _prepareCombos(platform) {
    const configured = this.config.combos ?? DEVTOOLS_COMBOS[platform];

    this._combos = [];
    for (const raw of configured) {
      const combo = parseCombo(raw, platform);
      if (!combo) {
        this.context.log('warn', `Ignoring unparseable shortcut combo "${raw}"`, { raw });
        continue;
      }
      this._combos.push(combo);
    }
    return this._combos;
  }

  /** Public so a host can drive it with a synthetic event; also the test seam. */
  _handleKeyDown(event) {
    /**
     * Holding the key fires a stream of repeats; one press must be one
     * violation. `isComposing` means an IME is mid-composition, so the keydown
     * is part of typing rather than a shortcut.
     */
    if (event?.repeat || event?.isComposing) return;

    const combo = this._match(event);
    if (!combo) return;

    if (this.config.block) {
      // Only on a match — never swallow keystrokes the host did not ask about.
      event.preventDefault?.();
    }

    this._report(combo, event);
  }

  _match(event) {
    const candidates = keyCandidates(event);
    const ctrl = event?.ctrlKey === true;
    const shift = event?.shiftKey === true;
    const alt = event?.altKey === true;
    const meta = event?.metaKey === true;

    for (const combo of this._combos) {
      // Exact modifier equality on purpose. A subset check would fire on
      // Ctrl+Shift+Alt+I for a `ctrl+shift+i` rule, and AltGr (which sets both
      // ctrlKey and altKey on Windows) would trip every `ctrl+...` rule.
      if (
        combo.ctrl !== ctrl ||
        combo.shift !== shift ||
        combo.alt !== alt ||
        combo.meta !== meta
      ) {
        continue;
      }
      if (candidates.has(combo.key)) return combo;
    }
    return null;
  }

  _report(combo, event) {
    this.count += 1;
    this.lastCombo = combo.raw;

    const details = {
      combo: combo.raw,
      /** 'devtools', 'view-source'... null for a combo the library does not know. */
      label: SHORTCUT_LABELS[combo.raw] ?? null,
      blocked: this.config.block === true,
      /** Raw evidence, so a report can be audited rather than trusted. */
      key: typeof event?.key === 'string' ? event.key : null,
      code: typeof event?.code === 'string' ? event.code : null,
      at: new Date().toISOString(),
    };

    this.context.setState('shortcuts', {
      active: true,
      status: 'violation',
      count: this.count,
      lastCombo: combo.raw,
    });
    this.context.log('warn', `Shortcut "${combo.raw}" pressed${details.label ? ` (${details.label})` : ''}`);
    this.context.report(VIOLATION_TYPES.SHORTCUT_USED, details, { detector: 'shortcuts' });
  }

  /** Current state, exposed for a status indicator in the host UI. */
  getState() {
    return {
      active: !this._destroyed,
      count: this.count,
      lastCombo: this.lastCombo,
      combos: this._combos.map((c) => c.raw),
    };
  }

  destroy() {
    if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown, true);
    this._onKeyDown = null;
    this._destroyed = true;
    this.context.setState('shortcuts', { active: false, status: 'destroyed' });
  }
}

/**
 * Platform defaults.
 *
 * Two separate lists rather than one `mod+alt+i` style rule, because AltGr on
 * Windows sets both `ctrlKey` and `altKey`: a portable `ctrl+alt+i` entry would
 * fire every time a German or Polish candidate types an "i" that needs AltGr.
 */
export const DEVTOOLS_COMBOS = Object.freeze({
  mac: Object.freeze(['meta+alt+i', 'meta+alt+j', 'meta+alt+k', 'meta+shift+c', 'meta+u', 'f12']),
  other: Object.freeze(['ctrl+shift+i', 'ctrl+shift+j', 'ctrl+shift+k', 'ctrl+shift+c', 'ctrl+u', 'f12']),
});

/** Human labels for the combos the library ships with. */
const SHORTCUT_LABELS = Object.freeze({
  'ctrl+shift+i': 'devtools',
  'meta+alt+i': 'devtools',
  f12: 'devtools',
  'ctrl+shift+j': 'devtools-console',
  'meta+alt+j': 'devtools-console',
  'ctrl+shift+k': 'devtools-console',
  'meta+alt+k': 'devtools-console',
  'ctrl+shift+c': 'inspect-element',
  'meta+alt+c': 'inspect-element',
  'meta+shift+c': 'inspect-element',
  'ctrl+u': 'view-source',
  'meta+u': 'view-source',
});

const MODIFIER_ALIASES = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
};

/** Which of the two default lists applies here. */
export function detectPlatform() {
  if (typeof navigator === 'undefined') return 'other';
  const uaData = navigator.userAgentData;
  const platform = (uaData && uaData.platform) || navigator.platform || '';
  if (/mac|iphone|ipad|ipod/i.test(platform)) return 'mac';
  // `navigator.platform` is deprecated and can be empty in some engines.
  if (/mac os x|iphone|ipad/i.test(navigator.userAgent || '')) return 'mac';
  return 'other';
}

/**
 * Parse `'ctrl+shift+i'` into a matcher.
 *
 * `mod` resolves to `meta` on macOS and `ctrl` elsewhere, which is the
 * convention every editor uses. Returns null when the string cannot be a
 * shortcut, so the caller can warn instead of matching nothing forever.
 */
export function parseCombo(raw, platform = 'other') {
  if (typeof raw !== 'string') return null;

  const tokens = raw
    .toLowerCase()
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;

  // A lone key is legitimate — F12 is a developer-tools shortcut with no
  // modifiers — so the last token is validated as a key rather than requiring a
  // minimum length. A modifier-only string fails here too: "shift" is not a key.
  const keyToken = tokens.pop();
  if (!/^([a-z0-9]|f[1-9]|f1[0-2]|escape|esc|space|tab|enter|backspace|delete|insert|home|end|pageup|pagedown|arrowup|arrowdown|arrowleft|arrowright)$/.test(keyToken)) {
    return null;
  }

  const combo = { ctrl: false, shift: false, alt: false, meta: false, key: normalizeKeyName(keyToken), raw: '' };

  for (const token of tokens) {
    const modifier = token === 'mod' ? (platform === 'mac' ? 'meta' : 'ctrl') : MODIFIER_ALIASES[token];
    // An unknown modifier means a typo, and silently ignoring it would turn
    // `ctrl+shit+i` into a rule that fires on every Ctrl+I.
    if (!modifier) return null;
    combo[modifier] = true;
  }

  combo.raw = canonicalCombo(combo);
  return combo;
}

/** 'esc' -> 'escape', 'F12' -> 'f12'; anything else is already canonical. */
function normalizeKeyName(token) {
  if (token === 'esc') return 'escape';
  return token;
}

function canonicalCombo(combo) {
  const parts = [];
  if (combo.ctrl) parts.push('ctrl');
  if (combo.alt) parts.push('alt');
  if (combo.shift) parts.push('shift');
  if (combo.meta) parts.push('meta');
  parts.push(combo.key);
  return parts.join('+');
}

/**
 * Every key name this event could represent.
 *
 * Matching on `event.code` alone would miss layouts where the physical key is
 * not the one that prints the letter; matching on `event.key` alone would break
 * on any non-Latin layout, and it is uppercased when Shift is held — which is
 * exactly the Ctrl+Shift+I case. Accepting both is the only reliable option.
 */
function keyCandidates(event) {
  const out = new Set();

  const code = typeof event?.code === 'string' ? event.code : '';
  if (/^Key[A-Z]$/.test(code)) out.add(code.slice(3).toLowerCase());
  else if (/^Digit[0-9]$/.test(code)) out.add(code.slice(5));
  else if (code) out.add(code.toLowerCase());

  const key = typeof event?.key === 'string' ? event.key : '';
  if (key) out.add(key.toLowerCase());

  return out;
}
