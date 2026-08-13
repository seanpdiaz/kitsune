import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../../lib/icons.jsx';

// Settings > Users — admin-only account management. Deliberately its own
// component rather than a third SimpleList.jsx/ConnectionManager.jsx caller
// (see those files' own comments): both share their data through the
// generic /api/settings-items/:section blob, which would either leak
// password_hash straight to the client on every GET or need per-page carve
// -outs neither shared component has today. server/routes/auth.js's
// rowToUser() already strips it server-side, so this page's own fetches to
// /api/users are safe as-is — no client-side filtering needed on top.

function fieldRow(label, desc, children) {
  return (
    <div className="form-row">
      <div className="field-label"><p className="name">{label}</p>{desc && <p className="desc">{desc}</p>}</div>
      <div className="field-control">{children}</div>
    </div>
  );
}

function AddUserModal({ onClose, onCreated }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('standard');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role }),
      });
      const result = await res.json();
      if (!res.ok) { setError(result.error || 'Could not create user.'); setSubmitting(false); return; }
      onCreated(result);
    } catch {
      setError('Could not reach the Kitsune server.');
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* .wide (620px), not the plain 360px modal-box: field-control's fixed
          280px leaves almost no room for field-label's text at 360px —
          barely visible with short labels (Profiles/Custom Formats' modal
          gets away with it since neither passes a `desc`), but with a real
          desc paragraph the label column wraps one word per line. Same fix
          ConnectionManager.jsx's own EditModal already uses for the same
          reason. */}
      <div className="modal-box wide">
        <div className="modal-header">
          <h2>Add user</h2>
          <button className="modal-close" type="button" aria-label="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {fieldRow('Username', null, (
              <input className="field-input" type="text" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required />
            ))}
            {fieldRow('Password', 'At least 8 characters.', (
              <input className="field-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            ))}
            {fieldRow('Role', null, (
              <select className="field-select" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="standard">Standard</option>
                <option value="admin">Admin</option>
              </select>
            ))}
            {error && <p className="form-error">{error}</p>}
          </div>
          <div className="modal-footer">
            <button className="btn-accent" type="submit" disabled={submitting}>{submitting ? 'Adding…' : 'Add user'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditUserModal({ item, currentUser, onClose, onSaved, onRemoved }) {
  const [username, setUsername] = useState(item.username);
  const [role, setRole] = useState(item.role);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isSelf = currentUser && currentUser.id === item.id;

  async function handleSave() {
    setError('');
    if (password && password.length < 8) { setError('New password must be at least 8 characters.'); return; }
    setSubmitting(true);
    const body = { username, role };
    if (password) body.password = password;
    try {
      const res = await fetch(`/api/users/${item.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) { setError(result.error || 'Could not save changes.'); setSubmitting(false); return; }
      onSaved(result);
    } catch {
      setError('Could not reach the Kitsune server.');
      setSubmitting(false);
    }
  }

  async function handleRemove() {
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch(`/api/users/${item.id}`, { method: 'DELETE' });
      const result = await res.json();
      if (!res.ok) { setError(result.error || 'Could not remove user.'); setSubmitting(false); return; }
      onRemoved(item.id);
    } catch {
      setError('Could not reach the Kitsune server.');
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box wide">
        <div className="modal-header">
          <h2>Edit {item.username}</h2>
          <button className="modal-close" type="button" aria-label="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          {fieldRow('Username', null, (
            <input className="field-input" type="text" value={username} onChange={(e) => setUsername(e.target.value)} />
          ))}
          {fieldRow('Role', isSelf ? "You can't change your own role." : null, (
            <select className="field-select" value={role} onChange={(e) => setRole(e.target.value)} disabled={isSelf}>
              <option value="standard">Standard</option>
              <option value="admin">Admin</option>
            </select>
          ))}
          {fieldRow('New password', 'Leave blank to keep the current password.', (
            <input className="field-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          ))}
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-footer split">
          <button
            className="btn-danger" type="button" disabled={submitting || isSelf}
            title={isSelf ? "You can't remove your own account." : ''} onClick={handleRemove}
          >
            Remove
          </button>
          <div className="modal-footer-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="btn-accent" type="button" disabled={submitting} onClick={handleSave}>
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function UsersPage({ addBtnContainer }) {
  const [data, setData] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stateRes = await fetch('/api/auth/state');
        const state = await stateRes.json();
        if (!cancelled) setCurrentUser(state.user);

        const res = await fetch('/api/users');
        if (res.status === 403) {
          if (!cancelled) { setForbidden(true); setLoaded(true); }
          return;
        }
        const items = await res.json();
        if (!cancelled) { setData(items); setLoaded(true); }
      } catch {
        if (!cancelled) { setData([]); setLoaded(true); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const editingItem = editingId != null ? data.find((d) => d.id === editingId) || null : null;

  return (
    <>
      {addBtnContainer && !forbidden && createPortal(
        <button className="btn-accent" type="button" onClick={() => setAddOpen(true)}>
          {icons.plus}Add user
        </button>,
        addBtnContainer,
      )}

      {!forbidden && (
        <div className="user-header">
          <span>Username</span><span>Role</span><span>Created</span><span></span>
        </div>
      )}

      {!loaded ? (
        <p className="settings-empty">Loading…</p>
      ) : forbidden ? (
        <p className="settings-empty">Only admins can manage users.</p>
      ) : data.length === 0 ? (
        <p className="settings-empty">No users yet.</p>
      ) : (
        data.map((item) => (
          <div className="user-row" key={item.id}>
            <p className="settings-title">
              {item.username}
              {currentUser && currentUser.id === item.id && <span className="count-badge" style={{ marginLeft: 8 }}>You</span>}
            </p>
            <span className={`status-pill ${item.role === 'admin' ? 'status-info' : 'status-pending'}`}>
              {item.role === 'admin' ? 'Admin' : 'Standard'}
            </span>
            <span className="settings-meta">{new Date(item.createdAt).toLocaleDateString()}</span>
            <button className="ep-action" type="button" aria-label={`Edit ${item.username}`} onClick={() => setEditingId(item.id)}>{icons.edit}</button>
          </div>
        ))
      )}

      {addOpen && (
        <AddUserModal
          onClose={() => setAddOpen(false)}
          onCreated={(created) => { setData((prev) => [...prev, created]); setAddOpen(false); }}
        />
      )}

      {editingItem && (
        <EditUserModal
          item={editingItem}
          currentUser={currentUser}
          onClose={() => setEditingId(null)}
          onSaved={(updated) => { setData((prev) => prev.map((d) => (d.id === updated.id ? updated : d))); setEditingId(null); }}
          onRemoved={(id) => { setData((prev) => prev.filter((d) => d.id !== id)); setEditingId(null); }}
        />
      )}
    </>
  );
}
