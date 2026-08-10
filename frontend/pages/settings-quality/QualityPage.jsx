import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../../lib/icons.jsx';
import { mountRangeSlider } from '../../../public/js/lib/range-slider.js';
import { formatBytes } from '../../../public/js/lib/format.js';

// React port of public/js/pages/settings-quality.js — see README's "React
// migration" section, Batch 8, for the reasoning behind reusing
// range-slider.js's mountRangeSlider() as-is (imperative ref-mount) instead
// of rewriting its drag/keyboard/dblclick-to-edit logic in JSX: that file is
// a battle-tested, self-contained widget with no DOM dependencies outside
// its own container, and the bugs its comments document (the min-gap trap,
// the GB/MB edit-box unit bug) are exactly the kind of regression a
// from-scratch rewrite risks reintroducing for no benefit — reusing it
// keeps this port faithful by construction.

const KNOWN_GROUP_ORDER = ['SD', '720p', '1080p', '2160p'];

const KNOWN_TIER_DEFAULTS = {
  'SDTV': { min: 2, preferred: 60, max: 100 },
  'WEBDL-480p': { min: 2, preferred: 70, max: 110 },
  'HDTV-720p': { min: 8, preferred: 100, max: 150 },
  'WEBDL-720p': { min: 8, preferred: 110, max: 160 },
  'Bluray-720p': { min: 8, preferred: 130, max: 190 },
  'HDTV-1080p': { min: 15, preferred: 150, max: 200 },
  'WEBDL-1080p': { min: 15, preferred: 160, max: 220 },
  'Bluray-1080p': { min: 15, preferred: 200, max: 280 },
  'HDTV-2160p': { min: 30, preferred: 300, max: 400 },
  'WEBDL-2160p': { min: 30, preferred: 320, max: 450 },
  'Bluray-2160p': { min: 30, preferred: 400, max: 550 },
};

const PRESETS = {
  'storage-saver': { mult: 0.6, forceUnlimitedGroups: [] },
  'balanced': { mult: 1.0, forceUnlimitedGroups: [] },
  'high-bitrate': { mult: 1.6, forceUnlimitedGroups: [] },
  'remux-focus': { mult: 2.4, forceUnlimitedGroups: ['1080p', '2160p'] },
};

const GROUP_STARTING_DEFAULTS = {
  'SD': { min: 2, preferred: 65, max: 105 },
  '720p': { min: 8, preferred: 115, max: 165 },
  '1080p': { min: 15, preferred: 170, max: 230 },
  '2160p': { min: 30, preferred: 340, max: 470 },
};
const FALLBACK_STARTING_DEFAULTS = { min: 10, preferred: 100, max: 150 };

function orderedGroups(tiers) {
  const present = [...new Set(tiers.map((t) => t.resolutionGroup || 'Other'))];
  const known = KNOWN_GROUP_ORDER.filter((g) => present.includes(g));
  const custom = present.filter((g) => !KNOWN_GROUP_ORDER.includes(g)).sort();
  return [...known, ...custom];
}

function groupDatalistOptions(tiers) {
  const custom = [...new Set(tiers.map((t) => t.resolutionGroup).filter((g) => g && !KNOWN_GROUP_ORDER.includes(g)))];
  return [...KNOWN_GROUP_ORDER, ...custom];
}

// Each row's slider zooms to its own tier's scale rather than sharing one
// global 0..N range that would squeeze small tiers into a sliver of track.
function boundsForTier(tier) {
  const top = Math.max(tier.maxMBPerMin || 0, tier.preferredMBPerMin || 0, 10);
  return { min: 0, max: Math.ceil((top * 1.6) / 10) * 10 };
}

function QualityTierRow({ tier, idx, total, bounds, format, parse, onCommit, onFieldCommit, onRemove, onMoveUp, onMoveDown }) {
  const mountRef = useRef(null);
  const targetValueRef = useRef(null);
  const targetNoteRef = useRef(null);

  useEffect(() => {
    if (!mountRef.current) return;
    function updateReadout(v) {
      if (targetValueRef.current) targetValueRef.current.textContent = `~ ${format(v.preferred)}`;
      if (targetNoteRef.current) targetNoteRef.current.textContent = v.maxUnlimited ? 'no cap' : '';
    }
    const controller = mountRangeSlider(mountRef.current, {
      min: bounds.min, max: bounds.max, step: 1,
      value: { min: tier.minMBPerMin, preferred: tier.preferredMBPerMin, max: tier.maxMBPerMin, maxUnlimited: !!tier.maxUnlimited },
      format,
      parse,
      onChange: updateReadout,
      onCommit,
    });
    updateReadout(controller.getValue());
    // No explicit teardown API from mountRangeSlider — this row remounts by
    // key (see QualityPage's `tick`) any time any tier commits, same as
    // settings-quality.js's renderAll() rebuilding every row's innerHTML on
    // every change; React discarding this container's DOM on unmount is
    // equivalent to that overwrite.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="quality-tier-row" data-id={tier.id}>
      <div className="quality-tier-name-field">
        <input
          className="field-input" type="text" defaultValue={tier.name} aria-label="Quality name"
          onBlur={(e) => {
            const value = e.target.value.trim();
            if (!value) { e.target.value = tier.name; return; }
            if (value !== tier.name) onFieldCommit('name', value);
          }}
        />
        <div className="quality-tier-group-field">
          <span className="settings-meta">Group</span>
          <input
            type="text" list="qualityGroupOptions" defaultValue={tier.resolutionGroup || ''} aria-label="Resolution group"
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (!value) { e.target.value = tier.resolutionGroup || ''; return; }
              if (value !== tier.resolutionGroup) onFieldCommit('resolutionGroup', value);
            }}
          />
        </div>
      </div>
      <div className="quality-slider-mount" ref={mountRef}></div>
      <div className="quality-target">
        <p className="label">Target Size</p>
        <p className="value" ref={targetValueRef}>—</p>
        <p className="settings-meta" ref={targetNoteRef} style={{ fontSize: '10px', margin: '2px 0 0' }}></p>
      </div>
      <div className="quality-tier-actions">
        <button className="ep-action" type="button" disabled={idx === 0} aria-label={`Move ${tier.name} up in rank`} onClick={onMoveUp}>{icons.arrowUp}</button>
        <button className="ep-action" type="button" disabled={idx === total - 1} aria-label={`Move ${tier.name} down in rank`} onClick={onMoveDown}>{icons.arrowDown}</button>
        <button className="ep-action" type="button" aria-label={`Remove ${tier.name}`} onClick={onRemove}>{icons.x}</button>
      </div>
    </div>
  );
}

export default function QualityPage({ addBtnContainer }) {
  const [tiers, setTiers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [unit, setUnit] = useState('size');
  const [runtimeMinutes, setRuntimeMinutes] = useState(24);
  // Bumped after any add/remove/rename/reorder/preset/runtime/unit change —
  // used as part of each row's React key to force a full slider remount,
  // matching the original's renderAll() rebuilding every row on every change.
  const [tick, setTick] = useState(0);

  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addGroup, setAddGroup] = useState('');
  const [addError, setAddError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/app-settings/quality-ui-prefs');
        const saved = await res.json();
        if (saved.unit) setUnit(saved.unit);
        if (saved.runtimeMinutes) setRuntimeMinutes(saved.runtimeMinutes);
      } catch { /* defaults stand */ }
      try {
        const res = await fetch('/api/settings-items/quality-tiers');
        setTiers(await res.json());
      } catch {
        setTiers([]);
      }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    function onKeydown(e) {
      if (e.key === 'Escape' && addOpen) setAddOpen(false);
    }
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  }, [addOpen]);

  function formatValue(mbPerMin) {
    if (unit === 'rate') return `${Math.round(mbPerMin)} MB/min`;
    return formatBytes(Math.round(mbPerMin * runtimeMinutes * 1024 * 1024));
  }

  // The reverse of formatValue() for the slider's double-click-to-edit
  // boxes — see range-slider.js's options.parse for why `defaultUnit`
  // matters (a bare typed number falls back to whatever unit the box was
  // pre-filled with, not a fixed one).
  function parseValue(text, defaultUnit) {
    const match = String(text).trim().match(/^(-?[\d.]+)\s*([a-zA-Z/]*)$/);
    if (!match) return NaN;
    const num = parseFloat(match[1]);
    if (Number.isNaN(num)) return NaN;
    if (unit === 'rate') return num;
    const suffix = (match[2] || defaultUnit || 'MB').toLowerCase();
    let bytes;
    if (suffix.startsWith('gb')) bytes = num * 1024 * 1024 * 1024;
    else if (suffix.startsWith('kb')) bytes = num * 1024;
    else bytes = num * 1024 * 1024;
    return bytes / (runtimeMinutes * 1024 * 1024);
  }

  function patchTier(id, fields) {
    fetch(`/api/settings-items/quality-tiers/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
    }).catch(() => {});
  }

  function commitSliderChange(id, value) {
    setTiers((prev) => prev.map((t) => (t.id === id
      ? { ...t, minMBPerMin: value.min, preferredMBPerMin: value.preferred, maxMBPerMin: value.max, maxUnlimited: value.maxUnlimited }
      : t)));
    patchTier(id, { minMBPerMin: value.min, preferredMBPerMin: value.preferred, maxMBPerMin: value.max, maxUnlimited: value.maxUnlimited });
    setTick((t) => t + 1);
  }

  function handleFieldCommit(id, field, value) {
    setTiers((prev) => prev.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
    patchTier(id, { [field]: value });
    setTick((t) => t + 1);
  }

  function removeTier(id) {
    setTiers((prev) => prev.filter((t) => t.id !== id));
    fetch(`/api/settings-items/quality-tiers/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  // Up/down move a tier's global rank by one — swaps `position` with the
  // neighbor immediately better/worse in the flat list, regardless of which
  // resolution group that neighbor happens to display under.
  function moveTier(id, direction) {
    setTiers((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const swapIdx = idx + direction;
      if (idx === -1 || swapIdx < 0 || swapIdx >= prev.length) return prev;
      const a = prev[idx];
      const b = prev[swapIdx];
      const updatedA = { ...a, position: b.position };
      const updatedB = { ...b, position: a.position };
      const next = prev.map((t) => {
        if (t.id === a.id) return updatedA;
        if (t.id === b.id) return updatedB;
        return t;
      });
      next.sort((x, y) => x.position - y.position);
      patchTier(updatedA.id, { position: updatedA.position });
      patchTier(updatedB.id, { position: updatedB.position });
      return next;
    });
    setTick((t) => t + 1);
  }

  function toggleGroup(name) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function applyPreset(key) {
    const preset = PRESETS[key];
    if (!preset) return;
    setTiers((prev) => prev.map((tier) => {
      const baseline = KNOWN_TIER_DEFAULTS[tier.name]
        || { min: tier.minMBPerMin, preferred: tier.preferredMBPerMin, max: tier.maxMBPerMin };
      const updated = {
        ...tier,
        minMBPerMin: Math.max(1, Math.round(baseline.min * preset.mult)),
        preferredMBPerMin: Math.round(baseline.preferred * preset.mult),
        maxMBPerMin: Math.round(baseline.max * preset.mult),
        maxUnlimited: preset.forceUnlimitedGroups.includes(tier.resolutionGroup),
      };
      patchTier(tier.id, {
        minMBPerMin: updated.minMBPerMin, preferredMBPerMin: updated.preferredMBPerMin,
        maxMBPerMin: updated.maxMBPerMin, maxUnlimited: updated.maxUnlimited,
      });
      return updated;
    }));
    setTick((t) => t + 1);
  }

  function saveUiPrefs(nextUnit, nextRuntime) {
    fetch('/api/app-settings/quality-ui-prefs', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unit: nextUnit, runtimeMinutes: nextRuntime }),
    }).catch(() => {});
  }

  function handleRuntimeChange(value) {
    const n = Number(value);
    setRuntimeMinutes(n);
    saveUiPrefs(unit, n);
    setTick((t) => t + 1);
  }

  function handleUnitChange(value) {
    setUnit(value);
    saveUiPrefs(value, runtimeMinutes);
    setTick((t) => t + 1);
  }

  function openAddModal() {
    setAddName('');
    setAddGroup('');
    setAddError('');
    setAddOpen(true);
  }

  async function confirmAddTier() {
    const name = addName.trim();
    const resolutionGroup = addGroup.trim() || '1080p';
    if (!name) { setAddError('Give it a name first.'); return; }
    if (tiers.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      setAddError('A quality with that name already exists.');
      return;
    }
    const defaults = GROUP_STARTING_DEFAULTS[resolutionGroup] || FALLBACK_STARTING_DEFAULTS;
    const body = {
      name, resolutionGroup,
      minMBPerMin: defaults.min, preferredMBPerMin: defaults.preferred, maxMBPerMin: defaults.max, maxUnlimited: false,
    };
    let created;
    try {
      const res = await fetch('/api/settings-items/quality-tiers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      created = await res.json();
    } catch {
      created = { id: `tmp-${Date.now()}`, position: tiers.length, ...body };
    }
    setTiers((prev) => [...prev, created]);
    setCollapsedGroups((prev) => { const next = new Set(prev); next.delete(resolutionGroup); return next; });
    setAddOpen(false);
    setTick((t) => t + 1);
  }

  return (
    <>
      {addBtnContainer && createPortal(
        <button className="btn-accent" type="button" onClick={openAddModal}>
          {icons.plus}Add Quality
        </button>,
        addBtnContainer,
      )}

      <p className="settings-subtitle">Define file size limits per quality tier. Releases outside a tier's Min/Max are rejected; the Preferred size is what automated searches aim for. Tiers, groups, and order are all yours to edit — add, rename, delete, or reorder anything below.</p>

      <div className="quality-toolbar">
        <div className="quality-toolbar-field">
          <label htmlFor="qualityPreset">Preset</label>
          <select
            id="qualityPreset" className="field-select" value=""
            onChange={(e) => { const key = e.target.value; if (key) applyPreset(key); }}
          >
            <option value="">Custom</option>
            <option value="storage-saver">Storage Saver</option>
            <option value="balanced">Balanced (Recommended)</option>
            <option value="high-bitrate">High Bitrate / Quality</option>
            <option value="remux-focus">Uncompressed / Remux Focus</option>
          </select>
        </div>
        <div className="quality-toolbar-field">
          <label htmlFor="qualityRuntime">Reference Runtime</label>
          <select id="qualityRuntime" className="field-select" value={String(runtimeMinutes)} onChange={(e) => handleRuntimeChange(e.target.value)}>
            <option value="12">12 min (Short)</option>
            <option value="24">24 min (Standard Episode)</option>
            <option value="45">45 min (Extended Episode / OVA)</option>
          </select>
        </div>
        <div className="quality-toolbar-field">
          <label htmlFor="qualityUnit">Display</label>
          <select id="qualityUnit" className="field-select" value={unit} onChange={(e) => handleUnitChange(e.target.value)}>
            <option value="size">Estimated File Size</option>
            <option value="rate">Rate (MB per min)</option>
          </select>
        </div>
      </div>

      <datalist id="qualityGroupOptions">
        {groupDatalistOptions(tiers).map((g) => <option key={g} value={g} />)}
      </datalist>

      <div id="qualityGroups">
        {!loaded ? (
          <p className="settings-empty">Loading…</p>
        ) : tiers.length === 0 ? (
          <p className="settings-empty">No quality tiers defined yet — click "Add Quality" above to create one.</p>
        ) : (
          orderedGroups(tiers).map((groupName) => {
            const groupTiers = tiers.filter((t) => (t.resolutionGroup || 'Other') === groupName);
            const collapsed = collapsedGroups.has(groupName);
            return (
              <div className={`quality-group${collapsed ? ' collapsed' : ''}`} data-group={groupName} key={groupName}>
                <div className="quality-group-header" onClick={() => toggleGroup(groupName)}>
                  <span className="quality-group-title">{groupName}</span>
                  <span className="quality-group-count">{groupTiers.length} format{groupTiers.length === 1 ? '' : 's'}</span>
                  <span className="quality-group-chevron">{icons.chevronDown}</span>
                </div>
                <div className="quality-group-body">
                  {groupTiers.map((tier) => (
                    <QualityTierRow
                      key={`${tier.id}-${tick}`}
                      tier={tier}
                      idx={tiers.indexOf(tier)}
                      total={tiers.length}
                      bounds={boundsForTier(tier)}
                      format={formatValue}
                      parse={parseValue}
                      onCommit={(value) => commitSliderChange(tier.id, value)}
                      onFieldCommit={(field, value) => handleFieldCommit(tier.id, field, value)}
                      onRemove={() => removeTier(tier.id)}
                      onMoveUp={() => moveTier(tier.id, -1)}
                      onMoveDown={() => moveTier(tier.id, 1)}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="quality-legend">
        <div className="quality-legend-item"><span className="quality-legend-dot min"></span> Minimum (reject smaller)</div>
        <div className="quality-legend-item"><span className="quality-legend-dot preferred"></span> Preferred (target size)</div>
        <div className="quality-legend-item"><span className="quality-legend-dot max"></span> Maximum (cap size, or Unlimited)</div>
      </div>

      {addOpen && (
        <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) setAddOpen(false); }}>
          <div className="modal-box">
            <div className="modal-header">
              <h2>Add Quality</h2>
              <button className="modal-close" type="button" aria-label="Close" onClick={() => setAddOpen(false)}>{icons.x}</button>
            </div>
            <div className="modal-body">
              <p className="modal-label">Name</p>
              <input
                className="field-input" type="text" placeholder="e.g. WEBRip-1080p" value={addName} autoFocus
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmAddTier(); }}
              />
              <p className="modal-label">Resolution group</p>
              <input
                className="field-input" type="text" list="qualityGroupOptions" placeholder="e.g. 1080p" value={addGroup}
                onChange={(e) => setAddGroup(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmAddTier(); }}
              />
              <p className={`form-error${addError ? '' : ' is-collapsed'}`}>{addError}</p>
            </div>
            <div className="modal-footer">
              <button type="button" onClick={() => setAddOpen(false)}>Cancel</button>
              <button type="button" className="btn-accent" onClick={confirmAddTier}>Add Quality</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
