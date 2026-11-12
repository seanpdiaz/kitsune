import { createRoot } from 'react-dom/client';
import ThemeWelcome from './ThemeWelcome.jsx';

// Not a page of its own: public/js/nav.js imports this bundle on demand the
// first time a user signs in (see syncTheme there), same on-demand pattern
// as settings-search. Starts from whatever theme is on screen right now —
// the server default, since a not-yet-welcomed user has no theme of their own.
if (!document.getElementById('themeWelcomeRoot')) {
  const mount = document.createElement('div');
  mount.id = 'themeWelcomeRoot';
  document.body.appendChild(mount);
  const root = createRoot(mount);
  const kt = window.KitsuneTheme;
  const start = kt ? kt.stored() : { theme: 'dark', accent: '' };
  const done = () => { root.unmount(); mount.remove(); };
  root.render(<ThemeWelcome initialTheme={start.theme} initialAccent={start.accent} onDone={done} />);
}
