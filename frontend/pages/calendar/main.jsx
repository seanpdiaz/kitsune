import { createRoot } from 'react-dom/client';
import CalendarPage from './CalendarPage.jsx';

const rootContainer = document.getElementById('calendarRoot');
const toolbarContainer = document.getElementById('calendarToolbarRoot');
if (rootContainer) {
  createRoot(rootContainer).render(<CalendarPage toolbarContainer={toolbarContainer} />);
}
