/**
 * Deploys a folder to Netlify via the REST API.
 *
 * Written because the installed `netlify` CLI on this machine is a broken Yarn
 * shim (it resolves to a nonexistent `d:\c\...` path), and the API path is only
 * a handful of calls anyway — no 200MB dependency needed.
 *
 * Uses the digest flow rather than a zip upload: each file's SHA1 is declared up
 * front, and Netlify tells us which ones it does not already have. Netlify
 * deduplicates by digest, so redeploying after a one-line edit uploads one file.
 *
 *   node scripts/deploy-netlify.mjs <folder> [site-name]
 *
 * Requires a Netlify token, read from (in order):
 *   1. NETLIFY_AUTH_TOKEN (from the environment, or from .env)
 *   2. the token saved by `netlify login` in the user's config.json
 *
 * See .env.example for every variable the repo's scripts understand.
 */
import './load-env.mjs';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep, posix } from 'node:path';
import { homedir } from 'node:os';

const API = 'https://api.netlify.com/api/v1';

const folder = process.argv[2];
const siteName = process.argv[3] || 'proctoring-js-demo';

if (!folder) {
  console.error('Usage: node scripts/deploy-netlify.mjs <folder> [site-name]');
  process.exit(1);
}
if (!existsSync(folder)) {
  console.error(`Folder tidak ditemukan: ${folder}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------
function readToken() {
  if (process.env.NETLIFY_AUTH_TOKEN) {
    return { token: process.env.NETLIFY_AUTH_TOKEN, source: 'NETLIFY_AUTH_TOKEN' };
  }

  // `netlify login` writes to %APPDATA%/netlify/Config/config.json on Windows
  // and ~/.config/netlify/config.json elsewhere. APPDATA is not always exported
  // into a Git Bash shell, so derive it from the home directory.
  const candidates = [
    join(homedir(), 'AppData', 'Roaming', 'netlify', 'Config', 'config.json'),
    join(homedir(), '.config', 'netlify', 'config.json'),
  ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const config = JSON.parse(readFileSync(file, 'utf8'));
      const user = Object.values(config.users || {})[0];
      if (user?.auth?.token) return { token: user.auth.token, source: file, user: user.name };
    } catch {
      /* try the next candidate */
    }
  }
  return { token: null, source: null };
}

const { token, source, user } = readToken();
if (!token) {
  console.error('Tidak ada token Netlify.');
  console.error('Jalankan `netlify login`, atau set NETLIFY_AUTH_TOKEN.');
  process.exit(1);
}
console.log(`Token    : ${source}${user ? ` (${user})` : ''}`);

const headers = { Authorization: `Bearer ${token}` };

// ---------------------------------------------------------------------------
// Collect files
// ---------------------------------------------------------------------------
/** Walk a folder and return every file as { path, sha1, bytes }. */
function collect(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    // `.DS_Store` and friends would otherwise be published as real assets.
    if (entry === '.DS_Store' || entry === 'Thumbs.db') continue;

    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, base, out);
      continue;
    }
    const content = readFileSync(full);
    out.push({
      // Netlify expects POSIX separators with a leading slash.
      path: '/' + relative(base, full).split(sep).join(posix.sep),
      sha1: createHash('sha1').update(content).digest('hex'),
      bytes: content.length,
      content,
    });
  }
  return out;
}

const files = collect(folder);
if (files.length === 0) {
  console.error(`Tidak ada berkas di ${folder}`);
  process.exit(1);
}
console.log(`Berkas   : ${files.length} (${files.map((f) => f.path).join(', ')})`);

// ---------------------------------------------------------------------------
// Find or create the site
// ---------------------------------------------------------------------------
async function json(res, label) {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${label} gagal (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

let site = null;
const sites = await json(await fetch(`${API}/sites?per_page=100`, { headers }), 'Daftar situs');
site = sites.find((s) => s.name === siteName) || null;

if (site) {
  console.log(`Situs    : ${site.name} (sudah ada, id ${site.id})`);
} else {
  site = await json(
    await fetch(`${API}/sites`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: siteName }),
    }),
    'Buat situs'
  );
  console.log(`Situs    : ${site.name} (baru dibuat, id ${site.id})`);
}

// ---------------------------------------------------------------------------
// Create the deploy and upload what Netlify asks for
// ---------------------------------------------------------------------------
const digestMap = Object.fromEntries(files.map((f) => [f.path, f.sha1]));

const deploy = await json(
  await fetch(`${API}/sites/${site.id}/deploys`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: digestMap, draft: false }),
  }),
  'Buat deploy'
);

const required = new Set(deploy.required || []);
const toUpload = files.filter((f) => required.has(f.sha1));
console.log(`Deploy   : ${deploy.id}`);
console.log(`Upload   : ${toUpload.length} dari ${files.length} berkas (sisanya sudah ada di CDN Netlify)`);

for (const file of toUpload) {
  // The upload path drops the leading slash: /index.html -> index.html
  const res = await fetch(`${API}/deploys/${deploy.id}/files${file.path}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: file.content,
  });
  if (!res.ok) {
    throw new Error(`Upload ${file.path} gagal (HTTP ${res.status}): ${await res.text()}`);
  }
  console.log(`  ok  ${file.path} (${file.bytes} bytes)`);
}

// ---------------------------------------------------------------------------
// Wait for the deploy to become live
// ---------------------------------------------------------------------------
const deadline = Date.now() + 90_000;
let state = deploy.state;

while (state !== 'ready' && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  const current = await json(
    await fetch(`${API}/deploys/${deploy.id}`, { headers }),
    'Cek status deploy'
  );
  state = current.state;
  process.stdout.write(`\rStatus   : ${state}   `);
}

console.log('');
if (state !== 'ready') {
  console.error(`Deploy tidak selesai dalam batas waktu (status terakhir: ${state}).`);
  process.exit(1);
}

console.log('');
console.log(`URL      : ${site.ssl_url}`);
console.log(`Admin    : https://app.netlify.com/sites/${site.name}`);
