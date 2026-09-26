import { useEffect, useRef, useState } from 'react';
import { useSettingsForm } from '../../lib/useSettingsForm.js';
import { SettingsCard, FormRow, ToggleField, TextField, SelectField } from '../../components/SettingsFormFields.jsx';
import { icons } from '../../lib/icons.jsx';
import { formatBytes } from '../../../public/js/lib/format.js';
import OidcSettings from './OidcSettings.jsx';

// Settings > Security — everything about who can reach Kitsune and how:
// Authentication Method, Single Sign-On (OIDC) and the SSL certificate.
// These used to be cards on Settings > General and moved here as General
// grew. Authentication and SSL still save into the same 'general'
// app_settings section they always did (server/routes/auth.js reads
// authMethodSelect from there), so this page only takes over their keys —
// useSettingsForm saves just the fields that change, so the two pages never
// overwrite each other. Single Sign-On has its own admin-only config API
// (see OidcSettings.jsx). Admin-only in the sidebar (public/js/nav.js).
const DEFAULTS = {
  authMethodSelect: 'forms',
  'general-5': 'admin',
  'general-6': 'notarealpassword',
  'general-3': false,
};

// Reads a browser File as a base64 string (no data: URL prefix) for
// server/routes/ssl.js's { filename, contentBase64 } upload body — the
// zero-dependency backend has no multipart-form parser, so JSON + base64 is
// the simplest way to get file bytes there without adding one.
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}

// One certificate/key upload slot: a "Choose File" button when nothing's
// uploaded yet, or the uploaded file's name + size + a Remove button once
// something's on the server (per server/routes/ssl.js's /api/ssl/status).
function SslFileField({ label, status, error, uploading, onUpload, onRemove }) {
  const inputRef = useRef(null);
  return (
    <div className="ssl-file-field">
      {status ? (
        <div className="ssl-file-current">
          <span className="ssl-file-name" title={status.filename}>{status.filename}</span>
          <span className="settings-meta">{formatBytes(status.sizeBytes)}</span>
          <button type="button" className="ep-action" aria-label={`Remove ${label}`} data-tooltip="Remove file" onClick={onRemove}>{icons.x}</button>
        </div>
      ) : (
        <button type="button" className="btn-test" disabled={uploading} onClick={() => inputRef.current?.click()}>
          {uploading ? 'Uploading…' : 'Choose File'}
        </button>
      )}
      <input
        ref={inputRef} type="file" accept=".pem,.crt,.cer,.key,.txt" style={{ display: 'none' }}
        onChange={(e) => { const file = e.target.files[0]; e.target.value = ''; if (file) onUpload(file); }}
      />
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

export default function SecurityPage() {
  const { values: v, setField } = useSettingsForm('general', DEFAULTS);
  const authHidden = v.authMethodSelect === 'none';
  const sslHidden = !v['general-3'];

  // Cert/key upload status is real server state (server/routes/ssl.js), not
  // part of the generic app_settings 'general' blob the rest of this page's
  // fields save into — it's file bytes on disk, not a form value, so it gets
  // its own fetch-on-mount + its own POST/DELETE calls instead of routing
  // through useSettingsForm's setField/debounce-save path.
  const [sslStatus, setSslStatus] = useState({ cert: null, key: null });
  const [sslUploading, setSslUploading] = useState({ cert: false, key: false });
  const [sslErrors, setSslErrors] = useState({ cert: '', key: '' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/ssl/status')
      .then((res) => res.json())
      .then((body) => { if (!cancelled) setSslStatus(body); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function handleSslUpload(kind, file) {
    setSslUploading((u) => ({ ...u, [kind]: true }));
    setSslErrors((e) => ({ ...e, [kind]: '' }));
    try {
      const contentBase64 = await readFileAsBase64(file);
      const res = await fetch(`/api/ssl/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentBase64 }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSslStatus((s) => ({ ...s, [kind]: body }));
    } catch (err) {
      setSslErrors((e) => ({ ...e, [kind]: err.message || 'Upload failed — try again.' }));
    } finally {
      setSslUploading((u) => ({ ...u, [kind]: false }));
    }
  }

  function handleSslRemove(kind) {
    setSslStatus((s) => ({ ...s, [kind]: null }));
    setSslErrors((e) => ({ ...e, [kind]: '' }));
    fetch(`/api/ssl/${kind}`, { method: 'DELETE' }).catch(() => {});
  }

  return (
    <>
      <p className="settings-subtitle">Sign-in, single sign-on, and HTTPS.</p>

      <SettingsCard title="Authentication" desc="Require a login to access Kitsune.">
        <FormRow name="Authentication Method">
          <SelectField
            id="authMethodSelect" value={v.authMethodSelect} onChange={(val) => setField('authMethodSelect', val)}
            options={[{ value: 'none', label: 'None' }, { value: 'basic', label: 'Basic (browser popup)' }, { value: 'forms', label: 'Forms (login page)' }]}
          />
        </FormRow>
        <FormRow name="Username" className={`auth-field${authHidden ? ' is-collapsed' : ''}`}>
          <TextField id="general-5" value={v['general-5']} onChange={(val) => setField('general-5', val)} />
        </FormRow>
        <FormRow name="Password" className={`auth-field${authHidden ? ' is-collapsed' : ''}`}>
          <TextField id="general-6" type="password" value={v['general-6']} onChange={(val) => setField('general-6', val)} />
        </FormRow>
      </SettingsCard>

      <OidcSettings />

      <SettingsCard title="SSL" desc="Serve the Kitsune web interface over HTTPS.">
        <FormRow name="Enable SSL">
          <ToggleField id="general-3" checked={v['general-3']} onChange={(val) => setField('general-3', val)} />
        </FormRow>
        <FormRow name="Certificate" desc="PEM-encoded certificate file." className={`ssl-field${sslHidden ? ' is-collapsed' : ''}`}>
          <SslFileField
            label="certificate" status={sslStatus.cert} error={sslErrors.cert} uploading={sslUploading.cert}
            onUpload={(file) => handleSslUpload('cert', file)} onRemove={() => handleSslRemove('cert')}
          />
        </FormRow>
        <FormRow name="Private Key" desc="PEM-encoded private key file." className={`ssl-field${sslHidden ? ' is-collapsed' : ''}`}>
          <SslFileField
            label="private key" status={sslStatus.key} error={sslErrors.key} uploading={sslUploading.key}
            onUpload={(file) => handleSslUpload('key', file)} onRemove={() => handleSslRemove('key')}
          />
        </FormRow>
      </SettingsCard>
    </>
  );
}
