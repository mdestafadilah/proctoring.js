import { VIOLATION_TYPES } from '../core/options.js';
import { isSecureContext, throttle } from '../core/utils.js';

/**
 * Camera detector.
 *
 * Responsibilities:
 *  - acquire the webcam stream (and expose it so the face detector can reuse it)
 *  - detect the three ways a camera stops being trustworthy: the track ends,
 *    the track is muted (camera covered, or revoked from the permission UI),
 *    and no frames are arriving.
 *
 * Frames are never uploaded by this class. Everything stays in the page unless
 * the host wires up `report.captureScreenshots`.
 */
export class CameraDetector {
  static name = 'camera';

  constructor(config, context) {
    this.config = config;
    this.context = context;
    this.stream = null;
    this.videoElement = null;
    this.track = null;
    this.lastFrameTime = 0;
    this.frameWatchTimer = null;
    this.frameWatchCanvas = null;
    this.denied = false;

    this._onTrackEnded = null;
    this._onTrackMuted = null;
    this._onTrackUnmuted = null;

    this._emit = throttle((type, details) => {
      this.context.report(type, details, { detector: 'camera' });
    }, config.throttleMs);
  }

  async init() {
    if (!isSecureContext()) {
      // getUserMedia only exists in a secure context. Fail loudly instead of
      // reporting a fake "camera off" violation that the user cannot fix.
      throw new Error(
        'proctoring.js: camera requires a secure context (https:// or http://localhost)'
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('proctoring.js: getUserMedia is not supported in this browser');
    }

    this.videoElement = resolveVideoElement(this.config.videoElement);

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: this.config.width },
          height: { ideal: this.config.height },
          facingMode: this.config.facingMode,
        },
        audio: false,
      });
    } catch (err) {
      // Map the DOMException onto a violation, because "the student denied the
      // camera" is a proctoring event, not merely an initialisation error.
      this.denied = true;
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      this._emit(VIOLATION_TYPES.CAMERA_DENIED, {
        reason: err?.name || 'UnknownError',
        message: err?.message || String(err),
        denied,
      });
      this.context.setState('camera', { active: false, status: 'denied', denied });
      throw err;
    }

    this.stream = stream;
    this.track = stream.getVideoTracks()[0] || null;

    if (this.videoElement) {
      this.videoElement.srcObject = stream;
      // `playsInline` is required or iOS Safari opens a fullscreen player.
      this.videoElement.setAttribute('playsinline', 'true');
      try {
        await this.videoElement.play();
      } catch (err) {
        // Autoplay can be blocked without a user gesture. The stream is still
        // live, so monitoring continues; only the preview is missing.
        this.context.log('warn', 'Camera preview could not autoplay', { error: err });
      }
    }

    this._attachTrackListeners();
    this._startFrameWatch();

    this.context.setState('camera', { active: true, status: 'running', label: this.track?.label });
    return true;
  }

  _attachTrackListeners() {
    if (!this.track) return;

    this._onTrackEnded = () => {
      // The most severe camera event: the device disappeared or permission was
      // revoked from the browser UI. Nothing can recover from inside the page.
      this._emit(VIOLATION_TYPES.CAMERA_DISABLED, {
        reason: 'track-ended',
        message: 'The camera stream ended unexpectedly',
      });
      this.context.setState('camera', { active: false, status: 'ended' });
      this.context.log('error', 'Camera track ended');
    };

    if (this.config.detectMuted) {
      this._onTrackMuted = () => {
        this._emit(VIOLATION_TYPES.CAMERA_MUTED, {
          reason: 'track-muted',
          message: 'The camera track is muted — the lens may be covered or blocked',
        });
        this.context.setState('camera', { active: true, status: 'muted' });
      };

      this._onTrackUnmuted = () => {
        this.context.setState('camera', { active: true, status: 'running' });
        this.context.log('info', 'Camera track unmuted');
      };

      this.track.addEventListener('mute', this._onTrackMuted);
      this.track.addEventListener('unmute', this._onTrackUnmuted);
    }

    this.track.addEventListener('ended', this._onTrackEnded);
  }

  /**
   * Watch for a "silent" freeze: the track reports live but the video element
   * stops producing new frames (common when another app grabs the device).
   *
   * Implemented by comparing a downscaled frame against the previous one. Doing
   * this on a 32x24 canvas keeps the cost negligible even at 1Hz.
   */
  _startFrameWatch() {
    if (!this.videoElement) return;

    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    this.frameWatchCanvas = canvas;
    let previous = null;

    this.frameWatchTimer = setInterval(() => {
      if (!this.stream || this.videoElement.readyState < 2) return;

      try {
        ctx.drawImage(this.videoElement, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

        if (previous && identical(previous, frame)) {
          this.frozenStreak = (this.frozenStreak || 0) + 1;
          // ~3s of identical frames is a freeze, not a still background.
          if (this.frozenStreak === 3 && this.track?.readyState === 'live') {
            this._emit(VIOLATION_TYPES.CAMERA_MUTED, {
              reason: 'frozen-frames',
              message: 'The camera image has not changed — the feed may be frozen',
            });
          }
        } else {
          this.frozenStreak = 0;
        }

        previous = frame;
        this.lastFrameTime = Date.now();
      } catch {
        // Tainted canvas or a race during teardown; safe to ignore.
      }
    }, 1000);
  }

  /** The live stream, so the face detector can share one camera permission. */
  getStream() {
    return this.stream;
  }

  getVideoElement() {
    return this.videoElement;
  }

  getState() {
    const track = this.track;
    return {
      active: Boolean(this.stream),
      status: track?.readyState === 'live' ? 'running' : 'stopped',
      readyState: track?.readyState ?? null,
      enabled: track?.enabled ?? null,
      muted: track?.muted ?? null,
      label: track?.label ?? null,
      hasVideoElement: Boolean(this.videoElement),
    };
  }

  destroy() {
    if (this.frameWatchTimer) clearInterval(this.frameWatchTimer);
    this.frameWatchTimer = null;
    this.frameWatchCanvas = null;

    if (this.track) {
      if (this._onTrackEnded) this.track.removeEventListener('ended', this._onTrackEnded);
      if (this._onTrackMuted) this.track.removeEventListener('mute', this._onTrackMuted);
      if (this._onTrackUnmuted) this.track.removeEventListener('unmute', this._onTrackUnmuted);
    }

    // Stopping tracks is what actually turns off the camera LED.
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }

    if (this.videoElement?.srcObject) {
      this.videoElement.srcObject = null;
    }

    this.stream = null;
    this.track = null;
    this._onTrackEnded = null;
    this._onTrackMuted = null;
    this._onTrackUnmuted = null;
    this.context.setState('camera', { active: false, status: 'destroyed' });
  }
}

/** Accept a CSS selector, a DOM element, or null. */
function resolveVideoElement(target) {
  if (!target) return null;
  if (typeof target === 'string') {
    const el = document.querySelector(target);
    if (!el) {
      // Not fatal: monitoring works without a preview.
      console.warn(`[proctoring.js] camera.videoElement selector "${target}" matched nothing`);
      return null;
    }
    return el;
  }
  if (typeof target === 'object' && target.nodeType === 1) return target;
  return null;
}

/** Byte-level comparison of two RGBA frame buffers. */
function identical(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 4) {
    // Sample every 4th pixel — a real freeze changes the whole buffer anyway,
    // and this cuts the comparison cost by 75%.
    if (a[i] !== b[i]) return false;
  }
  return true;
}
