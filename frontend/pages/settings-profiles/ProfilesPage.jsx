import { useEffect, useState } from 'react';
import SimpleList, { fieldRow } from '../../components/SimpleList.jsx';
import { icons } from '../../lib/icons.jsx';

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

  // Which profile (by id, not name — stable across a rename, see
  // server/routes/series.js's getDefaultQualityProfileName) is used to
  // pre-select Add New's Quality Profile dropdown and as POST /api/series'
  // own fallback when nothing's explicitly chosen. Stored under the generic
  // /api/app-settings/:section endpoint (server/routes/app-settings.js) —
  // no dedicated route needed, same as every other plain-field settings
  // page already reads/writes through it.
  const [defaultProfileId, setDefaultProfileId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/app-settings/library-defaults')
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setDefaultProfileId(data.defaultQualityProfileId ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function setAsDefault(item) {
    setDefaultProfileId(item.id); // optimistic — matches SimpleList's own edit/remove pattern
    fetch('/api/app-settings/library-defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultQualityProfileId: item.id }),
    }).catch(() => {});
  }

  // A profile row from before this feature existed (or one that's simply
  // never had its qualities touched) has no `allowedQualities` array at all
  // — defaulted to "every known tier" here, the same permissive default
  // server/lib/quality.js's getQualityProfile() uses server-side, so a
  // profile nobody's edited yet behaves exactly as it always implicitly did
  // (nothing excluded) rather than suddenly allowing nothing until saved.
  function allowedFor(item) {
    return item.allowedQualities || qualityTierNames;
  }

  function renderRow(item) {
    const allowed = allowedFor(item);
    const isDefault = defaultProfileId === item.id;
    return (
      <>
        <p className="settings-title">{item.name}</p>
        <span className="settings-meta">{item.cutoff}</span>
        <span className="settings-meta">{allowed.length} of {qualityTierNames.length || allowed.length}</span>
        <span className="settings-meta">{item.upgrades ? 'Upgrades allowed' : 'No upgrades'}</span>
        <button
          type="button"
          className={`default-profile-btn${isDefault ? ' active' : ''}`}
          data-tooltip={isDefault ? 'Default profile' : 'Set as default'}
          aria-label={isDefault ? `${item.name} is the default quality profile for new series` : `Set ${item.name} as the default quality profile for new series`}
          onClick={(e) => { e.stopPropagation(); if (!isDefault) setAsDefault(item); }}
        >
          {isDefault && icons.check}
        </button>
      </>
    );
  }

  function renderEditFields(item, onChange) {
    const options = qualityTierNames.length ? qualityTierNames : [item.cutoff];
    const allowed = allowedFor(item);

    function toggleQuality(name, checked) {
      const next = checked ? [...allowed, name] : allowed.filter((n) => n !== name);
      // Order doesn't matter for correctness (search re-derives rank from
      // Settings > Quality's own live tier order every time — see
      // server/lib/quality.js), just keeping it in the same worst-to-best
      // order as the checkbox list itself so a later re-render doesn't
      // visually reshuffle anything.
      onChange('allowedQualities', qualityTierNames.filter((n) => next.includes(n)));
    }

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
        {/* Not wrapped in fieldRow — its fixed-width 280/360px field-control
            column has no room for up to a dozen checkboxes side by side; a
            full-width block below the other fields (same spot the old
            static "Qualities: X of Y" text occupied) fits a checklist much
            better. */}
        <p className="modal-label">
          Qualities — releases in these tiers are ranked to the top of search results and eligible
          for "Grab best match." Releases outside this list still show up (never hidden), just
          flagged and sorted lower.
        </p>
        <div className="quality-checklist">
          {qualityTierNames.map((name) => (
            <label key={name} className="quality-checklist-item">
              <input
                type="checkbox"
                checked={allowed.includes(name)}
                onChange={(e) => toggleQuality(name, e.target.checked)}
              />
              {name}
            </label>
          ))}
          {qualityTierNames.length === 0 && <p className="desc">Loading quality tiers…</p>}
        </div>
      </>
    );
  }

  return (
    <SimpleList
      section="profiles"
      types={profileTypes}
      headerLabels={['Name', 'Cutoff', 'Qualities', 'Upgrades', 'Default', '', '']}
      baseClass="profile"
      addBtnLabel="Add profile"
      addBtnContainer={addBtnContainer}
      newItemFields={(type) => ({ name: type.name, cutoff: 'SDTV', allowedQualities: qualityTierNames, upgrades: true })}
      renderRow={renderRow}
      renderEditFields={renderEditFields}
    />
  );
}
