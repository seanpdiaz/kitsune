// The themes Settings > UI > Theme offers, in picker order.
//
// The colors themselves live in public/styles.css (one
// :root[data-theme="<id>"] block per theme) — this file only holds what
// the picker needs: a name, a one-line description, and a handful of
// preview colors for the theme's card. Keep `preview` in step with the CSS
// block when a palette changes. `surface` doubles as the background the
// accent-contrast warning is measured against.
//
// Adding a theme: a CSS block in styles.css, an entry here, and its id in
// the IDS list at the top of public/js/theme-boot.js.

export const THEMES = [
  {
    id: 'dark',
    name: 'Dark',
    desc: 'The default.',
    preview: { bg: '#14161b', surface: '#1a1d24', surface2: '#20232c', text: '#edebe8', muted: '#6b6c78', accent: '#f2703d', border: 'rgba(255,255,255,0.08)' },
  },
  {
    id: 'light',
    name: 'Light',
    desc: 'Off-white page, white cards.',
    preview: { bg: '#f5f4f1', surface: '#ffffff', surface2: '#efede9', text: '#1c1e24', muted: '#7c7e8a', accent: '#c9501b', border: 'rgba(28,30,36,0.10)' },
  },
  {
    id: 'oled',
    name: 'OLED Black',
    desc: 'True black, for OLED screens and dark rooms.',
    preview: { bg: '#000000', surface: '#0c0c0e', surface2: '#151518', text: '#edebe8', muted: '#6f707c', accent: '#f2703d', border: 'rgba(255,255,255,0.09)' },
  },
  {
    id: 'dusk',
    name: 'Dusk',
    desc: 'Cool blue-violet with a peach accent.',
    preview: { bg: '#151726', surface: '#1b1e31', surface2: '#22263c', text: '#e7e8f3', muted: '#727593', accent: '#ff8a5c', border: 'rgba(200,205,255,0.09)' },
  },
  {
    id: 'paper',
    name: 'Paper',
    desc: 'Warm sepia, softer than bright white.',
    preview: { bg: '#f2ece1', surface: '#faf7f1', surface2: '#ebe4d6', text: '#2b261f', muted: '#7d7262', accent: '#b04a17', border: 'rgba(60,45,25,0.12)' },
  },
  {
    id: 'high-contrast',
    name: 'High Contrast',
    desc: 'White on black, solid borders.',
    preview: { bg: '#000000', surface: '#000000', surface2: '#141414', text: '#ffffff', muted: '#c8c8c8', accent: '#ff9a5c', border: '#ffffff' },
  },
];

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

// Quick picks under Accent Color. '' (not listed here) means "use the
// theme's own accent"; any other hex works too, via the custom picker.
export const ACCENT_PRESETS = [
  { hex: '#f2703d', name: 'Orange' },
  { hex: '#ff6b6b', name: 'Coral' },
  { hex: '#f472b6', name: 'Pink' },
  { hex: '#a78bfa', name: 'Purple' },
  { hex: '#4d8df6', name: 'Blue' },
  { hex: '#2dd4bf', name: 'Teal' },
  { hex: '#3ed598', name: 'Green' },
  { hex: '#f2b705', name: 'Yellow' },
];

// Below this, accent-colored text (links, active tabs, highlights) gets
// hard to read on the theme's cards. Buttons filled with the accent are
// unaffected: their text color is picked for contrast automatically.
export const ACCENT_MIN_CONTRAST = 3;
