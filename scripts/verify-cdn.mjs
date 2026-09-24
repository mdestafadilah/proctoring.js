/**
 * Verify a published release against the CDN.
 *
 * The last step of a release is proving that what jsDelivr serves is byte-for-byte
 * what was built — not merely that the version exists. Doing that by hand went
 * wrong in exactly one way, twice, so this script exists:
 *
 *   - A 404 from jsDelivr has a **200-byte-class body** ("Couldn't find the
 *     requested release version X"). Piping it straight into `sha256sum` hashes
 *     the *error page*, which then differs from the local file and reads as
 *     "MISMATCH" — indistinguishable from a genuinely corrupted artifact. The
 *     HTTP status must be checked before the hash means anything.
 *   - jsDelivr learns about a new version on its own schedule. Its per-file cache
 *     and its version list propagate separately, so right after a purge some
 *     files resolve while others still 404 for another 30-60s. That is a delay,
 *     not a fault, and retrying is the correct response.
 *
 * Run it after `npm publish` and the jsDelivr purge:
 *
 *   bun scripts/verify-cdn.mjs          # the version in package.json
 *   bun scripts/verify-cdn.mjs 0.3.4    # or an older release, to audit it
 *
 * Exit code is 1 if anything is wrong, so it can gate a release.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8'));
// An explicit argument lets you audit a past release. The local `dist/` is only
// meaningful for the version currently checked out, so comparing an older
// version against it is expected to fail — the point there is to confirm the
// files exist on the CDN at all.
const VERSION = process.argv[2] || pkg.version;
const CDN = `https://cdn.jsdelivr.net/npm/${pkg.name}@${VERSION}`;

/** Everything `files` publishes out of `dist/`. */
const ARTIFACTS = [
  'index.d.ts',
  'proctoring.cjs',
  'proctoring.cjs.map',
  'proctoring.js',
  'proctoring.js.map',
  'proctoring.umd.js',
  'proctoring.umd.js.map',
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`  FAIL  ${message}`);
};

// ---------------------------------------------------------------------------
// 1. The registry must agree that this is the released version.
// ---------------------------------------------------------------------------
console.log(`\nVerifying ${pkg.name}@${VERSION}\n`);
console.log('registry');

try {
  const res = await fetch(`https://registry.npmjs.org/${pkg.name}`);
  const meta = await res.json();
  const latest = meta['dist-tags']?.latest;

  if (latest === VERSION) {
    console.log(`  ok    dist-tags.latest is ${VERSION}`);
  } else {
    fail(`dist-tags.latest is ${latest}, expected ${VERSION} — the publish may still be processing`);
  }

  // The version-specific endpoint is cached far longer than the packument and
  // serves a stale 404 for a while after a successful publish, so it is checked
  // only as information, never as the pass/fail signal.
  if (!meta.versions?.[VERSION]) fail(`the registry does not list ${VERSION}`);
} catch (err) {
  fail(`could not read the registry: ${err.message}`);
}

// ---------------------------------------------------------------------------
// 2. Every artifact must be present AND byte-identical.
// ---------------------------------------------------------------------------
console.log('\nCDN artifacts');

for (const file of ARTIFACTS) {
  const local = readFileSync(resolve(REPO, 'dist', file));
  const url = `${CDN}/dist/${file}`;

  let res = null;
  // The propagation window after a purge. 404 is expected here, not alarming.
  for (let attempt = 1; attempt <= 10; attempt++) {
    res = await fetch(url, { cache: 'no-store' });
    if (res.ok) break;
    if (attempt < 10) await sleep(6000);
  }

  // Status first. A hash of an error page is a false mismatch, and a false
  // mismatch is worse than no check at all: it sends you hunting for a build
  // problem that does not exist.
  if (!res.ok) {
    const body = (await res.text()).trim().slice(0, 120);
    fail(`${file}: HTTP ${res.status} after 10 attempts — ${body}`);
    continue;
  }

  const remote = Buffer.from(await res.arrayBuffer());
  const same = sha256(remote) === sha256(local);

  if (same) {
    console.log(`  ok    ${file.padEnd(22)} ${String(local.length).padStart(7)} bytes`);
  } else {
    fail(
      `${file}: content differs (local ${local.length} bytes, CDN ${remote.length} bytes). ` +
        'If the sizes match, the publish and the build are out of sync — rebuild before publishing.'
    );
  }
}

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed.`);
  console.log('If the artifacts 404, the jsDelivr purge has not run yet:');
  for (const file of ARTIFACTS) {
    console.log(`  curl "https://purge.jsdelivr.net/npm/${pkg.name}@${VERSION}/dist/${file}"`);
  }
  process.exit(1);
}

console.log(`All ${ARTIFACTS.length} artifacts match the CDN. ${pkg.name}@${VERSION} is released.`);
