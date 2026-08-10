import { createRoot } from 'react-dom/client';
import GeneralPage from './GeneralPage.jsx';

const rootEl = document.getElementById('generalRoot');
if (rootEl) {
  createRoot(rootEl).render(<GeneralPage />);
}
