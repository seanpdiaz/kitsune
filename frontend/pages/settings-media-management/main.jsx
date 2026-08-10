import { createRoot } from 'react-dom/client';
import MediaManagementPage from './MediaManagementPage.jsx';

const rootEl = document.getElementById('mediaManagementRoot');
if (rootEl) {
  createRoot(rootEl).render(<MediaManagementPage />);
}
