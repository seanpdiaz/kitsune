import { useSettingsForm } from '../../lib/useSettingsForm.js';
import { SettingsCard, FormRow, ToggleField, SelectField } from '../../components/SettingsFormFields.jsx';

// React port of settings-ui.html's page logic — see README's "React
// migration" section, Batch 8. The Theme card's radio pair is carried over
// as-is: Light was already `disabled` in the original static markup (dark
// is the only real option — "Kitsune ships dark-only for now"), so Dark's
// radio has nothing to actually toggle between and isn't wired to
// setField the way every other control here is; it's rendered checked and
// inert, matching what the original already behaved like in practice.
const DEFAULTS = {
  'ui-0': 'Monday',
  'ui-1': true,
  'ui-2': false,
  'ui-3': 'Poster',
  'ui-4': true,
  'ui-5': true,
  'ui-6': 'MMM D YYYY',
  'ui-7': '24 hour',
};

export default function UiPage() {
  const { values: v, setField } = useSettingsForm('ui', DEFAULTS);

  return (
    <>
      <p className="settings-subtitle">Calendar, library view, date/time, and appearance preferences.</p>

      <SettingsCard title="Calendar">
        <FormRow name="First Day of Week">
          <SelectField id="ui-0" value={v['ui-0']} onChange={(val) => setField('ui-0', val)} options={['Sunday', 'Monday']} />
        </FormRow>
        <FormRow name="Show Relative Dates">
          <ToggleField id="ui-1" checked={v['ui-1']} onChange={(val) => setField('ui-1', val)} />
        </FormRow>
        <FormRow name="Collapse Multiple Episodes">
          <ToggleField id="ui-2" checked={v['ui-2']} onChange={(val) => setField('ui-2', val)} />
        </FormRow>
      </SettingsCard>

      <SettingsCard title="Series">
        <FormRow name="Default Library View">
          <SelectField id="ui-3" value={v['ui-3']} onChange={(val) => setField('ui-3', val)} options={['Poster', 'Overview', 'Table']} />
        </FormRow>
        <FormRow name="Show Search Action">
          <ToggleField id="ui-4" checked={v['ui-4']} onChange={(val) => setField('ui-4', val)} />
        </FormRow>
        <FormRow name="Show Episode Count">
          <ToggleField id="ui-5" checked={v['ui-5']} onChange={(val) => setField('ui-5', val)} />
        </FormRow>
      </SettingsCard>

      <SettingsCard title="Dates &amp; Time">
        <FormRow name="Short Date Format">
          <SelectField id="ui-6" value={v['ui-6']} onChange={(val) => setField('ui-6', val)} options={['MMM D YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY']} />
        </FormRow>
        <FormRow name="Time Format">
          <SelectField id="ui-7" value={v['ui-7']} onChange={(val) => setField('ui-7', val)} options={['12 hour', '24 hour']} />
        </FormRow>
      </SettingsCard>

      <SettingsCard title="Theme">
        <FormRow name="Appearance" desc="Kitsune ships dark-only for now.">
          <div className="radio-group">
            <label className="radio-option"><input type="radio" name="theme" checked readOnly /> Dark</label>
            <label className="radio-option" style={{ opacity: 0.4 }}><input type="radio" name="theme" disabled /> Light (coming soon)</label>
          </div>
        </FormRow>
      </SettingsCard>
    </>
  );
}
