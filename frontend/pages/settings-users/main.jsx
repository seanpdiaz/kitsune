import { createRoot } from 'react-dom/client';
import UsersPage from './UsersPage.jsx';

const rootEl = document.getElementById('usersRoot');
const addBtnContainer = document.getElementById('addUserBtnRoot');
if (rootEl) {
  createRoot(rootEl).render(<UsersPage addBtnContainer={addBtnContainer} />);
}
