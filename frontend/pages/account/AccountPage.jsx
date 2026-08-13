import { useEffect, useState } from 'react';

// My Account — self-service username/password change for whoever is
// currently signed in, reachable from the sidebar's user chip (see
// public/js/nav.js), not from the Settings tab strip — this page belongs to
// every user, not just admins, so it doesn't live under the admin-flavored
// Settings section. Backed by PATCH /api/auth/me (see server/routes/auth.js),
// which always requires the current password before applying any change.

export default function AccountPage() {
  const [user, setUser] = useState(null);
  const [username, setUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/state').then((r) => r.json()).then((state) => {
      if (cancelled) return;
      setUser(state.user);
      setUsername(state.user ? state.user.username : '');
    });
    return () => { cancelled = true; };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (newPassword && newPassword !== confirmPassword) { setError('New passwords do not match.'); return; }
    if (newPassword && newPassword.length < 8) { setError('New password must be at least 8 characters.'); return; }
    setSubmitting(true);
    const body = { currentPassword };
    if (username !== user.username) body.username = username;
    if (newPassword) body.newPassword = newPassword;
    try {
      const res = await fetch('/api/auth/me', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) { setError(result.error || 'Could not save changes.'); setSubmitting(false); return; }
      setUser(result.user);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSuccess('Saved.');
      setSubmitting(false);
    } catch {
      setError('Could not reach the Kitsune server.');
      setSubmitting(false);
    }
  }

  if (!user) return <p className="settings-empty">Loading…</p>;

  return (
    <div className="settings-card" style={{ maxWidth: 480 }}>
      <form onSubmit={handleSubmit}>
        <div className="form-row" style={{ borderTop: 'none', paddingTop: 0 }}>
          <div className="field-label"><p className="name">Username</p></div>
          <div className="field-control">
            <input className="field-input" type="text" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
        </div>

        <div className="form-row">
          <div className="field-label"><p className="name">Role</p></div>
          <div className="field-control">
            <span className={`status-pill ${user.role === 'admin' ? 'status-info' : 'status-pending'}`}>
              {user.role === 'admin' ? 'Admin' : 'Standard'}
            </span>
          </div>
        </div>

        <div className="form-row">
          <div className="field-label"><p className="name">New password</p><p className="desc">Leave blank to keep your current password.</p></div>
          <div className="field-control">
            <input className="field-input" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </div>
        </div>

        {newPassword && (
          <div className="form-row">
            <div className="field-label"><p className="name">Confirm new password</p></div>
            <div className="field-control">
              <input className="field-input" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            </div>
          </div>
        )}

        <div className="form-row">
          <div className="field-label"><p className="name">Current password</p><p className="desc">Required to save any change on this page.</p></div>
          <div className="field-control">
            <input className="field-input" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
          </div>
        </div>

        {error && <p className="form-error">{error}</p>}
        {success && <p className="form-error" style={{ color: 'var(--success)' }}>{success}</p>}

        <div style={{ paddingTop: 14 }}>
          <button className="btn-accent" type="submit" disabled={submitting}>{submitting ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </div>
  );
}
