# legacy/ — the original Preact prototype

This folder is a **frozen snapshot** of the first attempt at `proctoring.js`,
kept only for the record. It is not built, not tested, and not published.

## What it is

A Preact + `@vladmandic/face-api` + TensorFlow.js scratch app, written from
[Using face-api in Node.js](https://dev.to/kvntzn/using-face-api-in-nodejs-38aj).
Its `package.json` already carried the name `proctoring.js` (version `0.0.0`,
`private: true`) — this was the same project, before the rewrite.

Roughly 5 KB of real source (`src/app.jsx` is ~1 KB); the rest of the folder's
weight is a 77 KB `yarn.lock`.

## Why it is here

The prototype lived in this repository's earlier history, which was unrelated
to the current library's history (two independent root commits). When the two
histories were joined, discarding these files outright would have made the
repository's own past unreadable. They are kept in a folder rather than at the
root so that they cannot be mistaken for live code — the prototype's
`index.html` loaded `/src/main.jsx`, which would have collided with the
library's own `src/` tree and broken `npm run dev`.

The files are byte-identical to the tree of the commit that introduced this
folder's history. Nothing was rewritten or cleaned up.

## What it is not

- **Not a starting point.** The current library shares no code with it. The
  architecture, the detector contract, and the public API were all designed
  from scratch in `src/`.
- **Not runnable as-is.** Its own `package.json` and `vite.config.js` are here,
  but the dependencies are not installed and the pinned versions are long
  stale. `npm install` inside this folder is not supported.
- **Not shipped.** `package.json#files` allows only `dist/`, `README.md`, and
  `LICENSE` into the npm tarball, and `.npmignore` excludes `legacy/` as well.

## If you want to run it

Treat it as a standalone app: copy the folder somewhere outside the repository,
then `yarn install && yarn dev`. Expect to update the dependencies first — the
face-api and TensorFlow.js versions pinned here predate the CDN-based provider
the library now uses (see "Face detection setup" in the root `README.md`).
