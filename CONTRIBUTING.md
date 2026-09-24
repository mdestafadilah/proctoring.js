# Contributing

Maintainer notes for `proctoring.js`. User-facing documentation lives in
[`README.md`](./README.md); this file covers building, verifying and releasing.

## Ground rules

- **Zero runtime dependencies.** This is a hard rule, not a preference. New
  capabilities come from browser APIs or a lazy CDN load — never a new entry in
  `dependencies`. Raise it for discussion before adding one.
- **Code and comments in English.** Error messages too: this is a public package
  used across countries.
- **Comments explain _why_, not _what_.** Every non-obvious decision gets a short
  reason next to it. A comment that restates the code is noise.
- **JSDoc on every public API.**
- **Event names and violation types are wire format.** Renaming or removing one
  breaks every backend that consumes it, so it needs a major bump.

## Layout

| Path | What it is |
|---|---|
| `src/core/` | The orchestrator, options, transport, store, screenshot helpers |
| `src/detectors/` | One file per capability, plus `index.js` — the registry |
| `scripts/` | Verification suites and tooling. **Not published.** |
| `scripts/lib/expected-detectors.mjs` | The single source for the detector-name list every suite asserts against |

Adding a capability means one detector file plus one registry entry — the
`Proctor` class never learns about concrete detectors. Detectors do not talk to
each other; they communicate through the `context` object.

## Development

```bash
npm install
npm run dev          # demo page at http://localhost:5173/demo.html
npm run build        # emits dist/proctoring.js, .cjs, .umd.js and index.d.ts
```

`dist/` is **gitignored** — commits contain source only.

## Verification

Nothing is "done" because it was edited. Run the gate.

```bash
npm test                          # build + 163 checks against dist/
bun scripts/verify-browser.mjs    # 72, needs the dev server on :5180
bun scripts/verify-umd.mjs        # 6
bun scripts/verify-face.mjs       # 7
```

The browser suites need the dev server:

```bash
npx vite --port 5180 --strictPort
```

**Run these as separate commands.** Chaining all four in one shell exceeds the
tool timeout and the browser suite gets killed mid-run, which reads as a failure.

The suites verify **`dist/`**, not `src/`, so a build regression is caught here
rather than in a consumer's app. Two things cannot be proven in Node and are
always checked in a real browser: that detectors attach to genuine DOM events,
and that real input (a physical right-click, a real `Ctrl+Shift+V`) produces
exactly one violation.

`verify:static` (12 checks) is excluded from the gate above because it loads the
demo's **pinned CDN bundle** — it cannot pass until that version is published. It
is the last step of a release.

## Releasing

Publishing is irreversible and public. Run the whole flow.

### 1. Decide the bump

| Change | Bump |
|---|---|
| New detector, new option, new public API | minor |
| Behaviour fix, docs correction | patch |
| Renamed or removed event / violation type | major |

**`README.md` and `LICENSE` ship inside the tarball**, so a documentation fix
needs a patch release or the README on npm keeps disagreeing with the repo.
Confirm the drift first:

```bash
npm pack proctoring.js@<published> && tar -xzf proctoring.js-<published>.tgz
diff package/README.md README.md
```

`scripts/` and this file are not published, so changes there never need a release.
Adding an entry to `package.json` `scripts` **does**, because `package.json` ships.

### 2. Bump in all four places

```bash
npm version <patch|minor|major> --no-git-tag-version
```

`npm version` handles `package.json` and both spots in `package-lock.json`. Two
places are **manual** and easy to miss:

- `src/index.js` — `export const version = '...'`
- `netlify-demo/index.html` — the CDN pin `proctoring.js@<version>`

The repo uses no git tags.

### 3. Commit, push, publish

A version-only change gets its own `chore(release): <version>` commit. A new
detector carries the bump inside its feature commit instead.

```bash
npm publish
```

**`npm publish` may answer `PUT ... 202` rather than `201` and still succeed.**
"Your package is being processed" is literal. Confirm via `dist-tags`, never via
the version endpoint — `https://registry.npmjs.org/proctoring.js/<version>`
serves a **stale 404 for hours** after a good publish, while `dist-tags.latest`
flips within about a minute.

### 4. Purge the CDN, then prove the artifacts

The registry updates in ~30s; jsDelivr stays 404 until purged, per file:

```bash
for f in index.d.ts proctoring.cjs proctoring.cjs.map proctoring.js \
         proctoring.js.map proctoring.umd.js proctoring.umd.js.map; do
  curl -s "https://purge.jsdelivr.net/npm/proctoring.js@<version>/dist/$f"
done
```

Then compare what the CDN serves against `dist/`:

```bash
bun scripts/verify-cdn.mjs          # or: bun scripts/verify-cdn.mjs <older version>
```

**Do not hand-roll this with `curl | sha256sum`.** When a file is not there yet,
jsDelivr answers `404` with a 50-byte text body, and hashing that body reports
`MISMATCH` — indistinguishable from a corrupted artifact. Always check the HTTP
status before the hash. That is exactly why the script exists.

jsDelivr also **propagates in stages**: its per-file cache and its version list
update separately, so just after a purge some files are 200 while others still
404 for 30–60s. Retry; do not rebuild.

### 5. Deploy the demo and verify it live

```bash
npm run deploy:demo
DEMO_URL=https://proctoring-js-demo.netlify.app bun scripts/verify-static-demo.mjs
```

Deploying is not proof that it works — this is. It loads the real CDN bundle in a
real browser, drives a real session, and asserts the demo pins the current
version, so a stale pin is caught instead of silently proving the wrong bundle.

## Commits

Conventional Commits, Indonesian description, no scope, imperative mood.

```
feat: deteksi copy/paste untuk 0.5.0
fix(scripts): perbaiki diagnosis token npm
chore(release): 0.5.1
```

`dist/` is never committed.
