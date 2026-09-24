/**
 * Loaders for `@vladmandic/face-api` and its model weights.
 *
 * The library must NOT depend on face-api at install time: it adds ~2MB to the
 * consumer's node_modules and couples our release cadence to theirs. Instead we
 * resolve it lazily, and the weights are a matching concern — a model built for
 * one face-api version silently produces garbage on another, so the *same CDN
 * and version* serves both.
 */

/** Pinned so behaviour cannot change under a consumer's feet overnight. */
export const FACE_API_VERSION = '1.7.15';

/**
 * Default asset locations.
 *
 * jsDelivr serves both the ESM bundle and the `model/` directory from the same
 * published npm tarball, which guarantees the weights and the runtime agree.
 */
export const CDN_DEFAULTS = Object.freeze({
  scriptUrl: `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${FACE_API_VERSION}/dist/face-api.esm.js`,
  modelUrl: `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${FACE_API_VERSION}/model/`,
});

/**
 * Cache the dynamically imported module across sessions so a second
 * `new Proctor()` in the same page does not re-download the bundle.
 * @type {Promise<any>|null}
 */
let cdnModulePromise = null;

/**
 * Resolve a face-api compatible namespace.
 *
 * @param {'cdn'|'module'|'custom'} provider
 * @param {object} providerOptions
 * @returns {Promise<{ api: object, modelUrl: string, source: string }>}
 */
export async function loadFaceApiProvider(provider, providerOptions = {}) {
  switch (provider) {
    case 'cdn':
      return loadFromCdn(providerOptions);
    case 'module':
      return loadFromModule(providerOptions);
    case 'custom':
      return loadFromCustom(providerOptions);
    default:
      throw new Error(
        `proctoring.js: unknown face.provider "${provider}". Expected "cdn", "module", or "custom".`
      );
  }
}

/**
 * Load the ESM bundle from a CDN into the page.
 *
 * Note: the bundle is imported as a native ES module, so it must be a real
 * separate HTTP request — it cannot be bundled into ours, because bundlers
 * would then try to resolve `@tensorflow/tfjs` at build time and the whole point
 * is to keep tfjs out of our dependency tree.
 */
async function loadFromCdn(providerOptions) {
  const scriptUrl = providerOptions.scriptUrl || CDN_DEFAULTS.scriptUrl;
  const modelUrl = providerOptions.modelUrl || CDN_DEFAULTS.modelUrl;

  if (!cdnModulePromise) {
    cdnModulePromise = import(/* @vite-ignore */ scriptUrl).catch((err) => {
      // Reset so a later retry (e.g. after the network recovers) can try again.
      cdnModulePromise = null;
      throw new Error(
        `proctoring.js: failed to load face-api from "${scriptUrl}". ` +
          `Check the network or pass face.providerOptions.scriptUrl. (${err?.message || err})`
      );
    });
  }

  const mod = await cdnModulePromise;
  return { api: unwrapDefault(mod), modelUrl, source: scriptUrl };
}

/**
 * Use a face-api copy the host app installed itself.
 * `import()` of a bare specifier is resolved by the consumer's bundler.
 */
async function loadFromModule(providerOptions) {
  const specifier = providerOptions.specifier || '@vladmandic/face-api';

  let mod;
  try {
    mod = await import(/* @vite-ignore */ specifier);
  } catch (err) {
    throw new Error(
      `proctoring.js: face.provider "module" requires "${specifier}" to be installed. ` +
        `Run: npm install ${specifier}. (${err?.message || err})`
    );
  }

  const api = unwrapDefault(mod);
  const modelUrl =
    providerOptions.modelUrl ||
    // `dist/` -> package root, so the sibling `model/` folder is one level up.
    deriveSiblingModelUrl(specifier);

  return { api, modelUrl, source: specifier };
}

/** Use anything the host already put on `globalThis`. */
async function loadFromCustom(providerOptions) {
  const api = providerOptions.api || globalThis.faceapi || globalThis.faceApi;
  if (!api || typeof api.nets?.tinyFaceDetector?.loadFromUri !== 'function') {
    throw new Error(
      'proctoring.js: face.provider "custom" needs a valid face-api namespace. ' +
        'Pass face.providerOptions.api, or expose it as globalThis.faceapi.'
    );
  }

  const modelUrl = providerOptions.modelUrl || providerOptions.api.modelUrl || null;
  if (!modelUrl) {
    throw new Error('proctoring.js: face.provider "custom" requires providerOptions.modelUrl');
  }

  return { api, modelUrl, source: 'custom' };
}

/**
 * face-api is published as ESM with both named and default exports depending on
 * the build. Normalise so `api.nets` always resolves.
 */
function unwrapDefault(mod) {
  if (mod && typeof mod.nets?.tinyFaceDetector?.loadFromUri === 'function') return mod;
  if (mod?.default && typeof mod.default.nets?.tinyFaceDetector?.loadFromUri === 'function') {
    return mod.default;
  }
  // Some builds expose `faceapi` as a named export.
  if (mod?.faceapi) return mod.faceapi;
  return mod;
}

/**
 * Guess the model directory next to an installed package.
 * `@scope/pkg` or `pkg` -> `/node_modules/<pkg>/model/`.
 * This is only a fallback; the documented path is to set `modelUrl` explicitly.
 */
function deriveSiblingModelUrl(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return `${specifier}/model/`;
  return `/node_modules/${specifier}/model/`;
}
