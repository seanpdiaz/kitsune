// Per-user theme and accent, stored in /api/user-prefs/appearance
// (server/routes/user-prefs.js) as:
//
//   theme    — a theme id from frontend/lib/themes.js, or missing
//   accent   — '#rrggbb', '' (the theme's own accent), or missing
//   welcomed — true once the first-login theme picker has been answered
//              (picked or skipped), so it only ever appears once per account
//
// A user with no `theme` follows the server default: Settings > UI's
// ui-theme / ui-accent (/api/app-settings/ui), which only admins can change.
// public/js/nav.js resolves the two on every page load (syncTheme there) and
// opens the picker (frontend/pages/theme-welcome/) when `welcomed` is unset.

export const APPEARANCE_URL = '/api/user-prefs/appearance';

export async function loadAppearance() {
  const res = await fetch(APPEARANCE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function saveAppearance(patch) {
  const res = await fetch(APPEARANCE_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
