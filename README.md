# Kitsune

A click-through mockup of the Kitsune Library dashboard, Series detail, Settings, and
System screens. The backend is pure Node (no Express, no npm dependencies of its own —
the one exception is SQLite, which comes built into Node itself) so it runs anywhere Node
22.5+ runs. The frontend is fully React now, migrated page by page (see the wiki).

## Run it

```
npm install
npm run build   # compiles the React frontend into public/dist/
node server.js
```

Then open http://localhost:3000

`npm run build` only needs to be re-run when something under `frontend/` changes.
`npm run dev:frontend` runs the same build in watch mode.

## Documentation

The full technical write-up — architecture, every feature's design decisions, bugs found
and fixed, and how each was verified — lives in the [wiki](https://github.com/seanpdiaz/kitsune/wiki)
rather than this file, since it's grown too large for a single README. A copy of the wiki's
source also lives in this repo under [`wiki/`](wiki/Home.md) (that's what gets pushed to
GitHub's wiki repo — see `wiki/Home.md` for the page index if you're browsing the raw
Markdown instead of the hosted wiki).
