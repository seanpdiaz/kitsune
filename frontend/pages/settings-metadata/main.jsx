import { createRoot } from 'react-dom/client';
import MetadataPage from './MetadataPage.jsx';

const rootEl = document.getElementById('metadataRoot');
if (rootEl) {
  createRoot(rootEl).render(<MetadataPage />);
}
