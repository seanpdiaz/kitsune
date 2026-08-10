import { createRoot } from 'react-dom/client';
import ConnectionManager from '../../components/ConnectionManager.jsx';

// Settings > Indexers — a faithful port of the `initConnectionManager({
// section: 'indexers', ... })` call at the bottom of
// public/js/pages/settings-connections.js. See ConnectionManager.jsx for the
// shared controller (also used by Import Lists and Connect).
const indexerTypes = [
  { key: 'tokyotosho', name: 'TokyoTosho', protocol: 'Torrent', meta: 'Anime' },
  { key: 'anirena', name: 'Anirena', protocol: 'Torrent', meta: 'Anime' },
  { key: 'shanaproject', name: 'Shana Project', protocol: 'Torrent', meta: 'Anime (RSS)' },
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
