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
import { launchEdge, tmpProfile } from './lib/cdp.mjs';
import { version } from './lib/pkg.mjs';
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
  profileDir: tmpProfile('pjs-static-profile'),
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
  assert.equal(load.version, version, `unexpected version: ${load.version}`);
  assert.equal(load.badge, `v${version}`);
  assert.deepEqual(load.detectors, ['tabs', 'rightClick', 'shortcuts', 'camera', 'face', 'audio']);
  ok(`UMD dari jsDelivr dimuat (window.Proctoring v${load.version})`);

  assert.equal(load.cdnScript.length, 1, 'the demo must load exactly one CDN script');
  // The demo must pin the current release, not merely some version: a demo left
  // on the previous pin would still load, and would quietly stop proving that
  // the published bundle works.
  assert.ok(
    load.cdnScript[0].includes(`proctoring.js@${version}`),
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
  // 2b. Right-click detection through the published bundle and the demo UI.
  //     This is the strongest available proof: a genuine right-click, against
  //     the artifact npm actually serves, wired through the demo's own options.
  // ---------------------------------------------------------------------
  console.log('\nStatic demo: klik kanan');

  await page.evaluate(`(function () {
    var probe = document.createElement('div');
    probe.id = 'pjs-probe';
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:140px;height:60px;z-index:2147483647;background:#ddd';
    document.body.appendChild(probe);
    return true;
  })()`);

  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      x: 70,
      y: 30,
      button: 'right',
      buttons: type === 'mousePressed' ? 2 : 0,
      clickCount: 1,
    });
  }

  await page.waitFor(
    `document.getElementById('log').innerText.includes('right-click')`,
    'klik kanan tercatat di log'
  );
  ok('klik kanan tercatat di log sebagai "right-click"');

  // The demo detects without blocking, so a native menu is now open. Dismiss it
  // so the rest of the run is not typing into a popup.
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', {
      type,
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }

  await page.waitFor(
    `document.getElementById('detectors').innerText.includes('rightClick')`,
    'baris status rightClick muncul'
  );

  const afterClick = await page.evaluate(`(function () {
    return {
      total: document.getElementById('statTotal').textContent,
      score: document.getElementById('statScore').textContent,
    };
  })()`);

  assert.equal(afterClick.total, '2', `expected 2 violations after the right-click, got ${afterClick.total}`);
  assert.notEqual(afterClick.score, '100');
  ok(`total naik ke ${afterClick.total} dan skor turun ke ${afterClick.score}`);

  await page.evaluate('document.getElementById("pjs-probe")?.remove()');

  // ---------------------------------------------------------------------
  // 2c. Keyboard shortcuts, through the demo UI and the published bundle.
  //
  //     Deliberately a synthetic keydown rather than a genuine one: the demo
  //     does not block the shortcut, so a real Ctrl+Shift+I would open DevTools
  //     in the middle of the run. The genuine keystroke path is proved by
  //     verify-browser.mjs, which pushes it through Edge's input pipeline.
  // ---------------------------------------------------------------------
  console.log('\nStatic demo: shortcut keyboard');

  await page.evaluate(`(function () {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true,
      bubbles: true, cancelable: true,
    }));
    return true;
  })()`);

  await page.waitFor(
    `document.getElementById('log').innerText.includes('shortcut-used')`,
    'shortcut tercatat di log'
  );
  ok('Ctrl+Shift+I tercatat di log sebagai "shortcut-used"');

  await page.waitFor(
    `document.getElementById('detectors').innerText.includes('shortcuts')`,
    'baris status shortcuts muncul'
  );

  const afterShortcut = await page.evaluate(
    `document.getElementById('statTotal').textContent`
  );
  assert.equal(afterShortcut, '3', `expected 3 violations after the shortcut, got ${afterShortcut}`);
  ok(`total naik ke ${afterShortcut}`);

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
