import { createRoot } from 'react-dom/client';
import QueueList from './QueueList.jsx';

const container = document.getElementById('queueList');
if (container) {
  createRoot(container).render(<QueueList />);
}
