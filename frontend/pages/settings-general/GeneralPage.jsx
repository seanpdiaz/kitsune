import { useSettingsForm } from '../../lib/useSettingsForm.js';
import { SettingsCard, FormRow, ToggleField, TextField, NumberField, SelectField } from '../../components/SettingsFormFields.jsx';

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

export default function GeneralPage() {
  const { values: v, setField } = useSettingsForm('general', DEFAULTS);
  const authHidden = v.authMethodSelect === 'none';
  const proxyDisabled = !v.proxyEnabledToggle;

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
