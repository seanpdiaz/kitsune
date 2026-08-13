import { useEffect, useRef, useState } from 'react';
import { useSettingsForm } from '../../lib/useSettingsForm.js';
import { SettingsCard, FormRow, ToggleField, TextField, NumberField, SelectField } from '../../components/SettingsFormFields.jsx';
import { icons } from '../../lib/icons.jsx';
import { formatBytes } from '../../../public/js/lib/format.js';

// React port of settings-general.html's page logic — see README's "React
// migration" section, Batch 8. The Authentication card's Username/Password
// rows only matter when a method other than "None" is picked (wireSelectCascade
// in the original); the Proxy card's four detail rows only matter when Use
// Proxy is on (wireToggleCascade) — both cascades are now just a boolean
// computed straight off the loaded values instead of a DOM class-toggle
// listener.
const DEFAULTS = {
  'general-0': '*',
  'general-1': 7879,
  'general-2': '',
  'general-3': false,
  authMethodSelect: 'forms',
  'general-5': 'admin',
  'general-6': 'notarealpassword',
  proxyEnabledToggle: false,
  'general-8': '',
  'general-9': 8080,
  'general-10': '',
  'general-11': '',
  'general-12': 'main',
  'general-13': true,
  'general-14': '/config/backups',
  'general-15': 'Every 7 days',
  'general-16': 28,
  'general-17': 'Info',
  'general-18': true,
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
          <button type="button" className="ep-action" aria-label={`Remove ${label}`} onClick={onRemove}>{icons.x}</button>
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

export default function GeneralPage() {
  const { values: v, setField } = useSettingsForm('general', DEFAULTS);
  const authHidden = v.authMethodSelect === 'none';
  const proxyDisabled = !v.proxyEnabledToggle;
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
      <p className="settings-subtitle">Networking, authentication, updates, backups, and logging.</p>

      <SettingsCard title="Host" desc="Network binding for the Kitsune web interface.">
        <FormRow name="Bind Address" desc="Interface Kitsune listens on.">
          <TextField id="general-0" value={v['general-0']} onChange={(val) => setField('general-0', val)} />
        </FormRow>
        <FormRow name="Port Number">
          <NumberField id="general-1" value={v['general-1']} onChange={(val) => setField('general-1', val)} />
        </FormRow>
        <FormRow name="URL Base" desc="For reverse proxy setups, e.g. /kitsune.">
          <TextField id="general-2" placeholder="/kitsune" value={v['general-2']} onChange={(val) => setField('general-2', val)} />
        </FormRow>
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

      <SettingsCard title="Proxy">
        <FormRow name="Use Proxy">
          <ToggleField id="proxyEnabledToggle" checked={v.proxyEnabledToggle} onChange={(val) => setField('proxyEnabledToggle', val)} />
        </FormRow>
        <FormRow name="Proxy Host" className={`proxy-field${proxyDisabled ? ' is-disabled' : ''}`}>
          <TextField id="general-8" value={v['general-8']} onChange={(val) => setField('general-8', val)} />
        </FormRow>
        <FormRow name="Proxy Port" className={`proxy-field${proxyDisabled ? ' is-disabled' : ''}`}>
          <NumberField id="general-9" value={v['general-9']} onChange={(val) => setField('general-9', val)} />
        </FormRow>
        <FormRow name="Username" className={`proxy-field${proxyDisabled ? ' is-disabled' : ''}`}>
          <TextField id="general-10" value={v['general-10']} onChange={(val) => setField('general-10', val)} />
        </FormRow>
        <FormRow name="Password" className={`proxy-field${proxyDisabled ? ' is-disabled' : ''}`}>
          <TextField id="general-11" type="password" value={v['general-11']} onChange={(val) => setField('general-11', val)} />
        </FormRow>
      </SettingsCard>

      <SettingsCard title="Updates">
        <FormRow name="Branch">
          <SelectField id="general-12" value={v['general-12']} onChange={(val) => setField('general-12', val)} options={['main', 'develop']} />
        </FormRow>
        <FormRow name="Automatic">
          <ToggleField id="general-13" checked={v['general-13']} onChange={(val) => setField('general-13', val)} />
        </FormRow>
      </SettingsCard>

      <SettingsCard title="Backups">
        <FormRow name="Folder">
          <TextField id="general-14" value={v['general-14']} onChange={(val) => setField('general-14', val)} />
        </FormRow>
        <FormRow name="Interval">
          <SelectField id="general-15" value={v['general-15']} onChange={(val) => setField('general-15', val)} options={['Every 1 day', 'Every 7 days']} />
        </FormRow>
        <FormRow name="Retention" desc="Days to keep backups before deleting.">
          <NumberField id="general-16" value={v['general-16']} onChange={(val) => setField('general-16', val)} />
        </FormRow>
      </SettingsCard>

      <SettingsCard title="Logging">
        <FormRow name="Log Level">
          <SelectField id="general-17" value={v['general-17']} onChange={(val) => setField('general-17', val)} options={['Info', 'Debug', 'Trace']} />
        </FormRow>
        <FormRow name="Log to File">
          <ToggleField id="general-18" checked={v['general-18']} onChange={(val) => setField('general-18', val)} />
        </FormRow>
      </SettingsCard>
    </>
  );
}
