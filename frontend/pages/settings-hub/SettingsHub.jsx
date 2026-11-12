import { SETTINGS_PAGES } from '../../lib/settingsSearchIndex.js';
import SettingsSearch, { useIsAdmin } from '../settings-search/SettingsSearch.jsx';

// Settings home (settings.html): what the sidebar's single "Settings" link
// opens. A big centered search box — the same search every Settings page has
// in its top row (frontend/pages/settings-search/), just front and center —
// above a grid of tiles, one per Settings page.
//
// The tiles come from SETTINGS_PAGES in frontend/lib/settingsSearchIndex.js,
// the same list the search is built from, so a new Settings page only needs
// adding there (plus an icon below) to get both its tile and its results.
// Security and Users only show for admins, as they did in the sidebar.

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

const PAGE_ICONS = {
  'settings-media-management.html': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 13h8"/>',
  'settings-profiles.html': '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  'settings-quality.html': '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-5"/><circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
  'settings-custom-formats.html': '<path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 3-2 3 1 0 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 3 2 3-1 0-2 1.5-2 3v2c0 2-1 3-3 3"/>',
  'settings-indexers.html': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  'settings-download-clients.html': '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  'settings-import-lists.html': '<path d="M4 6h11M4 12h11M4 18h7M18 15v6M15 18h6"/>',
  'settings-connect.html': '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  'settings-metadata.html': '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  'settings-tags.html': '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  'settings-general.html': '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"/>',
  'settings-security.html': '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  'settings-ui.html': '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A4.7 4.7 0 0 0 21 9.7C21 5.9 17 3 12 3z"/><circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="7" r="1" fill="currentColor" stroke="none"/>',
  'settings-users.html': '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.5 3.5 5.2"/>',
};
// A page added to the index before anyone draws it an icon still gets a tile.
const FALLBACK_ICON = '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6"/>';

function TileIcon({ file }) {
  const inner = PAGE_ICONS[file] || FALLBACK_ICON;
  return <span className="settings-tile-icon" dangerouslySetInnerHTML={{ __html: `<svg ${SVG_ATTRS}>${inner}</svg>` }} />;
}

export default function SettingsHub() {
  const isAdmin = useIsAdmin();
  const pages = SETTINGS_PAGES.filter((p) => !p.admin || isAdmin);

  return (
    <>
      <section className="settings-hub-search">
        <SettingsSearch variant="hero" autoFocus />
        <p className="settings-hub-hint">
          Press <kbd>/</kbd> or <kbd>Ctrl</kbd>+<kbd>K</kbd> on any Settings page to search.
        </p>
      </section>

      <nav className="settings-tile-grid" aria-label="Settings sections">
        {pages.map((p) => (
          <a key={p.file} className="settings-tile" href={p.file}>
            <TileIcon file={p.file} />
            <span className="settings-tile-text">
              <span className="settings-tile-title">
                {p.label}
                {p.admin && <span className="settings-tile-badge">Admin</span>}
              </span>
              <span className="settings-tile-desc">{p.desc}</span>
            </span>
          </a>
        ))}
      </nav>
    </>
  );
}
