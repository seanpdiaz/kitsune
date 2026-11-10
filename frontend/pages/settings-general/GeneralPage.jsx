import { useSettingsForm } from '../../lib/useSettingsForm.js';
import { SettingsCard, FormRow, ToggleField, TextField, NumberField, SelectField } from '../../components/SettingsFormFields.jsx';

// React port of settings-general.html's page logic — see README's "React
// migration" section, Batch 8. The Proxy card's four detail rows only matter
// when Use Proxy is on (wireToggleCascade in the original) — now just a
// boolean computed straight off the loaded values instead of a DOM
// class-toggle listener.
//
// Authentication, Single Sign-On and the SSL certificate settings used to
// live here too; they moved to Settings > Security (frontend/pages/
// settings-security/). Their values still persist in this same 'general'
// app_settings section, so nothing server-side changed.
const DEFAULTS = {
  'general-0': '*',
  'general-1': 7879,
  'general-2': '',
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
  logRetentionDays: 14,
  historyRetentionDays: 90,
};

// Log Level is a minimum: entries below it are neither stored nor printed
// (see server/logger.js). Kitsune has no Trace level; a value saved back
// when this dropdown was decorative and offered "Trace" is shown as Debug,
// which is what the server applies for it too.
const LOG_LEVEL_OPTIONS = [
  { value: 'Debug', label: 'Debug' },
  { value: 'Info', label: 'Info' },
  { value: 'Warn', label: 'Warn' },
  { value: 'Error', label: 'Error' },
];
const LOG_LEVEL_DESC = {
  Debug: 'Everything, including every HTTP request. Very noisy.',
  Info: 'Info, warnings and errors. Recommended.',
  Warn: 'Warnings and errors only.',
  Error: 'Errors only.',
};

export default function GeneralPage() {
  const { values: v, setField } = useSettingsForm('general', DEFAULTS);
  const proxyDisabled = !v.proxyEnabledToggle;
  const logLevel = v['general-17'] === 'Trace' ? 'Debug' : (v['general-17'] || 'Info');

  return (
    <>
      <p className="settings-subtitle">Networking, proxy, updates, backups, logging, and history.</p>

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
        <FormRow name="Branch" desc="Which branch to check GitHub for updates against.">
          <SelectField id="general-12" value={v['general-12']} onChange={(val) => setField('general-12', val)} options={['main', 'development']} />
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

      <SettingsCard title="Logging" desc="What System > Logs keeps, and for how long.">
        <FormRow name="Log Level" desc={`${LOG_LEVEL_DESC[logLevel]} Lower levels are discarded.`}>
          <SelectField id="general-17" value={logLevel} onChange={(val) => setField('general-17', val)} options={LOG_LEVEL_OPTIONS} />
        </FormRow>
        <FormRow name="Log Retention" desc="Days to keep log entries before deleting (1–365).">
          <NumberField id="logRetentionDays" value={v.logRetentionDays} onChange={(val) => setField('logRetentionDays', val)} />
        </FormRow>
        <FormRow name="Log to File">
          <ToggleField id="general-18" checked={v['general-18']} onChange={(val) => setField('general-18', val)} />
        </FormRow>
      </SettingsCard>

      <SettingsCard title="History" desc="Grab, import, failure and deletion events shown on Activity > History.">
        <FormRow name="History Retention" desc="Days to keep history before deleting. 0 keeps it forever.">
          <NumberField id="historyRetentionDays" value={v.historyRetentionDays} onChange={(val) => setField('historyRetentionDays', val)} />
        </FormRow>
      </SettingsCard>
    </>
  );
}
