import { createRoot } from 'react-dom/client';
import EventFeed from './EventFeed.jsx';

const listContainer = document.getElementById('eventList');
const buttonContainer = document.getElementById('clearEventsBtnRoot');
if (listContainer) {
  createRoot(listContainer).render(<EventFeed buttonContainer={buttonContainer} />);
}
