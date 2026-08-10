import { createRoot } from 'react-dom/client';
import ProfilesPage from './ProfilesPage.jsx';

const rootEl = document.getElementById('profilesRoot');
const addBtnContainer = document.getElementById('addProfileBtnRoot');
if (rootEl) {
  createRoot(rootEl).render(<ProfilesPage addBtnContainer={addBtnContainer} />);
}
