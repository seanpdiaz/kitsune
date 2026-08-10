import { useEffect, useState } from 'react';
import SimpleList, { fieldRow } from '../../components/SimpleList.jsx';

// Settings > Profiles — a faithful port of the `initSimpleList({ section:
// 'profiles', ... })` call at the bottom of
// public/js/pages/settings-profiles-formats.js. See SimpleList.jsx for the
// shared list+modal controller (also used by Custom Formats).

const profileTypes = [
  { key: 'blank', name: 'Blank profile' },
  { key: 'copy-hd1080p', name: 'Copy: HD-1080p' },
  { key: 'copy-dual', name: 'Copy: Anime - Dual Audio' },
];

export default function ProfilesPage({ addBtnContainer }) {
  // Cutoff options come from the real quality tiers list (Settings >
  // Quality — see server/routes/settings-items.js's 'quality-tiers'
  // section) instead of a second hardcoded copy of the tier names, fetched
  // once here since this page doesn't otherwise load that section. Falls
  // back to just the profile's own already-saved cutoff value if the fetch
  // hasn't landed yet (or fails) — the dropdown is never left empty.
  const [qualityTierNames, setQualityTierNames] = useState([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings-items/quality-tiers')
      .then((res) => res.json())
      .then((tiers) => { if (!cancelled) setQualityTierNames(tiers.map((t) => t.name).filter(Boolean)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function renderRow(item) {
    return (
      <>
        <p className="settings-title">{item.name}</p>
        <span className="settings-meta">{item.cutoff}</span>
        <span className="settings-meta">{item.qualities}</span>
        <span className="settings-meta">{item.upgrades ? 'Upgrades allowed' : 'No upgrades'}</span>
      </>
    );
  }

  function renderEditFields(item, onChange) {
    const options = qualityTierNames.length ? qualityTierNames : [item.cutoff];
    return (
      <>
        {fieldRow('Name', null, (
          <input className="field-input" type="text" value={item.name} onChange={(e) => onChange('name', e.target.value)} />
        ))}
        {fieldRow('Cutoff', 'Kitsune stops upgrading a series once a release at or above this quality is downloaded.', (
          <select className="field-select" value={item.cutoff} onChange={(e) => onChange('cutoff', e.target.value)}>
            {options.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        ))}
        {fieldRow('Upgrades allowed', null, (
          <label className="switch">
            <input type="checkbox" checked={!!item.upgrades} onChange={(e) => onChange('upgrades', e.target.checked)} />
            <span className="slider"></span>
          </label>
        ))}
        <p className="modal-label">Qualities: {item.qualities} — configured on the Quality page, not here.</p>
      </>
    );
  }

  return (
    <SimpleList
      section="profiles"
      types={profileTypes}
      headerLabels={['Name', 'Cutoff', 'Qualities', 'Upgrades', '', '']}
      baseClass="profile"
      addBtnLabel="Add profile"
      addBtnContainer={addBtnContainer}
      newItemFields={(type) => ({ name: type.name, cutoff: 'SDTV', qualities: '1 of 12', upgrades: true })}
      renderRow={renderRow}
      renderEditFields={renderEditFields}
    />
  );
}
