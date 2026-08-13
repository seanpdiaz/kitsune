# User Accounts

## Real accounts, sign-in, and roles — the Library stays shared

Kitsune server accounts, requested as the foundation for a broader "metadata providers"
rework (letting each person link their own MyAnimeList/AniList/etc. account and, longer
term, sync watched status back and forth with it — not built yet, this is groundwork for
that). Deliberately scoped to just the accounts themselves first: real sign-in, real
password hashing, an admin/standard role split, and the UI to manage both. The Library
(series/episodes) is **not** split up by user anywhere — everyone who signs in to a given
Kitsune server sees and manages the same shared Library, same as it always has. Accounts
exist for who's allowed to sign in and change settings, not for separate libraries.

### Data model

Two new tables, both owned by `server/routes/auth.js` (same "each route module owns its
own table(s)" convention every other `server/routes/*.js` file already follows — see
`routes/settings-items.js`'s own comment on this):

- `users` — `id`, `username` (unique), `password_hash`, `role` (`'admin'` or
  `'standard'`), `created_at`. No seed data: an empty table is exactly what triggers
  first-run setup below, nothing to backfill.
- `sessions` — `token` (the session cookie's value, primary key), `user_id`,
  `created_at`, `expires_at`. Expired sessions are deleted lazily, the next time a request
  presents one — no separate cleanup job.

Passwords are hashed with `node:crypto`'s `scrypt` (`server/lib/auth.js`), stored as
`"<saltHex>:<hashHex>"`, verified with a constant-time compare
(`crypto.timingSafeEqual`) — no bcrypt/argon2 dependency added, matching this project's
"the backend has no dependencies of its own" goal (`server/db.js` leans on `node:sqlite`
the same way). Sessions are a 256-bit random token in an `HttpOnly`, `SameSite=Lax`
cookie (`kitsune_session`, 30-day expiry) — `server/lib/http.js` grew small
`parseCookies`/`setCookie`/`clearCookie` helpers for this, the one place in the app that
needed cookies at all before now.

### First-run setup

`GET /api/auth/state` is the one call every page's `nav.js` makes before rendering
anything: `{ needsSetup, user }`. `needsSetup` is just `SELECT COUNT(*) FROM users) === 0`
— on a brand-new install, that's true, and `public/login.html` shows "Create the admin
account" instead of a sign-in form. `POST /api/auth/setup` only succeeds while the table
is still empty (409 otherwise) and always creates the first account as `'admin'`, signed
in immediately. Same idea as Sonarr/Radarr's own first-launch prompt, just persisted as a
real account instead of a one-time config value.

### Roles

`admin` can manage server-wide settings — for now that specifically means Settings >
Users itself (`GET/POST/PATCH/DELETE /api/users`, all `requireAdmin`-gated). `standard`
can sign in and manage their own account via `PATCH /api/auth/me`, nothing else gated on
role yet. The column exists now so pages that *do* need it — Settings > Users, and later
whatever per-user metadata-provider linking needs — have something to check; this pass
doesn't retrofit role checks onto the rest of the existing API surface (Indexers,
Download Clients, etc. are all still open to anyone signed in, same as before accounts
existed at all). That's a real gap for a genuinely hardened deployment, not an oversight —
flagged here rather than silently left unclear.

Two guards on `/api/users` specifically: you can't delete your own account (edit it from
My Account instead) and you can't delete or demote the server's last remaining admin —
without that second one, an admin could lock every admin out of Settings > Users with no
way back short of editing the database by hand.

### Pages

- **`public/login.html`** (`frontend/pages/login/LoginPage.jsx`) — the one page with no
  sidebar at all. Doesn't load `app.js`/`nav.js` (that's what performs the "redirect here
  if signed out" check on every other page — loading it here too would risk a redirect
  loop). Shows the setup form or the sign-in form depending on `GET /api/auth/state`;
  redirects straight through to `next` (or `index.html`) if a valid session cookie's
  already present.
- **`public/settings-users.html`** (`frontend/pages/settings-users/UsersPage.jsx`) —
  admin-only list (Username / Role / Created / Edit). Its own component rather than a
  third `SimpleList.jsx`/`ConnectionManager.jsx` caller: both of those share data through
  the generic `/api/settings-items/:section` blob, which would leak `password_hash`
  straight to the client — `rowToUser()` in `server/routes/auth.js` strips it server-side
  instead, which only a dedicated route module can do. No one-click Remove button next to
  Edit like Profiles/Custom Formats have — removing a user needs the guards above, so it
  lives inside the edit modal's own confirmation-shaped footer.
- **`public/account.html`** ("My Account", `frontend/pages/account/AccountPage.jsx`) —
  self-service username/password change for whoever's signed in, reachable from the
  sidebar's user chip rather than the Settings tab strip (it belongs to every user, not
  just admins). Always requires the current password before applying any change.

### Sidebar

`public/js/nav.js` — already the single source of truth for the sidebar/page-tabs (see
[Sidebar Navigation](Sidebar-Navigation)) — grew two things: the auth gate itself
(`checkAuthAndInit`, an async wrapper around the render calls that used to run
unconditionally at import time) and a user chip pinned to the sidebar's bottom (avatar
initial, username, role, a small dropdown with My Account/Log out). Settings' "Users" sub
-link is filtered out of the sidebar entirely for a standard user (`visibleSections()`),
though the real enforcement is server-side (`requireAdmin`) — this is just not showing a
link that would 403 if clicked. Every one of the app's other 28 pages picked up the auth
gate and the user chip for free, zero per-page HTML edits, the same reason `nav.js` was
built as one shared script in the first place.

### Per-user preferences

The one thing that's genuinely per-user so far (not counting the account itself): the Library
grid's view (Poster/Table/Overview) and poster-size slider, both moved here from wherever they
used to live — see [Library Views](Library-Views) for the full story — onto a new `user_prefs`
table (`server/routes/user-prefs.js`), `(user_id, section)` primary key, same GET/merge-on-PUT
shape as the existing `app_settings` table. `app_settings` itself is untouched and stays
server-wide on purpose — Media Management/General/UI/Metadata/Quality are real server
configuration, not personal display preferences, same one-instance-regardless-of-who's-looking
model Sonarr/Radarr already use for those. `user_prefs` is where a future per-user setting should
land if it's about how one person likes to see the shared Library rather than how the server itself
behaves.

### Verified

Against a real running server (a throwaway copy — this sandbox's connected project folder
is mounted in a way that blocks file deletion, which `sqlite`'s journal handling and
`vite build`'s `emptyOutDir` both need; verified against an ordinary local copy instead,
same code): first-run `needsSetup: true`, a too-short password rejected (400), setup
succeeding and signing in immediately, setup rejected a second time (409, already
completed), a wrong password rejected on login (401, same message as an unknown username),
a correct login round-tripping the session cookie, an admin creating a standard user, a
standard user's own request to `/api/users` rejected (403), an admin blocked from deleting
their own account (400) and from demoting themselves as the last admin (400), an admin
removing another user and that user's now-dangling cookie correctly rejected on the next
authed request (401), `PATCH /api/auth/me` rejecting a wrong current password (400) and
succeeding with the right one, and logout clearing the session (subsequent `state` call
back to `user: null`). Also confirmed every new page's built bundle calls the right
endpoints and `nav.js`'s gate/chip logic is present in what the server actually serves.


---

[← Back to Home](Home)
