import { createRoot } from 'react-dom/client';
import StatisticsPage from './StatisticsPage.jsx';

const container = document.getElementById('statisticsRoot');
if (container) {
  createRoot(container).render(<StatisticsPage />);
}
