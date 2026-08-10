import { createRoot } from 'react-dom/client';
import LibraryImportPage from './LibraryImportPage.jsx';

const rootEl = document.getElementById('libraryImportRoot');
if (rootEl) {
  createRoot(rootEl).render(<LibraryImportPage addBtnContainer={document.getElementById('rescanFoldersBtnRoot')} />);
}
