import { createRoot } from 'react-dom/client';
import SeriesPage from './SeriesPage.jsx';

const rootEl = document.getElementById('seriesRoot');
if (rootEl) {
  createRoot(rootEl).render(<SeriesPage />);
}
