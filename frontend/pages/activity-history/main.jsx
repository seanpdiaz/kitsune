import { createRoot } from 'react-dom/client';
import HistoryList from './HistoryList.jsx';

const listContainer = document.getElementById('historyList');
const tabsContainer = document.getElementById('historyFilterTabsRoot');
const searchContainer = document.getElementById('historySearchRoot');
if (listContainer) {
  createRoot(listContainer).render(<HistoryList tabsContainer={tabsContainer} searchContainer={searchContainer} />);
}
