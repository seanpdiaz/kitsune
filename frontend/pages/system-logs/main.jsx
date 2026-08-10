import { createRoot } from 'react-dom/client';
import LogTable from './LogTable.jsx';

const listContainer = document.getElementById('logList');
const tabsContainer = document.getElementById('logFilterTabsRoot');
if (listContainer) {
  createRoot(listContainer).render(<LogTable tabsContainer={tabsContainer} />);
}
