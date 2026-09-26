# Single Sign-On (OIDC)

Kitsune can sign people in through any OpenID Connect provider — Authentik, Authelia,
Keycloak, Google and so on. When it's on, the login page shows a **Sign in with
&lt;provider&gt;** button above the normal username/password form. Password sign-in keeps
working, so you can still get in if the provider is down.

Configured in **Settings > Security > Single Sign-On (OIDC)** (admins only).

## Setting it up with Authentik

1. In Authentik, go to **Applications > Providers > Create > OAuth2/OpenID Provider**:
   - **Client type:** Confidential
   - **Redirect URIs:** copy the **Redirect URI** shown in Kitsune's Single Sign-On card
     (for example `https://kitsune.diaz.lan/api/auth/oidc/callback`). Use *strict* matching.
   - **Signing key:** pick a certificate (tokens are then RS256). Leaving it empty also
     works — Authentik signs with the client secret (HS256), which Kitsune supports as long
     as the secret is saved in Kitsune.
   - **Scopes:** the defaults (`openid`, `email`, `profile`) are enough. Authentik's
     `profile` scope already includes the `groups` claim.
2. Create an **Application** that uses this provider. Its slug becomes part of the issuer
   URL. Use the application's policy bindings if only some people should be able to sign
   in.
3. Optional: create a group such as `kitsune-admins` and add whoever should be a Kitsune
   admin.
4. In Kitsune, fill in the card:
   - **Provider Name:** `Authentik`
   - **Issuer URL:** the provider's *OpenID Configuration Issuer*, e.g.
     `https://auth.diaz.lan/application/o/kitsune/`
   - **Client ID / Client Secret:** from the Authentik provider
   - **Admin Group:** `kitsune-admins` (or leave empty — see below)
5. Click **Test Provider**, then **Save**. Sign out and use the new button.

Because Kitsune fetches the provider's discovery document, keys and tokens itself, the
Kitsune server must trust the provider's TLS certificate. With a private CA, add the root
to Node's trust store, e.g. `NODE_EXTRA_CA_CERTS=/path/to/root-ca.pem` in the
environment Kitsune runs in.

## Accounts

- **First sign-in:** creates a Kitsune account named from the **Username Claim**
  (`preferred_username` by default, falling back to `email`). These accounts have no
  password and show an **SSO** badge in Settings > Users. Turn off **Create Accounts
  Automatically** to only let in people who already have an account.
- **After that:** the account is matched by the provider's issuer + `sub`, so renaming the
  user on either side doesn't break the link.
- **Existing local accounts:** if the username already belongs to a local account, sign-in
  is refused unless **Link Existing Accounts by Username** is on — then the provider
  identity is attached to that account and both sign-in methods work for it. Leave this off
  if people can choose their own username at the provider, since it would let someone claim
  an existing (possibly admin) account.
- **Roles:** with an **Admin Group** set, members of that group (from the **Groups
  Claim**, `groups` by default) are admins and everyone else is standard, re-checked on
  every sign-in. The server's last admin is never demoted this way. With no Admin Group,
  SSO accounts start as standard and you manage roles in Settings > Users.
- **Giving an SSO account a password** in Settings > Users turns it into a local account
  that's still linked, so it can use either sign-in method.

## How it works

- `server/lib/oidc.js` — the protocol: discovery (cached 1h), Authorization Code flow with
  PKCE (S256), `state` and `nonce`, back-channel code exchange (`client_secret_basic`, or
  `client_secret_post` when that's all the provider supports, or a public client with no
  secret), and ID token verification — signature against the provider's JWKS
  (RS/PS/ES/EdDSA) or the client secret (HS*), then `iss`, `aud`, `azp`, `exp`, `iat`,
  `nonce`. `alg: none` is always rejected. UserInfo claims are merged in only when their
  `sub` matches the ID token. Built on `node:crypto` and `fetch`, no new dependencies.
- `server/routes/oidc.js` — the routes (`/api/auth/oidc/status`, `/login`, `/callback`,
  and admin-only `/config` and `/test`), the config, and account provisioning. A successful
  sign-in creates the same `sessions` row and cookie a password sign-in does.
- In-flight sign-ins are kept in memory for 10 minutes, keyed by a short-lived
  `kitsune_oidc` cookie, so the callback only completes in the browser that started it.
- The config is stored in `app_settings` under the `oidc` section. The generic
  `/api/app-settings/:section` route refuses to serve that section, and the admin-only
  config endpoint never returns the client secret, only whether one is set.
- The redirect URI is built from the request's `X-Forwarded-Proto` / `X-Forwarded-Host`
  (Caddy sends both), or from **Public URL** when that's set.
- `users` gained two columns, added in place on existing databases: `auth_source`
  (`'local'` or `'oidc'`) and `oidc_subject` (`"<issuer>|<sub>"`, unique).

Not built yet: signing out of the provider at the same time (RP-initiated logout).
