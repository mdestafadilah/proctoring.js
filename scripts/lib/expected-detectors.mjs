/**
 * The canonical detector list, as the suites expect to find it.
 *
 * This is deliberately a hardcoded expectation rather than something read back
 * out of the build. The point of asserting on it is to catch a *build* regression
 * — a registry entry silently dropped, or a detector that stopped being exported —
 * and comparing the build against itself would prove nothing.
 *
 * It lives in one file because the list is asserted from five places (the ESM and
 * CJS checks, UMD, the browser suite, and the deployed static demo), and keeping
 * five copies in sync has already failed twice:
 *
 *   - `verify-umd.mjs` was missed when `thirdParty` was added, and only surfaced
 *     when that suite happened to be run.
 *   - `verify-static-demo.mjs` was missed for both `clipboard` and `thirdParty`,
 *     and stayed hidden for longer still, because `verify:static` cannot run
 *     before the release it verifies is published.
 *
 * Order matters: it is the registry's insertion order, and the assertion is a
 * deep-equal on the array.
 */
export const EXPECTED_DETECTORS = Object.freeze([
  'tabs',
  'rightClick',
  'shortcuts',
  'clipboard',
  'camera',
  'face',
  'audio',
  'thirdParty',
]);
