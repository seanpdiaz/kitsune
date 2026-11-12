import { createRoot } from 'react-dom/client';
import SettingsSearch, { revealFromHash } from './SettingsSearch.jsx';

// Loaded on every Settings page by public/js/nav.js (see loadSettingsSearch
// there), not by a <script> tag in each settings-*.html — one place to
// change instead of fourteen, the same reasoning nav.js already follows for
// the sidebar and page tabs.
//
// Mounted into the page's existing .top-row, between the "Settings" heading
// and the page's own Add button (if it has one), so it sits on the right
// next to that button without any page's HTML needing to know about it.
const topRow = document.querySelector('.main .top-row');
if (topRow && !document.getElementById('settingsSearchRoot')) {
  const mount = document.createElement('div');
  mount.id = 'settingsSearchRoot';
  const addBtnRoot = topRow.querySelector(':scope > span[id$="BtnRoot"]');
  topRow.insertBefore(mount, addBtnRoot || null);
  createRoot(mount).render(<SettingsSearch />);
}

revealFromHash();
window.addEventListener('hashchange', revealFromHash);
