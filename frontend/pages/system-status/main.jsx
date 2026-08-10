import { createRoot } from 'react-dom/client';
import StatusInfo from './StatusInfo.jsx';

const container = document.getElementById('statusRoot');
if (container) {
  createRoot(container).render(<StatusInfo />);
}
