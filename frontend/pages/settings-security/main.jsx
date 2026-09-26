import { createRoot } from 'react-dom/client';
import SecurityPage from './SecurityPage.jsx';

const rootEl = document.getElementById('securityRoot');
if (rootEl) {
  createRoot(rootEl).render(<SecurityPage />);
}
