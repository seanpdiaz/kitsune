import { createRoot } from 'react-dom/client';
import TaskList from './TaskList.jsx';

// Mounts into the same #taskList div public/js/pages/system-tasks.js used
// to render plain HTML strings into — see system-tasks.html, which now
// loads this bundle (public/dist/system-tasks.js, built by `npm run build`)
// instead of relying on app.js's shared import of the old module.
const container = document.getElementById('taskList');
if (container) {
  createRoot(container).render(<TaskList />);
}
