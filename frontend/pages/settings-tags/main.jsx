import { createRoot } from 'react-dom/client';
import TagsPage from './TagsPage.jsx';

const rootEl = document.getElementById('tagsRoot');
if (rootEl) {
  createRoot(rootEl).render(<TagsPage addBtnContainer={document.getElementById('addTagBtnRoot')} />);
}
