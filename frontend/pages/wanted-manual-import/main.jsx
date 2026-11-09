import { createRoot } from 'react-dom/client';
import ManualImportPage from './ManualImportPage.jsx';

const rootEl = document.getElementById('manualImportRoot');
if (rootEl) {
  createRoot(rootEl).render(<ManualImportPage />);
}
