/**
 * Loads `.env` for the scripts invoked with plain `node`.
 *
 * Bun reads `.env` on its own, so the `verify:*` suites already see it. The two
 * scripts that run under `node` — the Netlify deploy and the npm auth checker —
 * did not, which would have made `.env.example` a promise the tooling did not
 * keep: you copy it to `.env`, and nothing changes.
 *
 * `process.loadEnvFile` is Node 20.12+. On anything older this is a quiet no-op,
 * i.e. exactly the previous behaviour, rather than a hard failure.
 *
 * Import for the side effect, before reading any `process.env` value:
 *
 *   import './load-env.mjs';
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');

if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // A malformed .env must not block a deploy. The real problem surfaces a
    // moment later as "no token", which is a clearer error than a parse dump.
  }
}
