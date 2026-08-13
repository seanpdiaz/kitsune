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
