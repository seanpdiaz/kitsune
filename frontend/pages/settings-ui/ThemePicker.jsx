import { useEffect, useRef, useState } from 'react';
import { icons } from '../../lib/icons.jsx';
import { FormRow } from '../../components/SettingsFormFields.jsx';
import { THEMES, themeById, ACCENT_PRESETS, ACCENT_MIN_CONTRAST } from '../../lib/themes.js';

// Settings > UI > Theme: a card per theme, then an accent color row
// (theme default, preset swatches, or any custom color). Changes apply to
// the page immediately via window.KitsuneTheme (public/js/theme-boot.js);
// the parent saves them through useSettingsForm like any other field.

const KT = () => (typeof window !== 'undefined' ? window.KitsuneTheme : null);

function normalizeHex(input) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(input || '').trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

function ThemeCard({ theme, selected, accent, onSelect }) {
  const p = theme.preview;
  const a = accent || p.accent;
  return (
    <button
      type="button"
      className={`theme-card${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      onClick={() => onSelect(theme.id)}
    >
      <span className="theme-preview" style={{ background: p.bg, borderColor: p.border }} aria-hidden="true">
        <span className="theme-preview-sidebar" style={{ background: p.surface, borderColor: p.border }}>
          <span style={{ background: a }} />
          <span style={{ background: p.muted }} />
          <span style={{ background: p.muted }} />
        </span>
        <span className="theme-preview-main">
          <span className="theme-preview-line" style={{ background: p.text, width: '46%' }} />
          <span className="theme-preview-card" style={{ background: p.surface, borderColor: p.border }}>
            <span className="theme-preview-line" style={{ background: p.text, width: '70%' }} />
            <span className="theme-preview-line" style={{ background: p.muted, width: '50%' }} />
            <span className="theme-preview-pill" style={{ background: a }} />
          </span>
          <span className="theme-preview-card" style={{ background: p.surface2, borderColor: p.border }}>
            <span className="theme-preview-line" style={{ background: p.muted, width: '60%' }} />
          </span>
        </span>
      </span>
      <span className="theme-card-label">
        <span className="theme-card-name">
          {theme.name}
          {selected ? <span className="theme-card-check">{icons.check}</span> : null}
        </span>
        <span className="theme-card-desc">{theme.desc}</span>
      </span>
    </button>
  );
}

export default function ThemePicker({ theme, accent, onThemeChange, onAccentChange }) {
  const current = themeById(theme);
  const customRef = useRef(null);
  const [hexDraft, setHexDraft] = useState(accent || '');

  // Keep the live page in step with the saved values — including when the
  // server's copy arrives and differs from this browser's cached one.
  useEffect(() => {
    const kt = KT();
    if (kt) kt.apply(theme, accent);
  }, [theme, accent]);

  useEffect(() => { setHexDraft(accent || ''); }, [accent]);

  const isPreset = !accent || ACCENT_PRESETS.some((c) => c.hex === accent);
  const effectiveAccent = accent || current.preview.accent;

  let ratio = null;
  const kt = KT();
  if (kt && accent) {
    const fg = kt.parseHex(accent);
    const bg = kt.parseHex(current.preview.surface);
    if (fg && bg) ratio = kt.contrast(fg, bg);
  }
  const lowContrast = ratio !== null && ratio < ACCENT_MIN_CONTRAST;

  function commitHexDraft() {
    if (hexDraft.trim() === '') { onAccentChange(''); return; }
    const hex = normalizeHex(hexDraft);
    if (hex) onAccentChange(hex);
    else setHexDraft(accent || '');
  }

  return (
    <>
      <FormRow name="Theme" desc="Applies to everyone using this Kitsune server." className="form-row-stacked">
        <div className="theme-grid" role="group" aria-label="Theme">
          {THEMES.map((t) => (
            <ThemeCard key={t.id} theme={t} selected={t.id === current.id} accent={accent} onSelect={onThemeChange} />
          ))}
        </div>
      </FormRow>

      <FormRow name="Accent Color" desc={`Buttons, links and highlights. Theme default for ${current.name} is ${current.preview.accent}.`} className="form-row-stacked">
        <div className="accent-picker">
          <div className="color-swatch-row">
            <button
              type="button"
              className={`color-swatch accent-default${!accent ? ' selected' : ''}`}
              style={{ background: current.preview.accent }}
              aria-label={`Theme default (${current.preview.accent})`}
              data-tooltip="Theme default"
              onClick={() => onAccentChange('')}
            >
              {!accent ? <span className="swatch-check">{icons.check}</span> : null}
            </button>
            <span className="accent-divider" aria-hidden="true" />
            {ACCENT_PRESETS.map((c) => (
              <button
                key={c.hex}
                type="button"
                className={`color-swatch${accent === c.hex ? ' selected' : ''}`}
                style={{ background: c.hex }}
                aria-label={c.name}
                data-tooltip={c.name}
                onClick={() => onAccentChange(c.hex)}
              >
                {accent === c.hex ? <span className="swatch-check">{icons.check}</span> : null}
              </button>
            ))}
            <button
              type="button"
              className={`color-swatch-add${!isPreset ? ' has-custom' : ''}`}
              style={!isPreset ? { background: accent, borderColor: accent } : undefined}
              aria-label="Custom color"
              data-tooltip="Custom color"
              onClick={() => customRef.current && customRef.current.click()}
            >
              {!isPreset
                ? <span className="swatch-check">{icons.check}</span>
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>}
            </button>
            <input
              ref={customRef}
              type="color"
              value={effectiveAccent}
              className="visually-hidden-input"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => onAccentChange(e.target.value.toLowerCase())}
            />
            <input
              className="field-input accent-hex-input"
              type="text"
              spellCheck={false}
              placeholder={current.preview.accent}
              aria-label="Accent hex color"
              value={hexDraft}
              onChange={(e) => setHexDraft(e.target.value)}
              onBlur={commitHexDraft}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitHexDraft(); } }}
            />
          </div>
          {lowContrast ? (
            <p className="accent-warning" role="status">
              {icons.alert || null}
              <span>
                This color is hard to read as text on {current.name} ({ratio.toFixed(1)}:1).
                Buttons stay readable, but links and highlights may not.
              </span>
            </p>
          ) : null}
        </div>
      </FormRow>
    </>
  );
}
