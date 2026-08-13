import { createRoot } from 'react-dom/client';
import AccountPage from './AccountPage.jsx';

const rootEl = document.getElementById('accountRoot');
if (rootEl) {
  createRoot(rootEl).render(<AccountPage />);
}
