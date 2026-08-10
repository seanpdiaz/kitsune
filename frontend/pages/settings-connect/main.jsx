import { createRoot } from 'react-dom/client';
import ConnectionManager from '../../components/ConnectionManager.jsx';

// Settings > Connect — a faithful port of the `initConnectionManager({
// section: 'connect', ... })` call at the bottom of
// public/js/pages/settings-connections.js. See ConnectionManager.jsx for the
// shared controller (also used by Indexers and Import Lists) — Pushover's
// `extra` fields are what make it the one real integration on this page
// (see README's "Connect: real Pushover notifications"); Slack/Plex/Gotify
// stay purely decorative, same as before.
const connectTypes = [
  { key: 'pushover', name: 'Pushover', protocol: 'API', meta: 'On Import', extra: { type: 'pushover', userKey: '', apiToken: '', priority: 0, notifyOnGrab: false, notifyOnImport: true, notifyOnFail: false } },
  { key: 'slack', name: 'Slack', protocol: 'Webhook', meta: 'On Import' },
  { key: 'plex', name: 'Plex', protocol: 'API', meta: 'On Import' },
  { key: 'gotify', name: 'Gotify', protocol: 'API', meta: 'On Import' },
];

const rootEl = document.getElementById('connectRoot');
const addBtnContainer = document.getElementById('addConnectBtnRoot');
if (rootEl) {
  createRoot(rootEl).render(
    <ConnectionManager
      section="connect"
      types={connectTypes}
      metaLabel="Triggers"
      priorityLabel="Events"
      addBtnLabel="Add connection"
      addBtnContainer={addBtnContainer}
    />,
  );
}
