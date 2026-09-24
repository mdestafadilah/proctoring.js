/**
 * Verifies the static demo in netlify-demo/ before it is deployed.
 *
 * This is a different test from verify-umd.mjs: that one checks the bundle on
 * disk, this one checks the *deployed shape* — a single self-contained HTML file
 * loading the published package from jsDelivr over the real network, with no
 * dev server and no local files besides index.html.
 *
 * It must be served as a plain static file. Vite would rewrite the script tag
 * and hide the very thing we are testing.
 *
 *   bun scripts/verify-static-demo.mjs
 */
import { launchEdge } from 'file:///C:/Users/asus/.workbuddy-ai/skills/windows-edge-cdp-ui-verify/scripts/cdp.mjs';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 5211;

/**
 * Set DEMO_URL to check a deployed copy instead of the local folder, e.g.
 *   DEMO_URL=https://proctoring-js-demo.netlify.app bun scripts/verify-static-demo.mjs
 * Deploying is not proof that the site works, so this must be run against the
 * live origin after every deploy.
 */
const LIVE_URL = process.env.DEMO_URL || null;
const ORIGIN = LIVE_URL || `http://127.0.0.1:${PORT}`;

const passed = [];
const ok = (label) => {
  passed.push(label);
  console.log(`  ok  ${label}`);
};

// Only spawn the static server when testing locally.
let server = null;
if (!LIVE_URL) {
  server = spawn(
    process.env.PYTHON || 'python',
    ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: resolve(root, 'netlify-demo'), stdio: 'ignore' }
  );
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(LIVE_URL ? `Menguji URL live: ${LIVE_URL}` : `Menguji folder lokal: ${ORIGIN}`);

const page = await launchEdge({
  port: 9367,
  profileDir: `${process.env.TEMP}\\pjs-static-profile`,
  extraArgs: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  // `goto` concatenates `baseUrl + path` rather than resolving them, so an
  // absolute URL must be passed with an empty baseUrl or the two are glued
  // together into nonsense.
  if (LIVE_URL) {
    await page.goto(LIVE_URL, { baseUrl: '' });
  } else {
    await page.goto('/index.html', { baseUrl: ORIGIN });
  }
  await page.waitFor('document.getElementById("versionBadge") !== null', 'demo dirender');

  // ---------------------------------------------------------------------
  // 1. The published package actually loaded from the CDN.
  // ---------------------------------------------------------------------
  console.log('\nStatic demo: CDN load');

  await page.waitFor(
    `document.getElementById('versionBadge').textContent !== 'memuat…'`,
    'badge versi terisi'
  );

  const load = await page.evaluate(`(function () {
    return {
      badge: document.getElementById('versionBadge').textContent,
      hasGlobal: typeof window.Proctoring === 'object',
      version: window.Proctoring ? window.Proctoring.version : null,
      detectors: window.Proctoring ? [...window.Proctoring.DETECTOR_NAMES] : [],
      status: document.getElementById('status').textContent,
      // Prove the bundle came from the CDN rather than a local file.
      cdnScript: [...document.querySelectorAll('script[src]')]
        .map((s) => s.src)
        .filter((s) => s.includes('jsdelivr')),
    };
  })()`);

  assert.equal(load.hasGlobal, true, 'window.Proctoring must be defined');
  assert.equal(load.version, '0.1.0', `unexpected version: ${load.version}`);
  assert.equal(load.badge, 'v0.1.0');
  assert.deepEqual(load.detectors, ['tabs', 'camera', 'face', 'audio']);
  ok(`UMD dari jsDelivr dimuat (window.Proctoring v${load.version})`);

  assert.equal(load.cdnScript.length, 1, 'the demo must load exactly one CDN script');
  assert.ok(
    load.cdnScript[0].includes('proctoring.js@0.1.0'),
    `unexpected CDN URL: ${load.cdnScript[0]}`
  );
  ok('skrip dimuat dari URL jsDelivr yang di-pin ke versi terbit');

  // ---------------------------------------------------------------------
  // 2. A real session produces a real violation through the UI.
  // ---------------------------------------------------------------------
  console.log('\nStatic demo: sesi');

  await page.clickByText('Mulai sesi');
  await page.waitFor(
    `document.getElementById('status').className.includes('running')`,
    'sesi berjalan'
  );
  ok('tombol "Mulai sesi" menjalankan sesi');

  // Simulate the tab being hidden — the exact case the detector exists for.
  await page.evaluate(`(function () {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate(`(function () {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);

  await page.waitFor(
    `document.getElementById('log').innerText.includes('tab-hidden')`,
    'pelanggaran tercatat di log'
  );
  ok('pindah tab tercatat di log sebagai "tab-hidden"');

  // The status list is filled by a 400ms poll, so wait for it rather than
  // reading immediately after the violation appears.
  await page.waitFor(
    `document.getElementById('detectors').innerText.trim().length > 0`,
    'daftar status detector terisi'
  );

  const ui = await page.evaluate(`(function () {
    return {
      total: document.getElementById('statTotal').textContent,
      score: document.getElementById('statScore').textContent,
      hasSeverity: document.getElementById('log').innerText.includes('high'),
      detectorRows: document.getElementById('detectors').innerText,
    };
  })()`);

  assert.equal(ui.total, '1', `expected 1 violation in the UI, got ${ui.total}`);
  assert.notEqual(ui.score, '100', 'the score must drop after a violation');
  assert.equal(ui.hasSeverity, true, 'the severity chip must be rendered');
  ok(`statistik diperbarui (total=${ui.total}, skor=${ui.score})`);

  assert.ok(ui.detectorRows.includes('tabs'), 'the detector status list must render');
  ok('daftar status detector dirender');

  // ---------------------------------------------------------------------
  // 3. Stop and teardown.
  // ---------------------------------------------------------------------
  console.log('\nStatic demo: teardown');

  await page.clickByText('Stop');
  await page.waitFor(
    `document.getElementById('status').textContent.includes('Berhenti')`,
    'sesi berhenti'
  );
  ok('tombol "Stop" menghentikan sesi');

  // ---------------------------------------------------------------------
  // 4. Clean console.
  // ---------------------------------------------------------------------
  console.log('\nStatic demo: console');
  assert.deepEqual(page.errors, [], `console errors: ${JSON.stringify(page.errors)}`);
  ok('console bersih');

  await page.screenshot(resolve(root, 'outputs', 'netlify-demo.png'));
  console.log(`\nAll ${passed.length} checks passed.`);
} finally {
  await page.close();
  if (server) server.kill();
}
