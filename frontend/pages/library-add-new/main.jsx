import { createRoot } from 'react-dom/client';
import AddNewPage from './AddNewPage.jsx';

const rootEl = document.getElementById('addNewRoot');
if (rootEl) {
  createRoot(rootEl).render(<AddNewPage />);
}
