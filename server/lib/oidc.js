// ---------------------------------------------------------------------------
// OpenID Connect relying-party client — the protocol half of "Sign in with
// <provider>" (Authentik, Authelia, Keycloak, Google, …). server/routes/
// oidc.js owns the routes, config and user provisioning; this file only
// speaks OIDC.
//
// Built on node:crypto + node:https rather than an OIDC library, matching
// this project's "the backend has no dependencies of its own" goal (see
// server/lib/auth.js's header comment for the same reasoning applied to
// password hashing). The flow is the standard Authorization Code flow with
// PKCE (S256), `state` and `nonce`:
//
//   1. discover()            — .well-known/openid-configuration, cached
//   2. buildAuthorizationUrl — redirect the browser to the provider
//   3. exchangeCode()        — back-channel code → tokens at token_endpoint
//   4. verifyIdToken()       — JWS signature against the provider's JWKS
//                              (or the client secret, for HS* providers),
//                              then iss/aud/azp/exp/iat/nonce
//   5. fetchUserinfo()       — optional extra claims (e.g. groups), only
//                              accepted when its `sub` matches the ID token
//
// alg "none" is always rejected, and an HS* token is only accepted when a
// client secret is configured (a public client has nothing to verify an
// HMAC with).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h
// Floor between forced JWKS refetches when a token names an unknown `kid`
// (normal during a provider key rotation) — keeps a stream of bogus tokens
// from turning into a stream of requests against the provider.
const JWKS_MIN_REFRESH_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const CLOCK_SKEW_SECONDS = 120;

const ASYMMETRIC_ALGS = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', pss: true },
  PS384: { hash: 'sha384', kty: 'RSA', pss: true },
  PS512: { hash: 'sha512', kty: 'RSA', pss: true },
  ES256: { hash: 'sha256', kty: 'EC', crv: 'P-256' },
  ES384: { hash: 'sha384', kty: 'EC', crv: 'P-384' },
  ES512: { hash: 'sha512', kty: 'EC', crv: 'P-521' },
  EdDSA: { hash: null, kty: 'OKP' },
};
const HMAC_ALGS = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };

// Issuers are compared with trailing slashes stripped: Authentik's issuer
// is ".../application/o/<slug>/" (with the slash) and it's easy to paste
// either form into Settings — both should work, while anything else about
// the URL still has to match exactly.
//
// Pasting the discovery URL itself (".../.well-known/openid-configuration")
// is an easy mistake — every provider's admin page shows it right next to
// the issuer — so that suffix is stripped too rather than producing a
// doubled ".well-known/openid-configuration/.well-known/..." request.
function normalizeIssuer(issuer) {
  return String(issuer || '')
    .trim()
    .replace(/\/\.well-known\/openid-configuration\/?$/i, '')
    .replace(/\/+$/, '');
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function randomToken(bytes = 32) {
  return base64url(crypto.randomBytes(bytes));
}

function pkceChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Node's TLS error codes for "I don't trust whoever signed this
// certificate" — almost always a private/self-signed CA that Node's
// built-in trust store doesn't know about.
const UNTRUSTED_CERT_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
]);
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// TLS trust for provider requests
//
// `tls` (passed through every function below that talks to the provider):
//   { caCertificate: '<PEM>', skipVerify: bool }
// caCertificate adds CAs to Node's built-in list for these requests only —
// how a provider behind a private CA (e.g. a home-lab root) is trusted
// without NODE_EXTRA_CA_CERTS. skipVerify turns certificate checking off
// entirely; routes/oidc.js warns loudly whenever it's used, because it lets
// anyone who can intercept this traffic serve their own signing keys.
//
// That's also why these requests go through node:https rather than global
// fetch: fetch has no per-request CA option without adding undici as a
// dependency.
// ---------------------------------------------------------------------------
function parseCaBundle(pem) {
  const blocks = String(pem || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  return blocks.map((block) => {
    let cert;
    try {
      cert = new crypto.X509Certificate(block);
    } catch {
      throw new Error('One of the certificates in the Trusted CA field could not be read — paste PEM text (-----BEGIN CERTIFICATE----- …).');
    }
    return { pem: block, subject: cert.subject.replace(/\n/g, ', '), validTo: cert.validTo, ca: cert.ca };
  });
}

function tlsAgentOptions(tls) {
  if (!tls) return {};
  if (tls.skipVerify) return { rejectUnauthorized: false };
  const extra = parseCaBundle(tls.caCertificate).map((c) => c.pem);
  return extra.length ? { ca: [...require('tls').rootCertificates, ...extra] } : {};
}

function untrustedCertMessage(url, code, tls) {
  const hint = tls && tls.caCertificate
    ? 'The Trusted CA certificate in Settings > Security doesn\'t cover it — check that it includes the CA that signed the provider\'s certificate (and the intermediate, if the provider doesn\'t send it).'
    : 'If your provider uses a private CA, paste your root CA (and intermediate, if the provider doesn\'t send it) into Trusted CA Certificate in Settings > Security.';
  return `Could not reach ${url}: its HTTPS certificate isn't trusted (${code}). ${hint}`;
}

function request(url, { method = 'GET', headers = {}, body, tls }, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch { reject(new Error(`Not a valid URL: ${url}`)); return; }
    const mod = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!mod) { reject(new Error(`Unsupported URL scheme in ${url}`)); return; }
    const payload = body == null ? null : Buffer.from(body);
    const options = {
      method,
      headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
      timeout: FETCH_TIMEOUT_MS,
      ...(mod === https ? tlsAgentOptions(tls) : {}),
    };
    const req = mod.request(target, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && method === 'GET') {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error(`Too many redirects fetching ${url}`)); return; }
        resolve(request(new URL(res.headers.location, target).toString(), { method, headers, tls }, redirectsLeft - 1));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(new Error(`Response from ${url} is too large`)); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${FETCH_TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchJson(url, options = {}) {
  let res;
  try {
    res = await request(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
  } catch (err) {
    if (err && UNTRUSTED_CERT_CODES.has(err.code)) throw new Error(untrustedCertMessage(url, err.code, options.tls));
    throw new Error(`Could not reach ${url}: ${err.message}${err.code ? ` (${err.code})` : ''}`);
  }
  let body;
  try {
    body = res.text ? JSON.parse(res.text) : {};
  } catch {
    throw new Error(`${url} returned something other than JSON (HTTP ${res.status})`);
  }
  if (res.status < 200 || res.status >= 300) {
    const detail = body.error_description || body.error || `HTTP ${res.status}`;
    throw new Error(`${url} → ${detail}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Discovery + JWKS (both cached in memory; a restart just refetches)
// ---------------------------------------------------------------------------
const discoveryCache = new Map(); // normalized issuer -> { doc, fetchedAt }
const jwksCache = new Map(); // jwks_uri -> { keys, fetchedAt }

async function discover(issuer, { force = false, tls } = {}) {
  const iss = normalizeIssuer(issuer);
  if (!/^https?:\/\/[^/]/i.test(iss)) throw new Error('Issuer URL must start with https:// (or http:// on a trusted LAN).');
  const cached = discoveryCache.get(iss);
  if (!force && cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.doc;

  const doc = await fetchJson(`${iss}/.well-known/openid-configuration`, { tls });
  for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!doc[key]) throw new Error(`The provider's discovery document is missing "${key}".`);
  }
  if (normalizeIssuer(doc.issuer) !== iss) {
    throw new Error(`Issuer mismatch: Settings has "${iss}" but the provider identifies itself as "${doc.issuer}". Use the provider's exact issuer URL.`);
  }
  discoveryCache.set(iss, { doc, fetchedAt: Date.now() });
  return doc;
}

// Called whenever the SSO settings are saved, so a discovery document or
// key set fetched under the old trust settings (e.g. with verification
// skipped) isn't kept around after they change.
function clearCaches() {
  discoveryCache.clear();
  jwksCache.clear();
}

async function loadJwks(uri, force, tls) {
  const cached = jwksCache.get(uri);
  if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached;
  const body = await fetchJson(uri, { tls });
  if (!Array.isArray(body.keys)) throw new Error(`${uri} did not return a JWKS ("keys" array).`);
  const entry = { keys: body.keys, fetchedAt: Date.now() };
  jwksCache.set(uri, entry);
  return entry;
}

function pickKey(keys, header, spec) {
  const candidates = keys.filter((k) => k.kty === spec.kty && k.use !== 'enc' && (!k.alg || k.alg === header.alg));
  if (header.kid) return candidates.find((k) => k.kid === header.kid) || null;
  return candidates.length === 1 ? candidates[0] : null;
}

async function findSigningKey(jwksUri, header, spec, tls) {
  let { keys } = await loadJwks(jwksUri, false, tls);
  let jwk = pickKey(keys, header, spec);
  if (!jwk) {
    const cached = jwksCache.get(jwksUri);
    if (!cached || Date.now() - cached.fetchedAt > JWKS_MIN_REFRESH_MS) {
      ({ keys } = await loadJwks(jwksUri, true, tls));
      jwk = pickKey(keys, header, spec);
    }
  }
  if (!jwk) throw new Error(`No signing key in the provider's JWKS matches this token (kid "${header.kid || 'none'}", alg ${header.alg}).`);
  return jwk;
}

// ---------------------------------------------------------------------------
// Authorization request
// ---------------------------------------------------------------------------
function buildAuthorizationUrl(doc, { clientId, redirectUri, scope, state, nonce, codeChallenge }) {
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------
// client_secret_basic is the spec default (and what Authentik expects);
// client_secret_post only when the provider says it doesn't support basic.
// No secret at all = public client, authenticated by PKCE alone.
function formEncode(value) {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

async function exchangeCode(doc, { clientId, clientSecret, code, redirectUri, codeVerifier, tls }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const methods = doc.token_endpoint_auth_methods_supported;
  if (clientSecret) {
    const useBasic = !Array.isArray(methods) || methods.includes('client_secret_basic') || !methods.includes('client_secret_post');
    if (useBasic) {
      headers.Authorization = `Basic ${Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`).toString('base64')}`;
    } else {
      params.set('client_id', clientId);
      params.set('client_secret', clientSecret);
    }
  } else {
    params.set('client_id', clientId);
  }
  const tokens = await fetchJson(doc.token_endpoint, { method: 'POST', headers, body: params.toString(), tls });
  if (!tokens.id_token) throw new Error('The provider did not return an ID token — make sure the "openid" scope is allowed for this client.');
  return tokens;
}

// ---------------------------------------------------------------------------
// ID token verification
// ---------------------------------------------------------------------------
function decodeSegment(segment, what) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new Error(`ID token ${what} is not valid JSON.`);
  }
}

async function verifySignature(doc, header, signingInput, signature, clientSecret, tls) {
  const alg = header.alg;
  if (HMAC_ALGS[alg]) {
    if (!clientSecret) throw new Error(`ID token is signed with ${alg}, which needs a client secret — none is configured.`);
    const expected = crypto.createHmac(HMAC_ALGS[alg], clientSecret).update(signingInput).digest();
    return expected.length === signature.length && crypto.timingSafeEqual(expected, signature);
  }
  const spec = ASYMMETRIC_ALGS[alg];
  if (!spec) throw new Error(`ID token uses an unsupported or unsafe signing algorithm (${alg}).`);
  const jwk = await findSigningKey(doc.jwks_uri, header, spec, tls);
  if (spec.crv && jwk.crv !== spec.crv) throw new Error(`Signing key curve ${jwk.crv} doesn't match ${alg}.`);
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const options = { key };
  if (spec.pss) {
    options.padding = crypto.constants.RSA_PKCS1_PSS_PADDING;
    options.saltLength = crypto.constants.RSA_PSS_SALTLEN_DIGEST;
  }
  if (spec.kty === 'EC') options.dsaEncoding = 'ieee-p1363';
  return crypto.verify(spec.hash, Buffer.from(signingInput), options, signature);
}

async function verifyIdToken(doc, idToken, { clientId, clientSecret, nonce, tls }) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('ID token is not a signed JWT.');
  const header = decodeSegment(parts[0], 'header');
  const claims = decodeSegment(parts[1], 'payload');
  if (!header.alg || header.alg === 'none') throw new Error('Unsigned ID tokens are not accepted.');

  const valid = await verifySignature(doc, header, `${parts[0]}.${parts[1]}`, Buffer.from(parts[2], 'base64url'), clientSecret, tls);
  if (!valid) throw new Error('ID token signature is invalid.');

  const now = Math.floor(Date.now() / 1000);
  if (normalizeIssuer(claims.iss) !== normalizeIssuer(doc.issuer)) throw new Error(`ID token issuer "${claims.iss}" doesn't match the provider.`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('ID token was not issued for this client ID.');
  if (aud.length > 1 && claims.azp && claims.azp !== clientId) throw new Error('ID token authorized party (azp) is a different client.');
  if (typeof claims.exp !== 'number' || claims.exp < now - CLOCK_SKEW_SECONDS) throw new Error('ID token has expired — check that this server\'s clock is correct.');
  if (typeof claims.iat === 'number' && claims.iat > now + CLOCK_SKEW_SECONDS) throw new Error('ID token was issued in the future — check that this server\'s clock is correct.');
  if (!claims.nonce || !safeEqual(claims.nonce, nonce)) throw new Error('ID token nonce doesn\'t match this sign-in attempt.');
  if (!claims.sub) throw new Error('ID token has no subject (sub).');
  return claims;
}

// ---------------------------------------------------------------------------
// UserInfo — merged under the ID token's claims, never over them, and only
// when it's about the same subject.
// ---------------------------------------------------------------------------
async function fetchUserinfo(doc, accessToken, expectedSub, tls) {
  if (!doc.userinfo_endpoint || !accessToken) return {};
  const info = await fetchJson(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}` }, tls });
  if (info.sub !== expectedSub) {
    const err = new Error('UserInfo response is for a different subject than the ID token.');
    err.code = 'SUB_MISMATCH';
    throw err;
  }
  return info;
}

module.exports = {
  normalizeIssuer,
  parseCaBundle,
  clearCaches,
  randomToken,
  pkceChallenge,
  safeEqual,
  discover,
  loadJwks,
  buildAuthorizationUrl,
  exchangeCode,
  verifyIdToken,
  fetchUserinfo,
};
