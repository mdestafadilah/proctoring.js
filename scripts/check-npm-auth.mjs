/**
 * npm publish credential checker.
 *
 * Diagnoses the "E403 You may not perform that action with these credentials"
 * failure, which npm reports for a whole family of causes without saying which
 * one applies. Run this instead of guessing:
 *
 *   node scripts/check-npm-auth.mjs
 *
 * It never prints the token value, and it never writes to the registry — the
 * read-only probes below are enough to tell a read-only token from a broken one.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REGISTRY = 'https://registry.npmjs.org';
const PACKAGE_NAME = 'proctoring.js';

/** Read `_authToken` for npmjs.org without ever logging it. */
function readToken() {
  // An env var wins over the file, exactly as npm resolves it.
  if (process.env.NODE_AUTH_TOKEN) return { token: process.env.NODE_AUTH_TOKEN, source: 'NODE_AUTH_TOKEN' };
  if (process.env.NPM_TOKEN) return { token: process.env.NPM_TOKEN, source: 'NPM_TOKEN' };

  const npmrc = join(homedir(), '.npmrc');
  if (!existsSync(npmrc)) return { token: null, source: null };

  for (const line of readFileSync(npmrc, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\/\/registry\.npmjs\.org\/:_authToken=(.+)$/);
    if (match) return { token: match[1].trim(), source: `${npmrc} (registry.npmjs.org)` };
  }
  return { token: null, source: null };
}

/** Classify the token so the fix is obvious. */
function describeToken(token) {
  if (token.startsWith('npm_')) {
    return {
      type: 'Granular access token',
      note: 'Permissions are set per-token in the npm UI.',
    };
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return {
      type: 'Classic token (UUID format)',
      note: 'Legacy tokens are deprecated; "Automation" type bypasses 2FA.',
    };
  }
  return { type: 'Unrecognised format', note: 'Could be a revoked or corrupted token.' };
}

async function probe(label, url, token, init = {}) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    return { label, status: res.status, ok: res.ok, body: await res.text() };
  } catch (err) {
    return { label, status: 0, ok: false, body: String(err) };
  }
}

const { token, source } = readToken();

if (!token) {
  console.log('FAIL  Tidak ada token untuk registry.npmjs.org.');
  console.log('      Jalankan: npm login   (atau set NODE_AUTH_TOKEN)');
  process.exit(1);
}

console.log(`Token sumber : ${source}`);
console.log(`Token jenis  : ${describeToken(token).type}`);
console.log(`Token panjang: ${token.length} karakter`);
console.log(`Catatan      : ${describeToken(token).note}`);
console.log('');

// 1. Is the token alive at all?
const whoami = await probe('whoami', `${REGISTRY}/-/whoami`, token);
if (whoami.status === 401) {
  console.log('FAIL  Token ditolak (401). Token sudah kedaluwarsa atau dicabut.');
  console.log('      Buat token baru: https://www.npmjs.com/settings/~tokens');
  process.exit(1);
}
console.log(`OK    Token hidup — login sebagai ${JSON.parse(whoami.body).username}`);

// 2. Does it have account-level write access?
//    `/-/npm/v1/user` requires a session or a token with write privileges, so a
//    403 here is the earliest reliable signal that the token is read-only.
const user = await probe('user', `${REGISTRY}/-/npm/v1/user`, token);

if (user.status === 200) {
  let tfa = 'unknown';
  try {
    tfa = JSON.parse(user.body).tfa ? 'AKTIF' : 'tidak aktif';
  } catch {
    /* shape may differ; not important */
  }
  console.log(`OK    Token punya hak tulis (2FA akun: ${tfa})`);
  console.log('');
  console.log('Token ini seharusnya bisa publish. Coba lagi:');
  console.log('  npm publish');
} else if (user.status === 403) {
  console.log('FAIL  Token READ-ONLY — inilah penyebab E403 saat publish.');
  console.log('');
  console.log('Perbaiki dengan membuat token baru:');
  console.log('  1. Buka https://www.npmjs.com/settings/~tokens');
  console.log('  2. "Generate New Token" -> "Granular Access Token"');
  console.log('  3. Permissions      : pilih "Read and write"');
  console.log(`  4. Packages         : "All packages" (atau sertakan ${PACKAGE_NAME})`);
  console.log('  5. Bypass 2FA       : centang (kalau akun pakai 2FA)');
  console.log('  6. Salin token, lalu:');
  console.log('       npm config set //registry.npmjs.org/:_authToken=<token-baru>');
  console.log('       node scripts/check-npm-auth.mjs   # harus lolos sebelum publish');
  process.exit(1);
} else {
  console.log(`WARN  Pemeriksaan hak tulis mengembalikan HTTP ${user.status}.`);
  console.log(`      ${user.body.slice(0, 160)}`);
}
