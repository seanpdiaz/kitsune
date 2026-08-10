import { createRoot } from 'react-dom/client';
import BlocklistList from './BlocklistList.jsx';

const container = document.getElementById('blocklistList');
if (container) {
  createRoot(container).render(<BlocklistList />);
}
