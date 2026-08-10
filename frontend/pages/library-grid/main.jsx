import { createRoot } from 'react-dom/client';
import LibraryGridPage from './LibraryGridPage.jsx';

const rootEl = document.getElementById('libraryGridRoot');
if (rootEl) {
  createRoot(rootEl).render(<LibraryGridPage searchContainer={document.getElementById('librarySearchRoot')} />);
}
