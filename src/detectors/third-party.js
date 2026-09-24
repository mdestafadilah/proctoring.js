import { VIOLATION_TYPES } from '../core/options.js';
import { throttle, every } from '../core/utils.js';

/**
 * Software known to install a *synthetic* capture device — a virtual camera, a
 * loopback audio cable, or a screen-capture "camera".
 *
 * Matching is a case-insensitive substring test against the device label, which
 * is what `enumerateDevices()` and `MediaStreamTrack.label` expose. Substring
 * rather than equality because vendors decorate labels freely: the same product
 * arrives as "OBS Virtual Camera", "OBS Virtual Camera (OBS 30)" and
 * "obs-camera" depending on driver and version.
 *
 * This list is about *devices*, not brands. VLC being installed is not a
 * proctoring signal; VLC registering a capture device would be. Extend it with
 * `thirdParty.devices`, silence a false positive with `thirdParty.ignore`.
 */
export const KNOWN_THIRD_PARTY_DEVICES = Object.freeze([
  // Virtual cameras — the standard way to feed a pre-recorded video, or a
  // second person, into a proctored call.
  'obs virtual camera',
  'obs-camera',
  'obsproject',
  'streamlabs',
  'manycam',
  'xsplit vcam',
  'xsplit broadcaster',
  'snap camera',
  'droidcam',
  'iriun',
  'epoccam',
  'ndi webcam',
  'ndi video',
  'e2esoft',
  'splitcam',
  'camtwist',
  'unitycapture',
  'cyberlink',
  'logi capture',
  'logitech capture',
  'mmhmm',
  'vcam',
  'virtual camera',
  'virtual webcam',
  // Virtual / loopback audio — piping in a second speaker, a text-to-speech
  // reader, or a pre-recorded answer. Ordered most-specific first, because the
  // first pattern that matches is the one reported: "CABLE Output (VB-Audio
  // Virtual Cable)" should be attributed to the device, not the vendor.
  'cable input',
  'cable output',
  'voicemeeter',
  'virtual audio cable',
  'vb-audio',
  'vb audio',
  'blackhole',
  'soundflower',
  'loopback audio',
  'sound siphon',
  'virtual audio',
  // Screen-capture devices that present themselves as cameras.
  'screen capture recorder',
  'uscreen capture',
  'screen-capture-recorder',
]);

/** Readable names for the `MediaDeviceInfo.kind` values worth reporting. */
const DEVICE_KINDS = Object.freeze({
  videoinput: 'camera',
  audioinput: 'microphone',
  audiooutput: 'speaker',
});

/** Human-readable log lines, one per violation type. */
const MESSAGES = Object.freeze({
  [VIOLATION_TYPES.THIRD_PARTY_DEVICE]: (d) => `Third-party ${d.kind} device present: ${d.device}`,
  [VIOLATION_TYPES.VIRTUAL_CAMERA_ACTIVE]: (d) => `The active camera is a virtual device: ${d.device}`,
  [VIOLATION_TYPES.SCREEN_SHARE_STARTED]: (d) =>
    d.source === 'camera-track'
      ? 'The "camera" feed is a screen capture, not a camera'
      : 'A screen share was started from this page',
});

/**
 * Third-party capture software detector.
 *
 * Scope, stated honestly because the name oversells it otherwise. A web page
 * **cannot** see that TeamViewer, AnyDesk, Zoom or Discord are running: no API
 * exposes other processes, and nothing about a remote-desktop session is
 * visible to page script. What *is* visible, and what this class reports:
 *
 *  1. `enumerateDevices()` lists the synthetic devices those stacks install.
 *     This is the main signal, and it is a real observation, not a guess.
 *  2. The live camera track, which can be identified as a virtual device — or
 *     as a screen capture wearing a camera's label (`displaySurface`).
 *  3. `getDisplayMedia` calls made by this page. A share started elsewhere is
 *     invisible; the page only ever sees its own.
 *
 * The three are independent and each can be switched off. Nothing here opens a
 * stream, prompts for permission, or uploads anything.
 */
export class ThirdPartyDetector {
  static name = 'thirdParty';
  static requires = [];

  constructor(config, context) {
    this.config = config;
    this.context = context;

    this.count = 0;
    this.lastAt = 0;
    /** Every third-party device matched so far, for the host's own UI. */
    this.devices = [];
    /** Details of the last observed screen share, or null. */
    this.screenShare = null;

    this._seen = new Set();
    this._activeCameraPattern = null;
    this._destroyed = false;

    this._scanTimer = null;
    this._stopCameraWatch = null;
    this._onDeviceChange = null;
    this._originalGetDisplayMedia = null;
    this._patched = false;
    this._loggedBlindScan = false;

    /**
     * One throttle per violation type, deliberately not one shared across the
     * detector. A single leading-edge throttle would let a device match consume
     * the budget and silently swallow a screen-share event microseconds later —
     * two unrelated signals competing for one window.
     */
    this._emitters = new Map();

    this._patterns = { extra: config.devices, ignore: config.ignore };
  }

  async init() {
    if (this.config.detectVirtualDevices) {
      this._onDeviceChange = () => {
        this.scan();
      };
      // `devicechange` is the cheap trigger; the timer below is the backstop for
      // browsers that fire it unreliably.
      mediaDevices()?.addEventListener?.('devicechange', this._onDeviceChange);

      await this.scan();

      if (this.config.scanIntervalMs > 0) {
        this._scanTimer = setInterval(() => this.scan(), this.config.scanIntervalMs);
      }
    }

    if (this.config.detectActiveCamera) {
      // `every` guarantees a slow `getSettings()` can never overlap itself.
      this._stopCameraWatch = every(this.config.checkIntervalMs, () => this._checkActiveCamera());
    }

    if (this.config.detectScreenShare) {
      this._observeGetDisplayMedia();
    }

    this.context.setState('thirdParty', {
      active: true,
      status: 'running',
      devices: this.devices.length,
      screenShare: false,
    });
    return true;
  }

  /**
   * Re-read the device list and report third-party devices not seen before.
   *
   * Public so a host can force a rescan the moment the user grants permission —
   * which is precisely when labels first become readable.
   *
   * @returns {Promise<Array<{ label: string, kind: string, pattern: string }>>}
   *   only the entries newly reported by this call
   */
  async scan() {
    if (this._destroyed) return [];

    const media = mediaDevices();
    if (!media?.enumerateDevices) {
      this.context.log('debug', 'enumerateDevices is unavailable; device scan skipped');
      return [];
    }

    let list;
    try {
      list = await media.enumerateDevices();
    } catch (err) {
      this.context.log('warn', 'Device scan failed', { error: err });
      return [];
    }

    /**
     * An all-blank label list means "cannot see", not "nothing there". Browsers
     * blank `label` until the user has granted access to that kind at least
     * once, so reporting a clean machine here would be a lie the host then acts
     * on. Say it once instead of failing silently.
     */
    if (!list.some((device) => device.label)) {
      if (!this._loggedBlindScan) {
        this._loggedBlindScan = true;
        this.context.log(
          'debug',
          'Device labels stay hidden until camera/microphone permission is granted — ' +
            'the third-party device scan sees nothing until then'
        );
      }
      return [];
    }

    const found = [];
    for (const device of list) {
      const match = matchThirdPartyDevice(device.label, this._patterns);
      if (!match) continue;

      const kind = DEVICE_KINDS[device.kind] || 'unknown';
      const key = `${kind}:${match.pattern}`;
      // One device is one violation. Without this the periodic rescan would
      // re-report the same OBS camera every 15 seconds for the whole exam.
      if (this._seen.has(key)) continue;
      this._seen.add(key);

      const entry = { label: device.label, kind, pattern: match.pattern };
      found.push(entry);
      this.devices.push(entry);

      /**
       * `deviceId` is deliberately not included. It is a stable per-origin
       * identifier that adds nothing to the evidence — the label already says
       * which device — and the report is not the place to accumulate extra
       * fingerprinting material.
       */
      this._emit(VIOLATION_TYPES.THIRD_PARTY_DEVICE, {
        device: device.label,
        kind,
        matched: match.pattern,
      });
    }

    return found;
  }

  /**
   * Is the camera actually in use one of those virtual devices?
   *
   * Reads the camera detector's own track instead of opening a second stream,
   * so this never costs a second permission prompt. Does nothing when
   * `camera.enabled` is false — there is no track to inspect.
   */
  _checkActiveCamera() {
    if (this._destroyed) return;

    const camera = this.context.getDetector?.('camera');
    const track = camera?.getStream?.()?.getVideoTracks?.()[0] ?? null;

    if (!track || track.readyState !== 'live') {
      this._activeCameraPattern = null;
      return;
    }

    const settings = safeSettings(track);

    /**
     * `displaySurface` is set only on tracks produced by `getDisplayMedia`. A
     * track handed to us as the webcam that carries one is a screen capture
     * being passed off as a camera — the most conclusive signal this detector
     * can produce, and the closest thing to "screen sharing" that is visible
     * from inside a page at all.
     */
    if (settings.displaySurface) {
      this._activeCameraPattern = null;
      this._emit(VIOLATION_TYPES.SCREEN_SHARE_STARTED, {
        source: 'camera-track',
        displaySurface: settings.displaySurface,
        label: track.label || null,
      });
      return;
    }

    const match = matchThirdPartyDevice(track.label, this._patterns);

    /**
     * Reported on *change*, not on every tick: "the camera is virtual" is a
     * state, and repeating it every `checkIntervalMs` would bury the timeline.
     * Clearing the marker on a real camera means switching back and forth
     * reports again, which is what a supervisor needs to see.
     */
    if (!match) {
      this._activeCameraPattern = null;
      return;
    }
    if (this._activeCameraPattern === match.pattern) return;

    this._activeCameraPattern = match.pattern;
    this._emit(VIOLATION_TYPES.VIRTUAL_CAMERA_ACTIVE, {
      device: track.label,
      matched: match.pattern,
    });
  }

  /**
   * Wrap `getDisplayMedia` so a share started from this page is recorded.
   *
   * Only the page's own call passes through here — a share started in Zoom or
   * from the OS is not observable, and this method does not pretend otherwise.
   * The original is restored in `destroy()`: a proctoring library that left a
   * permanent wrapper on a standard API would be indistinguishable from the
   * hijacking it exists to detect.
   */
  _observeGetDisplayMedia() {
    const media = mediaDevices();
    if (!media || typeof media.getDisplayMedia !== 'function') {
      this.context.log('debug', 'getDisplayMedia is unavailable; screen-share observation skipped');
      return;
    }

    const original = media.getDisplayMedia;
    this._originalGetDisplayMedia = original;

    const detector = this;
    function observed(...args) {
      // `apply` preserves the native `this`, and evaluating the call before
      // chaining `.then` means a synchronous TypeError still surfaces the way a
      // caller expects instead of turning into a rejected promise.
      return original.apply(this, args).then((stream) => {
        const track = stream?.getVideoTracks?.()[0] ?? null;
        const settings = safeSettings(track);
        detector._emit(VIOLATION_TYPES.SCREEN_SHARE_STARTED, {
          source: 'getDisplayMedia',
          displaySurface: settings.displaySurface ?? null,
          label: track?.label || null,
        });
        return stream;
      });
    }

    try {
      media.getDisplayMedia = observed;
    } catch (err) {
      this.context.log('warn', 'Could not observe getDisplayMedia', { error: err });
      this._originalGetDisplayMedia = null;
      return;
    }

    /**
     * Verify the patch actually landed. Some embeddings freeze the media
     * prototype; if it did not take, say so rather than leaving the host
     * believing screen shares are being watched.
     */
    this._patched = media.getDisplayMedia === observed;
    if (!this._patched) {
      this._originalGetDisplayMedia = null;
      this.context.log('warn', 'getDisplayMedia could not be wrapped; screen shares will not be observed');
    }
  }

  /** Current state, exposed for a status indicator in the host UI. */
  getState() {
    return {
      active: !this._destroyed,
      count: this.count,
      lastAt: this.lastAt,
      devices: this.devices.map((entry) => entry.label),
      screenShare: this.screenShare,
    };
  }

  destroy() {
    if (this._scanTimer) clearInterval(this._scanTimer);
    this._scanTimer = null;

    if (this._stopCameraWatch) this._stopCameraWatch();
    this._stopCameraWatch = null;

    if (this._onDeviceChange) {
      mediaDevices()?.removeEventListener?.('devicechange', this._onDeviceChange);
      this._onDeviceChange = null;
    }

    if (this._patched && this._originalGetDisplayMedia) {
      try {
        mediaDevices().getDisplayMedia = this._originalGetDisplayMedia;
      } catch (err) {
        this.context.log('warn', 'Could not restore getDisplayMedia', { error: err });
      }
    }
    this._patched = false;
    this._originalGetDisplayMedia = null;

    this._emitters.clear();
    this._destroyed = true;
    this.context.setState('thirdParty', { active: false, status: 'destroyed' });
  }

  /** Leading-edge throttle, resolved per violation type on first use. */
  _emit(type, details) {
    let emit = this._emitters.get(type);
    if (!emit) {
      emit = throttle((payload) => this._report(type, payload), this.config.throttleMs);
      this._emitters.set(type, emit);
    }
    emit(details);
  }

  _report(type, details) {
    this.count += 1;
    this.lastAt = Date.now();
    if (type === VIOLATION_TYPES.SCREEN_SHARE_STARTED) this.screenShare = details;

    this.context.setState('thirdParty', {
      active: true,
      status: 'violation',
      count: this.count,
      lastAt: new Date(this.lastAt).toISOString(),
      devices: this.devices.length,
      screenShare: Boolean(this.screenShare),
    });
    this.context.log('warn', MESSAGES[type]?.(details) ?? `Third-party signal: ${type}`);
    this.context.report(type, details, { detector: 'thirdParty' });
  }
}

/**
 * Does a device label belong to a known third-party capture tool?
 *
 * A free function rather than a method so it is testable in Node with no DOM,
 * and so a host can reuse it against its own device inventory.
 *
 * @param {string} label device label, as reported by the browser
 * @param {object} [options]
 * @param {string[]} [options.extra] additional substrings to match
 * @param {string[]} [options.ignore] substrings that suppress any match
 * @returns {{ pattern: string, label: string }|null} the pattern that matched
 */
export function matchThirdPartyDevice(label, options = {}) {
  if (typeof label !== 'string') return null;
  const haystack = label.trim().toLowerCase();
  if (!haystack) return null;

  const extra = Array.isArray(options.extra) ? options.extra : [];
  const ignore = Array.isArray(options.ignore) ? options.ignore : [];

  /**
   * An ignore entry beats every match and is checked first. The built-in list is
   * heuristic, so a host that owns its lab hardware must be able to silence a
   * false positive without forking the library — that escape hatch is not
   * optional.
   */
  for (const pattern of ignore) {
    if (contains(haystack, pattern)) return null;
  }

  // Host-supplied patterns win over built-ins so the reported `pattern` is the
  // one the host recognises in its own logs.
  for (const pattern of extra) {
    const needle = normalize(pattern);
    if (needle && haystack.includes(needle)) return { pattern: needle, label };
  }

  for (const pattern of KNOWN_THIRD_PARTY_DEVICES) {
    if (haystack.includes(pattern)) return { pattern, label };
  }

  return null;
}

function normalize(pattern) {
  return typeof pattern === 'string' ? pattern.trim().toLowerCase() : '';
}

function contains(haystack, pattern) {
  const needle = normalize(pattern);
  return needle.length > 0 && haystack.includes(needle);
}

/** `getSettings()` can throw on an already-stopped track in some browsers. */
function safeSettings(track) {
  try {
    return track?.getSettings?.() ?? {};
  } catch {
    return {};
  }
}

/** `navigator.mediaDevices`, or null outside a browser / in an insecure context. */
function mediaDevices() {
  return typeof navigator !== 'undefined' ? navigator.mediaDevices ?? null : null;
}
