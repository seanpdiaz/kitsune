import SimpleList, { fieldRow } from '../../components/SimpleList.jsx';

// Settings > Custom Formats — a faithful port of the `initSimpleList({
// section: 'custom-formats', ... })` call at the bottom of
// public/js/pages/settings-profiles-formats.js. See SimpleList.jsx for the
// shared list+modal controller (also used by Profiles).

const formatTypes = [
  { key: 'hi10p', name: 'Hi10p' },
  { key: 'bd-menu', name: 'BD Menu/Extras' },
  { key: 'v0-vbr', name: 'V0 (VBR)' },
];

function renderRow(item) {
  return (
    <>
      <p className="settings-title">{item.name}</p>
      <span className="count-badge">{item.conditions} condition{item.conditions === 1 ? '' : 's'}</span>
      <span className="count-badge">used in {item.profiles} profile{item.profiles === 1 ? '' : 's'}</span>
    </>
  );
}

function renderEditFields(item, onChange) {
  return (
    <>
      {fieldRow('Name', null, (
        <input className="field-input" type="text" value={item.name} onChange={(e) => onChange('name', e.target.value)} />
      ))}
      {fieldRow('Conditions', null, (
        <input className="field-input" type="number" min="0" value={item.conditions} onChange={(e) => onChange('conditions', Number(e.target.value))} />
      ))}
      {fieldRow('Used in profiles', null, (
        <input className="field-input" type="number" min="0" value={item.profiles} onChange={(e) => onChange('profiles', Number(e.target.value))} />
      ))}
    </>
  );
}

export default function CustomFormatsPage({ addBtnContainer }) {
  return (
    <SimpleList
      section="custom-formats"
      types={formatTypes}
      headerLabels={['Name', 'Conditions', 'Used in', '', '']}
      baseClass="format"
      addBtnLabel="Add custom format"
      addBtnContainer={addBtnContainer}
      newItemFields={(type) => ({ name: type.name, conditions: 0, profiles: 0 })}
      renderRow={renderRow}
      renderEditFields={renderEditFields}
    />
  );
}
