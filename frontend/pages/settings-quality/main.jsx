import { createRoot } from 'react-dom/client';
import QualityPage from './QualityPage.jsx';

const rootEl = document.getElementById('qualityRoot');
if (rootEl) {
  createRoot(rootEl).render(<QualityPage addBtnContainer={document.getElementById('addQualityBtnRoot')} />);
}
