import { escapeAttr } from './icons.js';

// Server-side directory browser behind "Add Root Folder" — matches the
// modal a real Sonarr install shows: type a path or click through real
// folders on the machine running the server, Cancel/Ok. Backed by
// GET /api/fs/browse (see server.js), which does the actual fs.readdirSync
// on whatever path it's given.
function initFileBrowserModal({ modalId, closeId, pathInputId, listId, errorId, cancelId, okId, onConfirm }) {
  const modal = document.getElementById(modalId);
  if (!modal) return null;
  const pathInput = document.getElementById(pathInputId);
  const list = document.getElementById(listId);
  const errorEl = document.getElementById(errorId);
  const closeBtn = document.getElementById(closeId);
  const cancelBtn = document.getElementById(cancelId);
  const okBtn = document.getElementById(okId);

  const folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h4l2-2h6l2 2h4v12H3z"/></svg>';
  let currentPath = '/';

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.classList.toggle('is-collapsed', !message);
  }

  async function browse(targetPath) {
    showError('');
    list.innerHTML = `<div class="file-browser-row" style="cursor:default;"><span></span><span>Loading…</span></div>`;
    try {
      const res = await fetch(`/api/fs/browse?path=${encodeURIComponent(targetPath)}`);
      const body = await res.json();
      if (!res.ok) {
        showError(body.error || `Couldn't open "${targetPath}"`);
        list.innerHTML = '';
        return;
      }
      currentPath = body.path;
      if (pathInput) pathInput.value = currentPath;
      const rows = [];
      if (body.parent) {
        rows.push(`
          <div class="file-browser-row parent-row" data-path="${escapeAttr(body.parent)}">
            ${folderIcon}<span>..</span>
          </div>
        `);
      }
      for (const name of body.folders) {
        const childPath = currentPath.endsWith('/') ? `${currentPath}${name}` : `${currentPath}/${name}`;
        rows.push(`
          <div class="file-browser-row" data-path="${escapeAttr(childPath)}">
            ${folderIcon}<span>${name}</span>
          </div>
        `);
      }
      list.innerHTML = rows.length
        ? rows.join('')
        : `<div class="file-browser-row" style="cursor:default;"><span></span><span style="color:var(--text-muted);">No subfolders</span></div>`;
    } catch {
      showError('Could not reach the server.');
      list.innerHTML = '';
    }
  }

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.file-browser-row[data-path]');
    if (!row) return;
    browse(row.dataset.path);
  });

  if (pathInput) {
    pathInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      browse(pathInput.value.trim() || '/');
    });
  }

  function close() {
    modal.classList.remove('open');
  }

  if (closeBtn) closeBtn.addEventListener('click', close);
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) close();
  });

  if (okBtn) {
    okBtn.addEventListener('click', async () => {
      const chosen = (pathInput && pathInput.value.trim()) || currentPath;
      if (!chosen) {
        showError('Enter a path.');
        return;
      }
      okBtn.disabled = true;
      okBtn.textContent = 'Adding…';
      try {
        await onConfirm(chosen);
        close();
      } catch (err) {
        showError(err.message || 'Could not add that folder.');
      } finally {
        okBtn.disabled = false;
        okBtn.textContent = 'Ok';
      }
    });
  }

  return {
    open() {
      showError('');
      modal.classList.add('open');
      browse(currentPath);
    },
  };
}


export { initFileBrowserModal };
