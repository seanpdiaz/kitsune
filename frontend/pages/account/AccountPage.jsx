import { useEffect, useState } from 'react';
import { ToggleField } from '../../components/SettingsFormFields.jsx';
import ThemePicker from '../settings-ui/ThemePicker.jsx';
import { loadAppearance, saveAppearance } from '../../lib/userAppearance.js';

// My Account — self-service username/password change for whoever is
// currently signed in, reachable from the sidebar's user chip (see
// public/js/nav.js), not from the Settings tab strip — this page belongs to
// every user, not just admins, so it doesn't live under the admin-flavored
// Settings section. Backed by PATCH /api/auth/me (see server/routes/auth.js),
// which always requires the current password before applying any change.

// Layout: a page header (title, one-line summary, and a badge for the
// signed-in account's role) above three section cards — Profile & Security,
// Appearance, Library. Each card has the same head (icon, title, a meta note
// on the right) and the profile card ends in a footer bar holding its Save
// button. Styles live under .account-page in public/styles.css.

const svg = (children) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const Icon = {
  user: svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>),
  shield: svg(<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />),
  lock: svg(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>),
  palette: svg(<><path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z" /><circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none" /><circle cx="10" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="14.5" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="17" cy="11" r="1" fill="currentColor" stroke="none" /></>),
  library: svg(<path d="M5 4v16M9 4v16M13 4v16M16.5 4.5l4 15" />),
  eye: svg(<><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>),
  eyeOff: svg(<><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.8 3.7M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" /></>),
};

function AccountCard({ icon, title, meta, footer, children }) {
  return (
    <section className="account-card">
      <header className="account-card-head">
        <span className="account-card-icon">{icon}</span>
        <h2>{title}</h2>
        {meta ? <span className="account-card-meta">{meta}</span> : null}
      </header>
      <div className="account-card-body">{children}</div>
      {footer ? <footer className="account-card-foot">{footer}</footer> : null}
    </section>
  );
}

function AccountRow({ name, desc, children, align = 'center', toggle = false }) {
  return (
    <div className={`account-row${align === 'start' ? ' align-start' : ''}${toggle ? ' toggle-row' : ''}`}>
      <div className="account-row-label">
        <p className="name">{name}</p>
        {desc ? <p className="desc">{desc}</p> : null}
      </div>
      <div className="account-row-control">{children}</div>
    </div>
  );
}

function PasswordInput({ value, onChange, autoComplete, placeholder, required }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="account-password">
      <input
        className="account-input"
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      />
      <button
        type="button"
        className="account-password-toggle"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? Icon.eyeOff : Icon.eye}
      </button>
    </div>
  );
}

function RoleRow({ role }) {
  const admin = role === 'admin';
  return (
    <AccountRow name="Role">
      <div className="account-role">
        <span className={`account-role-pill${admin ? ' admin' : ''}`}>{admin ? 'Admin' : 'Standard'}</span>
        <span className="account-role-desc">
          {admin ? 'Full access to library management and server settings.' : 'Can browse the library and manage their own account.'}
        </span>
      </div>
    </AccountRow>
  );
}

function PageHeader({ user }) {
  const admin = user && user.role === 'admin';
  return (
    <div className="account-header">
      <div>
        <h1 className="account-title">My Account</h1>
        <p className="account-subtitle">Manage your credentials, interface theme, and content filters.</p>
      </div>
      {user ? (
        <span className={`account-badge${admin ? ' admin' : ''}`}>
          {admin ? Icon.shield : Icon.user}
          {admin ? 'Admin Account' : 'Standard Account'}
        </span>
      ) : null}
    </div>
  );
}

// Library display preferences for whoever's signed in — stored per user in
// /api/user-prefs/library-ui-prefs (server/routes/user-prefs.js), the same
// record the Library page already keeps its view and poster size in, and
// read back by frontend/pages/library-grid/LibraryGridPage.jsx. Lives here
// rather than Settings > UI because Settings > UI is server-wide admin
// configuration; this is one person's choice about what they see. Saves on
// toggle, no Save button — same as the Library's own view/size controls.
function LibraryPrefsCard() {
  const [showHentai, setShowHentai] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/user-prefs/library-ui-prefs')
      .then((r) => r.json())
      .then((saved) => { if (!cancelled) setShowHentai(saved.showHentai !== false); })
      .catch(() => { if (!cancelled) setShowHentai(true); });
    return () => { cancelled = true; };
  }, []);

  async function handleChange(next) {
    const previous = showHentai;
    setShowHentai(next);
    setError('');
    try {
      const res = await fetch('/api/user-prefs/library-ui-prefs', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showHentai: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setShowHentai(previous);
      setError('Could not save this setting.');
    }
  }

  return (
    <AccountCard icon={Icon.library} title="Library">
      <AccountRow
        toggle
        name="Show hentai"
        desc="When off, series MyAnimeList classifies as hentai are hidden from your Library page and excluded from its counts. Only affects your account."
      >
        {showHentai === null
          ? <span className="settings-meta">…</span>
          : <ToggleField id="account-show-hentai" checked={showHentai} onChange={handleChange} />}
      </AccountRow>
      {error && <p className="form-error">{error}</p>}
    </AccountCard>
  );
}

// This account's own theme and accent (frontend/lib/userAppearance.js).
// Starts from what's on screen — the user's saved theme, or the server
// default (Settings > UI) if they've never picked one — and saves on every
// change, like the Library card. Picking here also marks the first-login
// picker as answered, so it won't pop up afterwards.
function AppearanceCard() {
  const kt = window.KitsuneTheme;
  const start = kt ? kt.stored() : { theme: 'dark', accent: '' };
  const [theme, setTheme] = useState(start.theme);
  const [accent, setAccent] = useState(start.accent);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadAppearance().then((saved) => {
      if (cancelled || !saved.theme) return;
      setTheme(saved.theme);
      setAccent(saved.accent || '');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function save(next) {
    setError('');
    try {
      await saveAppearance({ theme: next.theme, accent: next.accent, welcomed: true });
    } catch {
      setError('Could not save your theme.');
    }
  }

  return (
    <AccountCard icon={Icon.palette} title="Appearance" meta="Synced to your account">
      <ThemePicker
        variant="account"
        theme={theme}
        accent={accent}
        themeDesc="Choose how Kitsune looks across your devices. Click any card to preview live."
        onThemeChange={(id) => { setTheme(id); save({ theme: id, accent }); }}
        onAccentChange={(hex) => { setAccent(hex); save({ theme, accent: hex }); }}
      />
      {error && <p className="form-error">{error}</p>}
    </AccountCard>
  );
}

function ProfileCard({ user, onSaved }) {
  const [username, setUsername] = useState(user.username);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
      onSaved(result.user);
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

  const footer = (
    <>
      <span className={`account-foot-note${error ? ' error' : success ? ' success' : ''}`} role={error || success ? 'status' : undefined}>
        {error || success || 'Changes apply immediately upon saving.'}
      </span>
      <button className="btn-accent account-save" type="submit" form="account-profile-form" disabled={submitting}>
        {submitting ? 'Saving…' : 'Save changes'}
      </button>
    </>
  );

  return (
    <AccountCard icon={Icon.user} title="Profile & Security" meta={`Account ID #${user.id}`} footer={footer}>
      <form id="account-profile-form" onSubmit={handleSubmit}>
        <AccountRow name="Username">
          <input className="account-input" type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </AccountRow>
        <RoleRow role={user.role} />

        <div className="account-section-label">{Icon.lock}<span>Change password</span></div>

        <AccountRow name="New password" desc="Leave blank to keep your current password." align="start">
          <PasswordInput value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
        </AccountRow>

        {newPassword && (
          <AccountRow name="Confirm new password" align="start">
            <PasswordInput value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" placeholder="Type the new password again" />
          </AccountRow>
        )}

        <AccountRow name="Current password" desc="Required to save any change on this form." align="start">
          <PasswordInput value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" placeholder="Enter current password to confirm" required />
        </AccountRow>
      </form>
    </AccountCard>
  );
}

// Accounts created by a single sign-on sign-in have no password and take
// their username from the identity provider (see server/routes/oidc.js),
// so there's nothing to edit here — PATCH /api/auth/me refuses them too.
function SsoProfileCard({ user }) {
  return (
    <AccountCard icon={Icon.user} title="Profile & Security" meta={`Account ID #${user.id}`}>
      <AccountRow name="Username">
        <span className="account-static">{user.username}</span>
      </AccountRow>
      <RoleRow role={user.role} />
      <p className="account-note">
        You sign in with single sign-on, so your username and password are managed by your identity provider.
      </p>
    </AccountCard>
  );
}

export default function AccountPage() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/state').then((r) => r.json()).then((state) => {
      if (!cancelled) setUser(state.user);
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="account-page">
      <PageHeader user={user} />
      {!user ? <p className="settings-empty">Loading…</p> : (
        <>
          {user.authSource === 'oidc'
            ? <SsoProfileCard user={user} />
            : <ProfileCard user={user} onSaved={setUser} />}
          <AppearanceCard />
          <LibraryPrefsCard />
        </>
      )}
    </div>
  );
}
