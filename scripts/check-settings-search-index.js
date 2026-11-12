#!/usr/bin/env node
// Warns about Settings labels that the Settings search can't find.
//
// The search index (frontend/lib/settingsSearchIndex.js) is hand-written,
// so it can drift: someone adds a FormRow to a Settings page and doesn't
// add it there. This scans every Settings page (and the shared components
// they're built from) for literal setting labels — FormRow name="…",
// SettingsCard title="…", FieldRow label="…", fieldRow('…', …) and
// <p className="name">…</p> — and lists any that don't appear in the index.
//
// Runs as part of `npm run build`. Warn-only on purpose: it never fails the
// build, since a label that's deliberately not worth searching for (or one
// built from a variable, which this can't see anyway) shouldn't block a
// release. Pass --strict to exit non-zero instead, e.g. in CI.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const indexFile = path.join(root, 'frontend/lib/settingsSearchIndex.js');
const pagesDir = path.join(root, 'frontend/pages');
const sharedComponents = ['ConnectionManager.jsx', 'RootFolders.jsx'].map((f) => path.join(root, 'frontend/components', f));

// Labels a page renders that are deliberately not their own search result.
// Keep this short — most things belong in the index.
const IGNORE = new Set([]);

const PATTERNS = [
  /<FormRow\b[^>]*?\bname="([^"]+)"/gs,
  /<SettingsCard\b[^>]*?\btitle="([^"]+)"/gs,
  /<FieldRow\b[^>]*?\blabel="([^"]+)"/gs,
  /\bfieldRow\(\s*'([^']+)'/g,
  /<p className="name">([^<{]+)<\/p>/g,
];

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function settingsFiles() {
  const files = [...sharedComponents];
  for (const dir of fs.readdirSync(pagesDir)) {
    if (!dir.startsWith('settings-') || dir === 'settings-search') continue;
    for (const f of fs.readdirSync(path.join(pagesDir, dir))) {
      if (f.endsWith('.jsx')) files.push(path.join(pagesDir, dir, f));
    }
  }
  return files;
}

const index = fs.readFileSync(indexFile, 'utf8');
const inIndex = (label) => [`'${label}'`, `"${label}"`, `'${label.replace(/'/g, "\\'")}'`].some((q) => index.includes(q));

const missing = [];
for (const file of settingsFiles()) {
  const src = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  for (const re of PATTERNS) {
    for (const m of src.matchAll(re)) {
      const label = decode(m[1]);
      if (!label || seen.has(label) || IGNORE.has(label)) continue;
      seen.add(label);
      if (!inIndex(label)) missing.push(`${path.relative(root, file)}: "${label}"`);
    }
  }
}

if (missing.length) {
  console.warn(`\n[settings search] ${missing.length} Settings label(s) aren't in frontend/lib/settingsSearchIndex.js, so search can't find them:`);
  for (const m of missing) console.warn(`  - ${m}`);
  console.warn('');
  if (process.argv.includes('--strict')) process.exit(1);
} else {
  console.log('[settings search] index covers every Settings label.');
}
