/**
 * Frame capture for visual violations.
 *
 * This is the one place in the library that produces image data, and it is
 * strictly opt-in (`report.captureScreenshots`, default false). Two rules shape
 * the implementation:
 *
 *  1. **Downscale aggressively.** A raw 640x480 JPEG is ~40KB base64. At 320px
 *     wide it is ~8KB, which is enough to tell "empty chair" from "student", and
 *     keeps a long exam's report inside a sane memory budget.
 *  2. **Never let capture break reporting.** Every failure path returns null. A
 *     tainted canvas, a detached video element, or a browser that refuses
 *     `toDataURL` must not cost us the violation itself.
 */

/** Defaults chosen so the payload stays small but the frame stays legible. */
export const SCREENSHOT_DEFAULTS = Object.freeze({
  maxWidth: 320,
  quality: 0.6,
  type: 'image/jpeg',
});

/**
 * Capture the current frame of a video element as a data URL.
 *
 * @param {HTMLVideoElement|null} video
 * @param {object} [options]
 * @param {number} [options.maxWidth=320] downscale target; 0 keeps native size
 * @param {number} [options.quality=0.6] JPEG quality, 0..1
 * @param {string} [options.type='image/jpeg']
 * @returns {string|null} data URL, or null when no frame could be read
 */
export function captureFrame(video, options = {}) {
  const { maxWidth, quality, type } = { ...SCREENSHOT_DEFAULTS, ...options };

  if (!video || typeof document === 'undefined') return null;

  // readyState < 2 means no current frame data; videoWidth 0 means metadata has
  // not arrived. Calling drawImage either way yields a blank or throws.
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;

  try {
    const scale = maxWidth > 0 ? Math.min(1, maxWidth / video.videoWidth) : 1;
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, width, height);

    // `toDataURL` throws SecurityError on a tainted canvas. It can only be
    // tainted by a cross-origin source, which should not happen for a webcam,
    // but a host app could pass in a remote video element.
    return canvas.toDataURL(type, quality);
  } catch {
    return null;
  }
}

/**
 * Should this violation get a screenshot attached?
 *
 * Only visual detectors can produce a meaningful frame; attaching a webcam
 * still to an `audio-too-loud` event would be misleading evidence.
 *
 * @param {string} violationType
 * @param {string|null} detector
 * @param {string[]} allowedTypes explicit allow-list from options
 */
export function isVisualViolation(violationType, detector, allowedTypes) {
  if (Array.isArray(allowedTypes) && allowedTypes.length > 0) {
    return allowedTypes.includes(violationType);
  }
  // Default: anything the camera or face detector raised.
  return detector === 'camera' || detector === 'face';
}

/**
 * Rough decoded size of a data URL, in bytes.
 * Used to enforce a total budget so one long session cannot exhaust memory.
 */
export function dataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return 0;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return 0;
  const base64 = dataUrl.slice(comma + 1);
  // 4 base64 chars encode 3 bytes; padding reduces the count.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
