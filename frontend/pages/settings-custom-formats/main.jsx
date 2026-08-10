import { createRoot } from 'react-dom/client';
import CustomFormatsPage from './CustomFormatsPage.jsx';

const rootEl = document.getElementById('customFormatsRoot');
const addBtnContainer = document.getElementById('addFormatBtnRoot');
if (rootEl) {
  createRoot(rootEl).render(<CustomFormatsPage addBtnContainer={addBtnContainer} />);
}
