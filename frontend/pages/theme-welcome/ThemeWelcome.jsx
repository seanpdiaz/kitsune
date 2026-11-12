import { useEffect, useRef, useState } from 'react';
import ThemePicker from '../settings-ui/ThemePicker.jsx';
import { saveAppearance } from '../../lib/userAppearance.js';

// First-login theme picker. Opened once per account by public/js/nav.js
// (see syncTheme there) when the user's appearance prefs have no `welcomed`
// flag yet — a brand-new local or SSO account, or an existing account the
// first time it signs in after per-user themes shipped.
//
// Same ThemePicker as Settings > UI and My Account, applied live so the
// whole page behind the modal previews each choice. "Use this theme" saves
// it to the account; "Skip" (or Esc / the close button) puts the page back
// the way it was and keeps following the server default. Either answer sets
// `welcomed`, so it never asks again — My Account > Appearance is where to
// change it later.

const KT = () => window.KitsuneTheme;

export default function ThemeWelcome({ initialTheme, initialAccent, onDone }) {
  const [theme, setTheme] = useState(initialTheme);
  const [accent, setAccent] = useState(initialAccent);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const primaryRef = useRef(null);

  useEffect(() => {
    if (primaryRef.current) primaryRef.current.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  async function finish(patch, revert) {
    setSaving(true);
    setError('');
    try {
      await saveAppearance({ ...patch, welcomed: true });
      if (revert) KT().apply(initialTheme, initialAccent);
      onDone();
    } catch {
      setSaving(false);
      setError('Could not save your choice. Check your connection and try again.');
    }
  }

  const skip = () => { if (!saving) finish({}, true); };
  const confirm = () => finish({ theme, accent }, false);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') skip(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="modal-overlay open theme-welcome-overlay" role="dialog" aria-modal="true" aria-labelledby="themeWelcomeTitle">
      <div className="modal-box theme-welcome-box">
        <div className="modal-header">
          <div>
            <h2 id="themeWelcomeTitle">Welcome to Kitsune</h2>
            <p className="theme-welcome-sub">Pick a look to get started. You can change it anytime in My Account.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Skip" onClick={skip} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="theme-welcome-picker">
            <ThemePicker
              theme={theme}
              accent={accent}
              onThemeChange={setTheme}
              onAccentChange={setAccent}
              themeDesc="Previews live behind this window."
            />
          </div>
          {error && <p className="form-error" style={{ marginTop: 12 }}>{error}</p>}
        </div>
        <div className="modal-footer split">
          <button type="button" onClick={skip} disabled={saving}>Skip for now</button>
          <button type="button" className="btn-accent" ref={primaryRef} onClick={confirm} disabled={saving}>
            {saving ? 'Saving…' : 'Use this theme'}
          </button>
        </div>
      </div>
    </div>
  );
}
