// Small shared building blocks for the "one settings object" pages (Media
// Management, General, UI) — see README's "React migration" section, Batch
// 8. Each mirrors one recurring `.settings-card` / `.form-row` shape from
// the original static HTML closely enough that a page's JSX reads like the
// HTML it replaced, just data-driven off useSettingsForm's `values`/
// `setField` instead of data-key attributes + a DOM query.

export function SettingsCard({ title, desc, children }) {
  return (
    <div className="settings-card">
      <h2>{title}</h2>
      {desc && <p className="card-desc">{desc}</p>}
      {children}
    </div>
  );
}

export function FormRow({ name, desc, className = '', children }) {
  return (
    <div className={`form-row${className ? ` ${className}` : ''}`}>
      <div className="field-label"><p className="name">{name}</p>{desc && <p className="desc">{desc}</p>}</div>
      <div className="field-control">{children}</div>
    </div>
  );
}

export function ToggleField({ id, checked, onChange }) {
  return (
    <label className="switch">
      <input id={id} type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider"></span>
    </label>
  );
}

export function TextField({ id, value, onChange, type = 'text', placeholder, wide }) {
  const input = (
    <input
      id={id} className="field-input" type={type} placeholder={placeholder}
      value={value ?? ''} onChange={(e) => onChange(e.target.value)}
      style={wide ? { width: '100%' } : undefined}
    />
  );
  return wide ? <div style={{ width: '100%' }}>{input}</div> : input;
}

export function NumberField({ id, value, onChange }) {
  return (
    <input
      id={id} className="field-input" type="number"
      value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  );
}

// `options` — array of strings (option value === its own text, matching the
// original markup's un-valued <option>s) or { value, label } objects (used
// where the HTML did set explicit value attrs, e.g. Authentication Method).
export function SelectField({ id, value, onChange, options }) {
  return (
    <select id={id} className="field-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((opt) => (typeof opt === 'string'
        ? <option key={opt} value={opt}>{opt}</option>
        : <option key={opt.value} value={opt.value}>{opt.label}</option>))}
    </select>
  );
}
