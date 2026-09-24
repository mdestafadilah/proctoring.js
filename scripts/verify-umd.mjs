/**
 * UMD smoke test driver.
 *
 * The UMD bundle is what jsDelivr/unpkg serve for `<script src>` consumers, and
 * it fails in a way unit tests cannot catch: the file can be valid on disk while
 * a *dev server* still breaks it.
 *
 * IMPORTANT: do NOT serve this over Vite. Vite's dev server pipes every .js
 * through its ESM transform, which injects an `import` statement into the UMD
 * wrapper and makes the browser throw `SyntaxError: Cannot use import statement
 * outside a module`. The bug is in the test harness, not the build.
 *
 * Instead serve the repo as a plain static directory — exactly how a CDN does:
 *
 *   python -m http.server 5199 --bind 127.0.0.1     # from the repo root
 *   bun scripts/verify-umd.mjs
 */
import { launchEdge, tmpProfile } from './lib/cdp.mjs';
import { version } from './lib/pkg.mjs';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 5199;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const passed = [];
const ok = (label) => {
  passed.push(label);
  console.log(`  ok  ${label}`);
};

const python = process.env.PYTHON || 'python';
const server = spawn(python, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: root,
  stdio: 'ignore',
});

// Give the static server a moment to bind.
await new Promise((r) => setTimeout(r, 1500));

const page = await launchEdge({ port: 9365, profileDir: tmpProfile('pjs-umd-profile') });

try {
  await page.goto('/scripts/umd-smoke.html', { baseUrl: ORIGIN });
  await page.waitFor('window.__umd !== undefined', 'umd bundle evaluated');
  const result = await page.evaluate('window.__umd');

  assert.equal(result.ok, true, `UMD did not attach a global: ${result.reason}`);
  ok('window.Proctoring is defined after a plain <script src>');

  assert.equal(result.globalName, 'Proctoring');
  assert.equal(result.version, version);
  ok(`global is named "Proctoring" and exposes version ${result.version}`);

  assert.equal(result.hasProctor, true, 'Proctor class must be on the global');
  assert.deepEqual(result.detectors, ['tabs', 'rightClick', 'shortcuts', 'clipboard', 'camera', 'face', 'audio', 'thirdParty']);
  ok('Proctor class and every detector are reachable');

  assert.equal(result.eventSample, 'violation');
  assert.equal(result.typeSample, 'tab-hidden');
  assert.equal(result.durationSample, '1h 1m 1s');
  ok('constants and helpers work from the UMD build');

  ok(`${result.keyCount} exports total`);

  assert.deepEqual(page.errors, [], `console errors: ${JSON.stringify(page.errors)}`);
  ok('console is clean');

  console.log(`\nAll ${passed.length} UMD checks passed.`);
} finally {
  await page.close();
  server.kill();
}
