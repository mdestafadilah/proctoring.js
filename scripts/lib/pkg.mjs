/**
 * The release version, read once from package.json.
 *
 * The browser suites assert the version the *shipped bundle* reports. Reading
 * the expectation from package.json instead of writing a literal keeps those
 * assertions meaningful: a `dist/` built before the bump, or a `src/index.js`
 * left behind, still fails. A literal only ever tested itself.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const pkg = JSON.parse(
  readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8')
);

export const version = pkg.version;
