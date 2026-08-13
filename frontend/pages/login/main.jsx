import { createRoot } from 'react-dom/client';
import LoginPage from './LoginPage.jsx';

const rootEl = document.getElementById('authRoot');
if (rootEl) {
  createRoot(rootEl).render(<LoginPage />);
}
