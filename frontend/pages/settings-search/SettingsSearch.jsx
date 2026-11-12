import { useEffect, useMemo, useRef, useState } from 'react';
import { SETTINGS_SEARCH_ENTRIES } from '../../lib/settingsSearchIndex.js';
import { icons } from '../../lib/icons.jsx';

// Settings search: one box in the top row of every Settings page that finds
// any setting on any Settings page (see frontend/lib/settingsSearchIndex.js
// for what's indexed and why it's a hand-written list). Picking a result
// opens that page with `#setting=<id>` in the URL; this same module, loaded
// on that page too, reads the hash, waits for the page's React content to
// render, then scrolls the matching row into view and briefly highlights it.
// A result on the page you're already on skips the reload and just jumps.
//
// Keyboard: "/" or Ctrl/Cmd+K focuses the box from anywhere on the page
// (unless you're typing in some other field), Up/Down moves through
// results, Enter opens the highlighted one, Escape clears then blurs.

const MAX_RESULTS = 10;
const CACHED_USER_KEY = 'kitsune-cached-user'; // written by public/js/nav.js

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function currentFile() {
  return location.pathname.split('/').pop() || 'index.html';
}

function readCachedRole() {
  try {
    const raw = sessionStorage.getItem(CACHED_USER_KEY);
    return raw ? JSON.parse(raw).role : null;
  } catch {
    return null;
  }
}

// Every term has to appear somewhere in the entry (name, card/section,
// page, keywords or description); the score then decides order. Matches in
// the setting's own name dominate, so "port" puts Port Number above every
// row that merely mentions a port in its description.
function scoreEntry(entry, query, terms) {
  const name = norm(entry.name);
  const section = norm(entry.section || entry.card);
  const page = norm(entry.pageLabel);
  const keywords = norm(entry.keywords);
  const sectionKeywords = norm(entry.sectionKeywords);
  const desc = norm(entry.desc);
  const hay = `${name} ${section} ${page} ${keywords} ${sectionKeywords} ${desc}`;
  if (!terms.every((t) => hay.includes(t))) return -1;

  let score = 0;
  if (name === query) score += 100;
  else if (name.startsWith(query)) score += 60;
  else if (name.includes(query)) score += 40;
  for (const t of terms) {
    if (name.includes(t)) score += new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name) ? 14 : 8;
    else if (keywords.split(' ').some((k) => k.startsWith(t))) score += 9;
    else if (section.includes(t)) score += 6;
    else if (page.includes(t)) score += 5;
    else if (sectionKeywords.split(' ').some((k) => k.startsWith(t))) score += 3;
    else score += 1; // description only
  }
  // Prefer a specific row over its card, and a card over the whole page,
  // when they tie.
  if (entry.kind === 'field') score += 2;
  else if (entry.kind === 'section') score += 1;
  // And a result on the page you're already on over an equal one elsewhere.
  if (entry.file === currentFile()) score += 3;
  return score;
}

function search(query, isAdmin) {
  const q = norm(query);
  if (!q) return [];
  const terms = q.split(' ').filter(Boolean);
  return SETTINGS_SEARCH_ENTRIES
    .filter((e) => !e.admin || isAdmin)
    .map((e) => ({ entry: e, score: scoreEntry(e, q, terms) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, MAX_RESULTS)
    .map((r) => r.entry);
}

function Highlight({ text, terms }) {
  if (!terms.length) return text;
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return String(text).split(pattern).map((part, i) => (
    i % 2 === 1 ? <mark key={i}>{part}</mark> : part
  ));
}

function breadcrumb(entry) {
  const parts = ['Settings', entry.pageLabel];
  if (entry.section && entry.section !== entry.name) parts.push(entry.section);
  return parts.join(' › ');
}

// ---------- Locating a result on its page ----------

function isVisible(el) {
  return !!(el && el.getClientRects().length);
}

function findCard(root, title) {
  const want = norm(title);
  return [...root.querySelectorAll('.settings-card')].find((card) => {
    const h2 = card.querySelector(':scope > h2');
    if (h2) return norm(h2.textContent) === want;
    // Metadata's cards have no <h2> — the section name is their first row's
    // own field name instead.
    const first = card.querySelector('.field-label .name');
    return first && norm(first.textContent) === want;
  }) || null;
}

// Returns { exact, fallback }: `exact` is the row itself; `fallback` is the
// best thing to point at when the row isn't on screen (its card, collapsed
// behind a toggle that's off, or still loading).
function locate(entry) {
  const root = document.querySelector('.main') || document.body;
  const card = entry.card ? findCard(root, entry.card) : null;
  if (entry.kind === 'section') return { exact: isVisible(card) ? card : null, fallback: null };
  if (entry.kind !== 'field') return { exact: null, fallback: null };

  const scope = card || root;
  const want = norm(entry.name);
  const candidates = [...scope.querySelectorAll('.field-label .name, .check-row, .quality-toolbar-field label')]
    .filter((el) => norm(el.textContent) === want && isVisible(el));
  const hit = candidates[0];
  const exact = hit ? (hit.closest('.form-row, .check-row, .quality-toolbar-field') || hit) : null;
  // A card that holds only the row itself (Metadata's provider toggle) is
  // fine to fall back to as well.
  return { exact, fallback: isVisible(card) ? card : null };
}

function flash(el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('settings-search-flash');
  // Restart the animation if the same row is picked twice in a row.
  void el.offsetWidth;
  el.classList.add('settings-search-flash');
  setTimeout(() => el.classList.remove('settings-search-flash'), 2600);
  const focusable = el.querySelector('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
  if (focusable) focusable.focus({ preventScroll: true });
}

// The page's content renders after its own bundle runs and, usually, after
// its settings GET resolves — so watch the DOM until the row shows up. If
// only the card turns up (row hidden behind an off toggle), wait a little
// longer in case the real row is still on its way, then settle for the card.
function revealWhenReady(entry) {
  if (entry.kind === 'page') {
    window.scrollTo({ top: 0 });
    return;
  }
  const HARD_TIMEOUT_MS = 6000;
  const FALLBACK_GRACE_MS = 900;
  const start = Date.now();
  let fallbackSince = null;
  let done = false;

  const finish = (el) => {
    if (done) return;
    done = true;
    observer.disconnect();
    clearInterval(timer);
    if (el) flash(el);
  };

  const check = () => {
    const { exact, fallback } = locate(entry);
    if (exact) return finish(exact);
    if (fallback && fallbackSince === null) fallbackSince = Date.now();
    const elapsed = Date.now() - start;
    if (fallback && Date.now() - fallbackSince >= FALLBACK_GRACE_MS) return finish(fallback);
    if (elapsed >= HARD_TIMEOUT_MS) return finish(fallback);
    return undefined;
  };

  const observer = new MutationObserver(check);
  observer.observe(document.querySelector('.main') || document.body, { childList: true, subtree: true });
  // The grace/timeout checks need a clock even when nothing in the DOM is
  // changing any more.
  const timer = setInterval(check, 200);
  check();
}

export function revealFromHash() {
  const match = location.hash.match(/^#setting=(.+)$/);
  if (!match) return;
  const id = decodeURIComponent(match[1]);
  // Drop the hash so a reload or a copied URL doesn't keep re-jumping.
  history.replaceState(null, '', location.pathname + location.search);
  const entry = SETTINGS_SEARCH_ENTRIES.find((e) => e.id === id);
  if (entry && entry.file === currentFile()) revealWhenReady(entry);
}

// ---------- Admin check ----------

// The cached role (nav.js's sessionStorage copy) is right almost every time;
// confirm it once so a role change since then is respected. Only affects
// whether Security/Users show (as results here, as tiles on the Settings home
// page) — those pages enforce admin server-side either way.
export function useIsAdmin() {
  const [isAdmin, setIsAdmin] = useState(() => readCachedRole() === 'admin');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/state')
      .then((r) => r.json())
      .then((s) => { if (!cancelled && s && s.user) setIsAdmin(s.user.role === 'admin'); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return isAdmin;
}

// ---------- The search box ----------

// `variant="hero"` is the big centered box on the Settings home page
// (frontend/pages/settings-hub/); the default is the compact one in every
// Settings page's top row. Same search, same keyboard shortcuts either way.
export default function SettingsSearch({ variant = 'compact', autoFocus = false }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const isAdmin = useIsAdmin();
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const listRef = useRef(null);

  // Hero box: focus on load so you can just start typing — but not on a
  // phone-sized screen, where it would pop the keyboard over the grid.
  useEffect(() => {
    if (autoFocus && !window.matchMedia('(max-width: 860px)').matches) inputRef.current?.focus();
  }, [autoFocus]);

  const results = useMemo(() => search(query, isAdmin), [query, isAdmin]);
  const terms = useMemo(() => norm(query).split(' ').filter(Boolean), [query]);

  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    const item = listRef.current && listRef.current.querySelector(`[data-index="${active}"]`);
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // "/" and Ctrl/Cmd+K focus the box.
  useEffect(() => {
    function onKey(e) {
      const t = e.target;
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  function hrefFor(entry) {
    // Modal/list-only results have nothing on the page to jump to.
    return entry.kind === 'page'
      ? entry.file
      : `${entry.file}#setting=${encodeURIComponent(entry.id)}`;
  }

  function go(entry, e) {
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) return; // let the browser open a new tab
    if (e) e.preventDefault();
    setOpen(false);
    inputRef.current?.blur();
    if (entry.file === currentFile()) {
      revealWhenReady(entry);
    } else {
      window.location.href = hrefFor(entry);
    }
  }

  function onInputKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (results[active]) go(results[active], e);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (query) setQuery('');
      else inputRef.current?.blur();
    }
  }

  const showPanel = open && norm(query).length > 0;

  return (
    <div className={`settings-search${variant === 'hero' ? ' settings-search-hero' : ''}`} ref={wrapRef}>
      <div className="search-box">
        {icons.search}
        <input
          ref={inputRef}
          type="text"
          placeholder={variant === 'hero' ? 'Search all settings — try “sso”, “proxy” or “naming”' : 'Search all settings'}
          aria-label="Search all settings"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="settingsSearchResults"
          aria-activedescendant={showPanel && results[active] ? `settings-search-opt-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onInputKey}
        />
        {!query && <kbd className="settings-search-kbd" aria-hidden="true">/</kbd>}
      </div>

      {showPanel && (
        <div className="settings-search-panel" id="settingsSearchResults" role="listbox" ref={listRef}>
          {results.length === 0 ? (
            <p className="settings-search-empty">No settings match “{query.trim()}”.</p>
          ) : results.map((entry, i) => (
            <a
              key={entry.id}
              id={`settings-search-opt-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              className={`settings-search-result${i === active ? ' is-active' : ''}`}
              href={hrefFor(entry)}
              onMouseEnter={() => setActive(i)}
              onClick={(e) => go(entry, e)}
            >
              <span className="settings-search-name"><Highlight text={entry.name} terms={terms} /></span>
              <span className="settings-search-path">{breadcrumb(entry)}</span>
              {entry.desc && <span className="settings-search-desc">{entry.desc}</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
