import { createRoot } from 'react-dom/client';
import DownloadClients from './DownloadClients.jsx';

const rootEl = document.getElementById('downloadClientsRoot');
const addBtnContainer = document.getElementById('addClientBtnRoot');
if (rootEl) {
  createRoot(rootEl).render(<DownloadClients addBtnContainer={addBtnContainer} />);
}
