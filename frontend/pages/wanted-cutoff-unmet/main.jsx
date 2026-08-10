import { createRoot } from 'react-dom/client';
import CutoffList from './CutoffList.jsx';

const listContainer = document.getElementById('cutoffList');
const buttonContainer = document.getElementById('cutoffSearchAllBtnRoot');
if (listContainer) {
  createRoot(listContainer).render(<CutoffList buttonContainer={buttonContainer} />);
}
