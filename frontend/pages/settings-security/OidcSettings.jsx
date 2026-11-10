import { useEffect, useRef, useState } from 'react';
import { SettingsCard, FormRow, ToggleField, TextField } from '../../components/SettingsFormFields.jsx';

// Settings > Security's Single Sign-On card — the admin side of
// server/routes/oidc.js. Unlike the rest of this page it doesn't go through
// useSettingsForm's autosave: the config lives behind admin-only endpoints
// (the client secret must never come back from the server), and a
// half-typed issuer or client ID shouldn't be live on the login page, so
// this card edits a local copy and saves it explicitly.

const CALLBACK_PATH = '/api/auth/oidc/callback';

const EDITABLE_KEYS = [
  'enabled', 'providerName', 'issuer', 'clientId', 'scopes', 'usernameClaim',
  'groupsClaim', 'adminGroup', 'autoCreateUsers', 'linkExistingByUsername', 'publicUrl',
  'caCertificate', 'skipTlsVerify',
];

function editable(cfg) {
  const out = {};
  EDITABLE_KEYS.forEach((key) => { out[key] = cfg[key]; });
  return out;
}

function redirectUriFor(publicUrl) {
  const base = (publicUrl || '').trim().replace(/\/+$/, '') || window.location.origin;
  return `${base}${CALLBACK_PATH}`;
}

export default function OidcSettings() {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [secret, setSecret] = useState('');
  const [loadState, setLoadState] = useState('loading'); // loading | ready | forbidden | error
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null); // { kind: 'error' | 'success', text }
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const caFileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/oidc/config')
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) { setLoadState('forbidden'); return; }
        if (!res.ok) { setLoadState('error'); return; }
        const cfg = await res.json();
        if (cancelled) return;
        setSaved(cfg);
        setForm(editable(cfg));
        setLoadState('ready');
      })
      .catch(() => { if (!cancelled) setLoadState('error'); });
    return () => { cancelled = true; };
  }, []);

  if (loadState === 'loading') return null;
  if (loadState === 'forbidden') {
    return (
      <SettingsCard title="Single Sign-On (OIDC)" desc="Only admins can view or change single sign-on settings." />
    );
  }
  if (loadState === 'error') {
    return (
      <SettingsCard title="Single Sign-On (OIDC)">
        <p className="form-error">Couldn't load single sign-on settings.</p>
      </SettingsCard>
    );
  }

  const set = (key) => (value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setMessage(null);
  };
  const dirty = secret !== '' || JSON.stringify(form) !== JSON.stringify(editable(saved));
  const redirectUri = redirectUriFor(form.publicUrl);
  const detailClass = form.enabled ? '' : 'is-collapsed';

  async function put(body, successText) {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/oidc/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
      setSaved(result);
      setForm(editable(result));
      setSecret('');
      setMessage({ kind: 'success', text: successText });
    } catch (err) {
      setMessage({ kind: 'error', text: err.message || 'Could not save.' });
    } finally {
      setSaving(false);
    }
  }

  function handleSave() {
    const body = { ...form };
    if (secret) body.clientSecret = secret;
    put(body, 'Saved.');
  }

  function handleRevert() {
    setForm(editable(saved));
    setSecret('');
    setMessage(null);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/auth/oidc/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issuer: form.issuer, caCertificate: form.caCertificate, skipTlsVerify: form.skipTlsVerify }),
      });
      setTestResult(await res.json());
    } catch {
      setTestResult({ ok: false, error: 'Could not reach the Kitsune server.' });
    } finally {
      setTesting(false);
    }
  }

  function handleCaFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '').trim();
      // Appends, so a root and an intermediate can be loaded one after the other.
      set('caCertificate')(form.caCertificate ? `${form.caCertificate.trim()}\n${text}` : text);
    };
    reader.readAsText(file);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused (plain-HTTP origin); the field is
      // selectable, so it can still be copied by hand.
    }
  }

  return (
    <SettingsCard
      title="Single Sign-On (OIDC)"
      desc="Let people sign in through an OpenID Connect provider such as Authentik, Authelia or Keycloak. Shown on the login page when Authentication Method is Forms. Password sign-in keeps working alongside it."
    >
      <FormRow name="Enable Single Sign-On">
        <ToggleField id="oidc-enabled" checked={form.enabled} onChange={set('enabled')} />
      </FormRow>

      <div className={`form-row ${detailClass}`}>
        <div className="field-label">
          <p className="name">Redirect URI</p>
          <p className="desc">Register this exact URI as the redirect URI in your provider.</p>
        </div>
        <div className="field-control wide" style={{ gap: 6 }}>
          <input className="field-input" type="text" readOnly value={redirectUri} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 0 }} />
          <button type="button" onClick={handleCopy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </div>

      <FormRow name="Provider Name" desc={'Shown on the login button, e.g. "Sign in with Authentik".'} className={detailClass}>
        <TextField id="oidc-provider-name" placeholder="Authentik" value={form.providerName} onChange={set('providerName')} />
      </FormRow>
      <FormRow name="Issuer URL" desc="The provider's issuer, e.g. https://auth.example.com/application/o/kitsune/" className={detailClass}>
        <TextField id="oidc-issuer" placeholder="https://auth.example.com/application/o/kitsune/" value={form.issuer} onChange={set('issuer')} />
      </FormRow>
      <FormRow name="Client ID" className={detailClass}>
        <TextField id="oidc-client-id" value={form.clientId} onChange={set('clientId')} />
      </FormRow>
      <FormRow
        name="Client Secret"
        desc={saved.hasClientSecret ? 'A secret is saved. Type a new one to replace it.' : 'Leave empty for a public client (PKCE only).'}
        className={detailClass}
      >
        <TextField id="oidc-client-secret" type="password" placeholder={saved.hasClientSecret ? '•••••••• (saved)' : ''} value={secret} onChange={(v) => { setSecret(v); setMessage(null); }} />
      </FormRow>
      <FormRow name="Scopes" desc="Space-separated. openid is always included." className={detailClass}>
        <TextField id="oidc-scopes" value={form.scopes} onChange={set('scopes')} />
      </FormRow>
      <FormRow name="Username Claim" desc="Claim used to name new accounts. Falls back to preferred_username, then email." className={detailClass}>
        <TextField id="oidc-username-claim" value={form.usernameClaim} onChange={set('usernameClaim')} />
      </FormRow>
      <FormRow name="Groups Claim" className={detailClass}>
        <TextField id="oidc-groups-claim" value={form.groupsClaim} onChange={set('groupsClaim')} />
      </FormRow>
      <FormRow
        name="Admin Group"
        desc="Members of this group are admins and everyone else is standard, updated on every sign-in (the last admin is never demoted). Leave empty to manage roles in Settings > Users."
        className={detailClass}
      >
        <TextField id="oidc-admin-group" placeholder="kitsune-admins" value={form.adminGroup} onChange={set('adminGroup')} />
      </FormRow>
      <FormRow name="Create Accounts Automatically" desc="Create a Kitsune account the first time someone signs in through the provider." className={detailClass}>
        <ToggleField id="oidc-auto-create" checked={form.autoCreateUsers} onChange={set('autoCreateUsers')} />
      </FormRow>
      <FormRow
        name="Link Existing Accounts by Username"
        desc="Attach a provider sign-in to an existing Kitsune account with the same username. Only turn this on if people can't choose their own username at the provider."
        className={detailClass}
      >
        <ToggleField id="oidc-link-existing" checked={form.linkExistingByUsername} onChange={set('linkExistingByUsername')} />
      </FormRow>
      <FormRow name="Public URL" desc="Only needed if the Redirect URI above is wrong behind your reverse proxy, e.g. https://kitsune.example.com" className={detailClass}>
        <TextField id="oidc-public-url" placeholder={window.location.origin} value={form.publicUrl} onChange={set('publicUrl')} />
      </FormRow>

      <div className={`form-row ${detailClass}`}>
        <div className="field-label">
          <p className="name">Trusted CA Certificate</p>
          <p className="desc">
            For a provider behind a private CA: paste its root CA (and intermediate, if the provider doesn't send it) in PEM format.
            Used only for single sign-on requests.
          </p>
          {saved.caSummary && saved.caSummary.length > 0 && (
            <p className="desc" style={{ marginTop: 6 }}>
              Saved: {saved.caSummary.map((c) => `${c.subject} (expires ${new Date(c.validTo).toLocaleDateString()})`).join('; ')}
            </p>
          )}
        </div>
        <div className="field-control wide" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <textarea
            className="field-textarea" spellCheck={false} placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}
            value={form.caCertificate} onChange={(e) => set('caCertificate')(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            {form.caCertificate && <button type="button" onClick={() => set('caCertificate')('')}>Clear</button>}
            <button type="button" onClick={() => caFileRef.current?.click()}>Load from File</button>
          </div>
          <input
            ref={caFileRef} type="file" accept=".pem,.crt,.cer,.txt" style={{ display: 'none' }}
            onChange={(e) => { const file = e.target.files[0]; e.target.value = ''; if (file) handleCaFile(file); }}
          />
        </div>
      </div>
      <FormRow
        name="Skip Certificate Verification"
        desc="Insecure. Accepts any certificate from the provider, so anyone who can intercept this traffic could sign in as any user, including admins. Use the Trusted CA Certificate field instead whenever possible."
        className={detailClass}
      >
        <ToggleField id="oidc-skip-tls-verify" checked={form.skipTlsVerify} onChange={set('skipTlsVerify')} />
      </FormRow>
      {form.enabled && form.skipTlsVerify && (
        <p className="settings-warning">
          Certificate verification is off for single sign-on. Kitsune can't tell your real provider apart from an impostor on the network. Turn this off once a Trusted CA Certificate is in place.
        </p>
      )}

      {testResult && (
        testResult.ok ? (
          <p className="form-error" style={{ color: 'var(--success)', marginTop: 12 }}>
            Provider found: {testResult.issuer} ({testResult.keyCount} signing key{testResult.keyCount === 1 ? '' : 's'}
            {testResult.signingAlgs.length ? `, ${testResult.signingAlgs.join('/')}` : ''}){testResult.insecure ? ' — certificate not verified' : ''}.
          </p>
        ) : (
          <p className="form-error" style={{ marginTop: 12 }}>{testResult.error}</p>
        )
      )}
      {message && (
        <p className="form-error" style={{ marginTop: 12, color: message.kind === 'success' ? 'var(--success)' : undefined }}>{message.text}</p>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 12 }}>
        {form.enabled && (
          <button type="button" onClick={handleTest} disabled={testing || !form.issuer}>{testing ? 'Testing…' : 'Test Provider'}</button>
        )}
        {saved.hasClientSecret && form.enabled && (
          <button type="button" onClick={() => put({ clearClientSecret: true }, 'Client secret removed.')} disabled={saving}>Remove Secret</button>
        )}
        {dirty && <button type="button" onClick={handleRevert} disabled={saving}>Revert</button>}
        <button className="btn-accent" type="button" onClick={handleSave} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </SettingsCard>
  );
}
