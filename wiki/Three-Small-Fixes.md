# Three Small Settings/Nav Fixes

## Three small Settings/nav fixes

### Library's "All Series" sub-nav item removed

`NAV_SECTIONS` in `nav.js` had Library's top-level link (`index.html`) and its first sub-item
("All Series") both pointing at the exact same page — a redundant middle step between clicking
"Library" and landing on the page you're already looking at. Removed the sub-item; Library's own
top-level link is index.html already, so nothing else about navigating there changes.

The one real consequence: `sectionMatches()` used to only check a section's *subs* for a file
match (fine before, since "All Series" duplicated `index.html` in that list too) — with that
entry gone, sitting on `index.html` would no longer have matched anything, leaving the sidebar
failing to highlight Library and the page-tabs strip failing to render "Add New"/"Library Import"
on the one page most likely to need them. Fixed by having `sectionMatches()` check the section's
own `href` first, falling back to its subs — which also just generally describes what "this
section is active" should mean, sub-item duplication or not. Verified via jsdom on `index.html`:
Library's nav-item carries `active`, its sub-menu is open showing exactly "Add New" and "Library
Import," and "All Series" no longer appears anywhere in the sidebar.

### Edit Profile (and Custom Formats) actually does something now

`settings-profiles-formats.js`'s shared `initSimpleList()` — backing both Profiles and Custom
Formats — rendered an Edit (pencil) button on every row, but its click handler only ever checked
for `data-action === 'remove'`. Nothing listened for `'edit'` at all; the button was inert. Added
a real edit modal (autosaving each field on change via `PATCH`, same pattern as every other
Settings page's modal): Profiles edits Name, Cutoff, and Upgrades allowed; Custom Formats edits
Name, Conditions, and Used in profiles. Cutoff's dropdown is sourced from the real Quality
Definitions tier list (`GET /api/settings-items/quality-tiers`, fetched once at page load) instead
of a second hardcoded copy of the tier names, falling back to just the profile's own already-saved
value if that fetch hasn't landed yet. ("Qualities" — the "N of 12" summary column — is shown for
context but isn't itself an editable field here; it's a derived count that belongs to the Quality
page's own per-tier selection UI, not a plain value this modal should let drift out of sync.)
Verified via jsdom against a running server: added a profile, edited its cutoff and upgrades
toggle through the real modal, and confirmed both landed correctly server-side; same for a custom
format's conditions count.

### Indexers (and Import Lists, Connect) can be edited after creation

The identical gap existed one level up: `settings-connections.js`'s shared
`initConnectionManager()` — backing Indexers, Import Lists, *and* Connect — only ever wired up
Test, the Enabled toggle, and Remove. There was never an Edit button at all, so a typo'd name or
wrong priority set at creation time was stuck that way short of deleting and re-adding the entire
entry. Added an Edit (pencil) button and a modal (Name, Protocol, and whichever field each page's
own second column actually means — Categories for Indexers, Root folder for Import Lists,
Triggers for Connect — plus Priority), autosaving on change via `PATCH`, same as the rest of
Settings. Required an extra 32px column in `.settings-header`/`.settings-row`'s grid for the new
button, and a matching extra empty `<span>` in all three pages' header rows. Verified via jsdom
against a running server: added an indexer, edited its name through the real modal, and confirmed
it persisted server-side; smoke-tested the same modal opening correctly on Import Lists and
Connect.


---

[← Back to Home](Home)
