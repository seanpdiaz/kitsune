import { createRoot } from 'react-dom/client';
import UpdatesInfo from './UpdatesInfo.jsx';

const container = document.getElementById('updatesRoot');
if (container) {
  createRoot(container).render(<UpdatesInfo />);
}
