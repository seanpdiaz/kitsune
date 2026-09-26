import { useEffect, useState } from 'react';

// public/login.html's only script. Two phases sharing one form: 'setup' (the
// users table is still empty — first-run, same idea as Sonarr/Radarr's own
// first-launch prompt, just persisted as a real account rather than a
// one-time config value) and 'login' (normal sign-in). GET /api/auth/state
// on mount decides which — see server/routes/auth.js.
//
// If a session cookie's already valid (someone lands on login.html directly
// while already signed in), this redirects straight through to `next` (or
// index.html) instead of showing the form at all.
//
// When single sign-on is turned on (Settings > General — see server/routes/
// oidc.js), the login phase also shows a "Sign in with <provider>" button
// above the normal form. A failed SSO sign-in comes back here with
// ?sso_error=<message>, shown above the form.

// `next` comes straight from the query string, so only one of this app's
// own pages is accepted — anything else (another site, javascript:, //host)
// falls back to the Library. Same rule as server/routes/oidc.js's safeNext.
function nextTarget() {
  const next = new URLSearchParams(window.location.search).get('next') || '';
  return /^[A-Za-z0-9_-]+\.html(\?[A-Za-z0-9_.~%&=+-]*)?$/.test(next) ? next : 'index.html';
}

function ssoErrorFromUrl() {
  return new URLSearchParams(window.location.search).get('sso_error') || '';
}

export default function LoginPage() {
  const [phase, setPhase] = useState('loading'); // loading | setup | login
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(ssoErrorFromUrl);
  const [submitting, setSubmitting] = useState(false);
  const [sso, setSso] = useState({ enabled: false, providerName: '' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [stateRes, ssoRes] = await Promise.all([
          fetch('/api/auth/state'),
          fetch('/api/auth/oidc/status').catch(() => null),
        ]);
        const state = await stateRes.json();
        const ssoStatus = ssoRes && ssoRes.ok ? await ssoRes.json() : null;
        if (cancelled) return;
        if (state.user) {
          window.location.href = nextTarget();
          return;
        }
        if (ssoStatus) setSso(ssoStatus);
        setPhase(state.needsSetup ? 'setup' : 'login');
      } catch {
        if (!cancelled) setPhase('login');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (phase === 'setup') {
      if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
      if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    }
    setSubmitting(true);
    try {
      const res = await fetch(phase === 'setup' ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const result = await res.json();
      if (!res.ok) {
        setError(result.error || 'Something went wrong.');
        setSubmitting(false);
        return;
      }
      window.location.href = nextTarget();
    } catch {
      setError('Could not reach the Kitsune server.');
      setSubmitting(false);
    }
  }

  if (phase === 'loading') {
    return (
      <div className="auth-page">
        <div className="auth-card"><p className="settings-empty">Loading…</p></div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <svg className="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3c2 2.5 2 5 2 5s2.5-1 4-1 3 1 3 3-1.5 3-3 3c1 1.5 1 3.5-.5 5C16 19.5 14 19 12 21c-2-2-4-1.5-5.5-3-1.5-1.5-1.5-3.5-.5-5-1.5 0-3-1-3-3s1.5-3 3-3 4 1 4 1 0-2.5 2-5z" />
          </svg>
          <span className="brand-name">Kitsune</span>
        </div>

        <h1 className="auth-title">{phase === 'setup' ? 'Create the admin account' : 'Sign in'}</h1>
        <p className="settings-subtitle">
          {phase === 'setup'
            ? 'This is the first time Kitsune has started on this server — set up the admin account to continue.'
            : 'Sign in with your Kitsune account.'}
        </p>

        {phase === 'login' && sso.enabled && (
          <>
            <a className="btn-accent auth-submit auth-sso" href={`/api/auth/oidc/login?next=${encodeURIComponent(nextTarget())}`}>
              Sign in with {sso.providerName}
            </a>
            <div className="auth-divider"><span>or use a Kitsune password</span></div>
          </>
        )}

        <form onSubmit={handleSubmit}>
          <label className="auth-label" htmlFor="authUsername">Username</label>
          <input
            id="authUsername" className="field-input" type="text" autoComplete="username" autoFocus
            value={username} onChange={(e) => setUsername(e.target.value)} required
          />

          <label className="auth-label" htmlFor="authPassword">Password</label>
          <input
            id="authPassword" className="field-input" type="password"
            autoComplete={phase === 'setup' ? 'new-password' : 'current-password'}
            value={password} onChange={(e) => setPassword(e.target.value)} required
          />

          {phase === 'setup' && (
            <>
              <label className="auth-label" htmlFor="authConfirmPassword">Confirm password</label>
              <input
                id="authConfirmPassword" className="field-input" type="password" autoComplete="new-password"
                value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required
              />
            </>
          )}

          {error && <p className="form-error">{error}</p>}

          <button className={`${phase === 'login' && sso.enabled ? '' : 'btn-accent '}auth-submit`} type="submit" disabled={submitting}>
            {submitting ? 'Please wait…' : phase === 'setup' ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
