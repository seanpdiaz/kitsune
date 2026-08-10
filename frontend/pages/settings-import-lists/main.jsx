import { createRoot } from 'react-dom/client';
import ConnectionManager from '../../components/ConnectionManager.jsx';

// Settings > Import Lists — a faithful port of the `initConnectionManager({
// section: 'import-lists', ... })` call at the bottom of
// public/js/pages/settings-connections.js. See ConnectionManager.jsx for the
// shared controller (also used by Indexers and Connect).
const importListTypes = [
  { key: 'simkl', name: 'Simkl', protocol: 'Auto add', meta: '/anime/wanted' },
  { key: 'customrss', name: 'Custom RSS List', protocol: 'Auto add', meta: '/anime/wanted' },
  { key: 'imdb', name: 'IMDb List', protocol: 'Auto add', meta: '/anime/wanted' },
];

const rootEl = document.getElementById('importListsRoot');
const addBtnContainer = document.getElementById('addImportListBtnRoot');
if (rootEl) {
  createRoot(rootEl).render(
    <ConnectionManager
      section="import-lists"
      types={importListTypes}
      metaLabel="Root folder"
      priorityLabel="Profile"
      addBtnLabel="Add import list"
      addBtnContainer={addBtnContainer}
    />,
  );
}
