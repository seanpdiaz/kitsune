import { createRoot } from 'react-dom/client';
import MissingList from './MissingList.jsx';

const listContainer = document.getElementById('missingList');
const buttonContainer = document.getElementById('missingSearchAllBtnRoot');
if (listContainer) {
  createRoot(listContainer).render(<MissingList buttonContainer={buttonContainer} />);
}
