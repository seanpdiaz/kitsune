import { useSettingsForm } from '../../lib/useSettingsForm.js';
import { ToggleField } from '../../components/SettingsFormFields.jsx';

// React port of settings-metadata.html's page logic — see README's "React
// migration" section. The last page in the migration: three metadata-writer
// sections (Kodi/Emby, Roksbox, WDTV), each a master toggle plus four
// per-item checkboxes that dim (not collapse — unlike Media Management's
// naming/permissions cascades) when their section's toggle is off, the same
// wireToggleCascade('metaXToggle', '.meta-field-x') behavior
// public/js/pages/settings-forms.js used to provide. Backed by
// useSettingsForm('metadata', ...), the same hook every other "one settings
// object" Settings page (Media Management, General, UI) already uses.
//
// Doesn't reuse SettingsCard/FormRow from components/SettingsFormFields.jsx
// — those assume a card-level `<h2>` title with the field name inside a
// `.form-row`, but this page's original markup puts the section name/desc
// directly in the first (header-less) row's own field-label instead, with
// `border-top:none` since there's no card header above it to separate from.
const DEFAULTS = {
  metaKodiToggle: true,
  'metadata-1': true,
  'metadata-2': true,
  'metadata-3': true,
  'metadata-4': false,
  metaRoksboxToggle: false,
  'metadata-6': true,
  'metadata-7': false,
  'metadata-8': true,
  'metadata-9': false,
  metaWdtvToggle: true,
  'metadata-11': true,
  'metadata-12': true,
  'metadata-13': false,
  'metadata-14': false,
};

const ITEM_LABELS = ['Series Metadata', 'Episode Metadata', 'Series Images', 'Episode Images'];

function MetadataSection({ name, desc, toggleId, fieldClass, itemKeys, values, setField }) {
  return (
    <div className="settings-card">
      <div className="form-row" style={{ borderTop: 'none', paddingTop: 0 }}>
        <div className="field-label"><p className="name">{name}</p><p className="desc">{desc}</p></div>
        <div className="field-control"><ToggleField id={toggleId} checked={values[toggleId]} onChange={(val) => setField(toggleId, val)} /></div>
      </div>
      <div className={fieldClass} style={{ display: 'flex', flexWrap: 'wrap', gap: '16px 28px', padding: '4px 0 14px' }}>
        {itemKeys.map((key, i) => (
          <label className="check-row" key={key}>
            <input type="checkbox" checked={!!values[key]} onChange={(e) => setField(key, e.target.checked)} /> {ITEM_LABELS[i]}
          </label>
        ))}
      </div>
    </div>
  );
}

export default function MetadataPage() {
  const { values: v, setField } = useSettingsForm('metadata', DEFAULTS);

  return (
    <>
      <p className="settings-subtitle">Write NFO files and images alongside your library for third-party media servers to read.</p>

      <MetadataSection
        name="Kodi (XBMC) / Emby" desc="NFO and image metadata compatible with Kodi and Emby libraries."
        toggleId="metaKodiToggle" fieldClass={`meta-field-kodi${!v.metaKodiToggle ? ' is-disabled' : ''}`}
        itemKeys={['metadata-1', 'metadata-2', 'metadata-3', 'metadata-4']} values={v} setField={setField}
      />
      <MetadataSection
        name="Roksbox" desc="XML metadata and thumbnails formatted for Roksbox."
        toggleId="metaRoksboxToggle" fieldClass={`meta-field-roksbox${!v.metaRoksboxToggle ? ' is-disabled' : ''}`}
        itemKeys={['metadata-6', 'metadata-7', 'metadata-8', 'metadata-9']} values={v} setField={setField}
      />
      <MetadataSection
        name="WDTV" desc="XML metadata formatted for WD TV Live media players."
        toggleId="metaWdtvToggle" fieldClass={`meta-field-wdtv${!v.metaWdtvToggle ? ' is-disabled' : ''}`}
        itemKeys={['metadata-11', 'metadata-12', 'metadata-13', 'metadata-14']} values={v} setField={setField}
      />
    </>
  );
}
