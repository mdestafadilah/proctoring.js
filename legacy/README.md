# legacy/ — the original vanilla-JS prototype

This folder is a **frozen snapshot** of the first attempt at `proctoring.js`,
kept only for the record. It is not built, not tested, and not published.

## What it is

A plain Vite + vanilla JavaScript app — the Vite starter page, kept as-is — titled
"Proctoring App with Vite.JS Bundling". No framework, no config of its own beyond
`index.html` and `main.js`.

The interesting part is `modules/`: one file per idea, and every one of them is
the direct ancestor of a detector in the current library.

| File | What it did | Became |
| --- | --- | --- |
| `modules/tabs.js` | `vis()` — tab visibility via `visibilitychange` | `tabs` detector |
| `modules/kamera.js` | camera on/off through `getUserMedia`, status written to `localStorage` | `camera` detector |
| `modules/muka.js` | face-api sketch, copied from a dev.to article | `face` detector |
| `modules/suara.js` | empty — a single `// TODO` | `audio` detector |

`main.js` wires up `tabs.js` only; the `kamera.js` import is commented out.

## Why it is here

This prototype is where the repository started. It was never committed while it
was alive — it sat in the working tree during the rewrite — so without this folder
the project's own origin would be unreadable.

It is kept in a folder rather than at the root because its `index.html` loads
`/main.js`: Vite's dev server defaults its root to the project directory, so a
root-level `index.html` would shadow the library's own entry and break
`npm run dev`.

## What it is not

- **Not a starting point.** The current library shares no code with it. The
  architecture, the detector contract, and the public API were all designed from
  scratch in `src/`.
- **Not runnable as-is.** Dependencies are not installed and the pins are stale
  (`@tensorflow/tfjs@^4.17.0`, `@vladmandic/face-api@^1.7.13`). Two files show how
  unfinished it was: `modules/muka.js` calls `tf.setBackend("tensofflow")` — a
  typo, so that path could never have run — and `modules/suara.js` is empty even
  though `whistle-detection` is listed as a dependency.
- **Not shipped.** `package.json#files` allows only `dist/`, `README.md`, and
  `LICENSE` into the npm tarball, and `.npmignore` excludes `legacy/` as well.

`models/` holds face-api weights. They are byte-identical to the root `models/`
folder, so git stores a single copy of each blob and the object store does not
grow.

## If you want to run it

Treat it as a standalone app: copy the folder somewhere outside the repository,
then `npm install && npm run dev`. Expect to update the dependencies first — the
face-api and TensorFlow.js versions pinned here predate the CDN-based provider the
library now uses (see "Face detection setup" in the root `README.md`).

## Earlier snapshots

The generation that replaced the vanilla code here is still readable in git
history but is no longer in the working tree: `a620a2d` and `e37dcb9` hold the
Preact + face-api scratch app, and this folder carried a copy of it until the
vanilla snapshot was restored in its place.

The vanilla files themselves were never committed while they were alive — they
were only ever a working tree — so this folder is their first appearance in the
repository's history.
