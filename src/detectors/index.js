import { TabsDetector } from './tabs.js';
import { RightClickDetector } from './right-click.js';
import { ShortcutsDetector } from './shortcuts.js';
import { CameraDetector } from './camera.js';
import { FaceDetector } from './face.js';
import { AudioDetector } from './audio.js';

/**
 * Detector registry.
 *
 * Adding a capability means adding one entry here plus a file — the Proctor
 * class never needs to know the concrete detector classes.
 */
export const DETECTORS = Object.freeze({
  tabs: TabsDetector,
  rightClick: RightClickDetector,
  shortcuts: ShortcutsDetector,
  camera: CameraDetector,
  face: FaceDetector,
  audio: AudioDetector,
});

export const DETECTOR_NAMES = Object.freeze(Object.keys(DETECTORS));

/**
 * Instantiate a detector by name.
 *
 * @param {string} name
 * @param {object} config resolved config for that detector
 * @param {object} context { options, report, log, emit, setState, getDetector }
 */
export function createDetector(name, config, context) {
  const Detector = DETECTORS[name];
  if (!Detector) {
    throw new Error(`proctoring.js: unknown detector "${name}"`);
  }
  return new Detector(config, context);
}

export { TabsDetector, RightClickDetector, ShortcutsDetector, CameraDetector, FaceDetector, AudioDetector };
