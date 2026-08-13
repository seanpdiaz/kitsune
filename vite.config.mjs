import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Kitsune's frontend is migrating from plain JS (public/js/) to React, one
// page at a time — see README's "React migration" section for the reasoning
// and the overall plan. This is the build config for whichever pages have
// already been migrated; as of this file, that's just System > Tasks.
//
// Deliberately NOT a single-page-app build. Each migrated page keeps its own
// real .html file, server.js keeps serving every page exactly the way it
// always has (this just adds new static files under public/dist/ for it to
// serve — no server.js changes at all), and the shared sidebar/page-tabs
// (public/js/nav.js) stay untouched plain JS shared by every page, migrated
// or not. Each entry below mounts a small React root into one specific
// <div id="..."> on its one page — the exact same "one shared script, every
// page loads all of it, individual modules no-op on other pages" shape
// public/app.js already uses, just per-entry-point instead of per-module-
// import, since Vite bundles each entry separately rather than one shared
// file every page has to load in full.
//
// Add a new `<page-name>: resolve(...)` entry here, plus a
// `frontend/pages/<page-name>/` directory, each time another page migrates.
// ---------------------------------------------------------------------------
export default defineConfig({
  plugins: [react()],
  // Vite's own convention treats a top-level `public/` directory as assets
  // to copy verbatim into the build output — a totally different, unrelated
  // meaning from this project's own pre-existing `public/`, which is
  // server.js's entire static-file root (every .html page, styles.css, and
  // every not-yet-migrated page's plain JS module). Leaving Vite's default
  // enabled meant a `vite build` copied that entire existing directory into
  // public/dist/ as a side effect, nesting a confusing full duplicate of the
  // whole site inside its own build output. Disabled outright — this build
  // only ever needs to emit the one migrated page's bundle, nothing else.
  publicDir: false,
  build: {
    outDir: 'public/dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'system-tasks': resolve(process.cwd(), 'frontend/pages/system-tasks/main.jsx'),
        'system-status': resolve(process.cwd(), 'frontend/pages/system-status/main.jsx'),
        'system-backup': resolve(process.cwd(), 'frontend/pages/system-backup/main.jsx'),
        'system-events': resolve(process.cwd(), 'frontend/pages/system-events/main.jsx'),
        'system-logs': resolve(process.cwd(), 'frontend/pages/system-logs/main.jsx'),
        'activity-queue': resolve(process.cwd(), 'frontend/pages/activity-queue/main.jsx'),
        'activity-history': resolve(process.cwd(), 'frontend/pages/activity-history/main.jsx'),
        'activity-blocklist': resolve(process.cwd(), 'frontend/pages/activity-blocklist/main.jsx'),
        'wanted-missing': resolve(process.cwd(), 'frontend/pages/wanted-missing/main.jsx'),
        'wanted-cutoff-unmet': resolve(process.cwd(), 'frontend/pages/wanted-cutoff-unmet/main.jsx'),
        'calendar': resolve(process.cwd(), 'frontend/pages/calendar/main.jsx'),
        'settings-indexers': resolve(process.cwd(), 'frontend/pages/settings-indexers/main.jsx'),
        'settings-import-lists': resolve(process.cwd(), 'frontend/pages/settings-import-lists/main.jsx'),
        'settings-connect': resolve(process.cwd(), 'frontend/pages/settings-connect/main.jsx'),
        'settings-download-clients': resolve(process.cwd(), 'frontend/pages/settings-download-clients/main.jsx'),
        'settings-profiles': resolve(process.cwd(), 'frontend/pages/settings-profiles/main.jsx'),
        'settings-custom-formats': resolve(process.cwd(), 'frontend/pages/settings-custom-formats/main.jsx'),
        'settings-tags': resolve(process.cwd(), 'frontend/pages/settings-tags/main.jsx'),
        'settings-quality': resolve(process.cwd(), 'frontend/pages/settings-quality/main.jsx'),
        'settings-media-management': resolve(process.cwd(), 'frontend/pages/settings-media-management/main.jsx'),
        'settings-general': resolve(process.cwd(), 'frontend/pages/settings-general/main.jsx'),
        'settings-ui': resolve(process.cwd(), 'frontend/pages/settings-ui/main.jsx'),
        'library-add-new': resolve(process.cwd(), 'frontend/pages/library-add-new/main.jsx'),
        'library-import': resolve(process.cwd(), 'frontend/pages/library-import/main.jsx'),
        // Named 'library-grid', not 'index' (index.html's own page) — an
        // entry key of 'index' collides with the auto-generated shared-chunk
        // name Rollup already produces for this build (see public/dist/
        // index.js — a vendor chunk, not tied to any one entry point).
        // index.html's <script src="dist/library-grid.js"> just points at
        // this entry key instead; nothing else needs the names to match.
        'library-grid': resolve(process.cwd(), 'frontend/pages/library-grid/main.jsx'),
        'series': resolve(process.cwd(), 'frontend/pages/series/main.jsx'),
        'settings-metadata': resolve(process.cwd(), 'frontend/pages/settings-metadata/main.jsx'),
        'login': resolve(process.cwd(), 'frontend/pages/login/main.jsx'),
        'settings-users': resolve(process.cwd(), 'frontend/pages/settings-users/main.jsx'),
        'account': resolve(process.cwd(), 'frontend/pages/account/main.jsx'),
      },
      output: {
        // Vite's default output filenames include a content hash
        // (system-tasks-i16X5hWF.js) for cache-busting — but this app
        // already cache-busts every static file a different way: server.js
        // sends `Cache-Control: no-cache` on everything under public/,
        // forcing a revalidation request on every load regardless of
        // filename (see server.js's comment on that header for why). A
        // hashed filename here would just mean each page's <script src="...">
        // has to be kept in sync with whatever hash the last build
        // happened to produce — stable, predictable names instead, so
        // system-tasks.html's `dist/system-tasks.js` reference never goes
        // stale no matter how many times this gets rebuilt.
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});
