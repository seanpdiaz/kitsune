import { createRoot } from 'react-dom/client';
import SettingsHub from './SettingsHub.jsx';

// settings.html — the Settings home page the sidebar's "Settings" link opens.
const root = document.getElementById('settingsHubRoot');
if (root) createRoot(root).render(<SettingsHub />);
