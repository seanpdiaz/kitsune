# Settings Search

Every Settings page has a **Search all settings** box in its top row. It finds any
setting on any Settings page, and picking a result opens that page, scrolls to the
setting, highlights it and puts the cursor in its field.

## Using it

- Click the box, or press `/` (or Ctrl/Cmd+K) anywhere on a Settings page.
- Type part of a setting's name, its card, its page, or a related word: `sso` and
  `authentik` find the OIDC settings, `https` finds SSL, `puid` finds chown User.
- Up/Down moves through results, Enter opens one, Escape clears and then closes.
- Results show the setting's name, where it lives (`Settings › General › Logging`)
  and its description. A result on the page you're on jumps without reloading.
- If the setting's row is hidden because a toggle above it is off (Proxy Host while
  Use Proxy is off, the OIDC fields while single sign-on is disabled), the whole card
  is highlighted instead.
- Settings that only exist inside a modal (a download client's Category, a Prowlarr
  indexer's API Key) are searchable too; picking one opens the right page, and you
  open the modal from there.
- Security and Users results only show for admins, matching the sidebar.

## How it works

- `frontend/lib/settingsSearchIndex.js` is a hand-written list of every page, card and
  field, with optional extra keywords. It has to be hand-written: a Settings page's
  content only exists once that page's React bundle has rendered it, so there is
  nothing to search on the pages you aren't looking at.
- `frontend/pages/settings-search/` is the search box. `public/js/nav.js` loads it on
  every `settings-*.html` page (`loadSettingsSearch`), so a new Settings page gets it
  without touching its HTML.
- A result links to `settings-<page>.html#setting=<id>`. On load the target page reads
  the hash, waits for its content to render, then scrolls to and highlights the row
  (matched by its card title and field name) and removes the hash from the URL.

## Keeping the index current

When you add or rename a setting, add it to `settingsSearchIndex.js` too. `npm run
build` runs `scripts/check-settings-search-index.js`, which lists every literal
`FormRow` / `SettingsCard` / `FieldRow` / `fieldRow` label on a Settings page that the
index doesn't contain. It only warns; run it with `--strict` to fail instead.
