import { createRoot } from 'react-dom/client';
import UiPage from './UiPage.jsx';

const rootEl = document.getElementById('uiRoot');
if (rootEl) {
  createRoot(rootEl).render(<UiPage />);
}
