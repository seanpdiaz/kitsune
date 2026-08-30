import { createRoot } from 'react-dom/client';
import ConnectionManager from '../../components/ConnectionManager.jsx';

// Settings > Indexers — a faithful port of the `initConnectionManager({
// section: 'indexers', ... })` call at the bottom of
// public/js/pages/settings-connections.js. See ConnectionManager.jsx for the
// shared controller (also used by Import Lists and Connect). Prowlarr's
// `extra` fields are what make it a second real integration here (alongside
// Nyaa.si — see server/lib/prowlarr-search.js): a Prowlarr instance can
// itself proxy Nyaa.si plus any number of other trackers a user has
// configured there, so enabling both isn't redundant — routes/releases.js
// merges results from whichever real indexers are on, deduping the same
// torrent if it comes back from both.
const indexerTypes = [
  // The one real, no-config-needed indexer this app talks to directly (see
  // server/lib/nyaa-search.js) — same role `type: 'nyaa'` already plays on
  // the seeded default row (server/routes/settings-items.js's
  // LIST_SECTION_SEEDS), just missing from here until now. Without an entry
  // in this list, a Kitsune instance that ever lost its seeded Nyaa.si row
  // (deleted by hand, or a database that predates the seed) had no way to
  // add it back — Settings > Indexers' own real Test button, and every
  // search route, already treated 'nyaa' as equally real as 'prowlarr', but
  // "Add indexer" itself never offered it. No `extra` config fields needed
  // (unlike Prowlarr's baseUrl/apiKey) since Nyaa.si's RSS endpoint needs no
  // account or URL to point at.
  { key: 'nyaa', name: 'Nyaa.si', protocol: 'Torrent', meta: 'Anime', extra: { type: 'nyaa' } },
  { key: 'tokyotosho', name: 'TokyoTosho', protocol: 'Torrent', meta: 'Anime' },
  { key: 'anirena', name: 'Anirena', protocol: 'Torrent', meta: 'Anime' },
  { key: 'shanaproject', name: 'Shana Project', protocol: 'Torrent', meta: 'Anime (RSS)' },
  { key: 'prowlarr', name: 'Prowlarr', protocol: 'API', meta: 'All configured trackers', extra: { type: 'prowlarr', baseUrl: '', apiKey: '', allowInsecureSsl: false } },
];

const rootEl = document.getElementById('indexersRoot');
const addBtnContainer = document.getElementById('addIndexerBtnRoot');
if (rootEl) {
  createRoot(rootEl).render(
    <ConnectionManager
      section="indexers"
      types={indexerTypes}
      metaLabel="Categories"
      priorityLabel="Priority"
      addBtnLabel="Add indexer"
      addBtnContainer={addBtnContainer}
    />,
  );
}
