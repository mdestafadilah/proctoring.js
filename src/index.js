/**
 * proctoring.js — browser proctoring toolkit.
 *
 * Public entry point. Anything not exported here is internal and may change
 * without a major version bump.
 *
 * @packageDocumentation
 */

export { Proctor, createProctor, default } from './core/proctor.js';

export {
  EVENTS,
  VIOLATION_TYPES,
  SEVERITY,
  DEFAULT_OPTIONS,
  DEFAULT_SEVERITY,
  LOG_LEVELS,
  severityWeight,
} from './core/options.js';

export { Emitter } from './core/emitter.js';
export { ViolationStore } from './core/store.js';
export { BackendTransport } from './core/transport.js';

export { DETECTORS, DETECTOR_NAMES, createDetector } from './detectors/index.js';
export { TabsDetector } from './detectors/tabs.js';
export { RightClickDetector } from './detectors/right-click.js';
export { CameraDetector } from './detectors/camera.js';
export { FaceDetector } from './detectors/face.js';
export { AudioDetector, computeRms, computeSpectralDensity } from './detectors/audio.js';

export {
  FACE_API_VERSION,
  CDN_DEFAULTS,
  loadFaceApiProvider,
} from './face/providers.js';

export {
  captureFrame,
  isVisualViolation,
  dataUrlBytes,
  SCREENSHOT_DEFAULTS,
} from './core/screenshot.js';

export {
  formatReport,
  reportToCsv,
  downloadReport,
  downloadReportCsv,
  mergeReports,
  diffReports,
  worstSeverityOf,
  formatDuration,
} from './report.js';

export { isBrowser, isSecureContext, mergeOptions, throttle, every, uid, clamp } from './core/utils.js';

export const version = '0.2.0';
