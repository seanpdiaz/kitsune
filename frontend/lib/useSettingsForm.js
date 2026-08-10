import { useEffect, useRef, useState } from 'react';

// React port of initSettingsForm in public/js/pages/settings-forms.js — see
// README's "React migration" section, Batch 8. Media Management, General,
// and UI are all "one settings object" pages (every persistable control
// carries what used to be a data-key, now just an object key), so this one
// hook replaces the original's DOM-query-driven version: loads the saved
// { key: value } object from /api/app-settings/:section, merges it over the
// page's own defaults (a value missing from `saved` means this is the
// user's first visit to a field that's never been touched — its default is
// queued for a one-time save, same as the original's firstVisitDefaults),
// and debounces PATCH-equivalent PUT saves the same 400ms the original did
// so rapid edits (typing, several toggles in a row) don't fire a request
// per keystroke.
export function useSettingsForm(section, defaults) {
  const [values, setValues] = useState(defaults);
  const pendingRef = useRef({});
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let saved = {};
      try {
        const res = await fetch(`/api/app-settings/${section}`);
        saved = await res.json();
      } catch {
        saved = {};
      }
      if (cancelled) return;
      const merged = { ...defaults };
      const firstVisitDefaults = {};
      Object.keys(defaults).forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(saved, key)) merged[key] = saved[key];
        else firstVisitDefaults[key] = defaults[key];
      });
      setValues(merged);
      if (Object.keys(firstVisitDefaults).length > 0) queueSave(firstVisitDefaults);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  function queueSave(partial) {
    Object.assign(pendingRef.current, partial);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const body = pendingRef.current;
      pendingRef.current = {};
      fetch(`/api/app-settings/${section}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).catch(() => {});
    }, 400);
  }

  function setField(key, value) {
    setValues((prev) => ({ ...prev, [key]: value }));
    queueSave({ [key]: value });
  }

  return { values, setField };
}
