import { createRoot } from 'react-dom/client';
import BackupPage from './BackupPage.jsx';

const listContainer = document.getElementById('backupList');
const buttonContainer = document.getElementById('backupNowBtnRoot');
if (listContainer) {
  createRoot(listContainer).render(<BackupPage buttonContainer={buttonContainer} />);
}
