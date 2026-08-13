// ---------------------------------------------------------------------------
// Password hashing + session tokens — server/routes/auth.js is the only
// caller. Built entirely on node:crypto (scrypt) rather than adding bcrypt/
// argon2 as a dependency, matching this project's "the backend has no
// dependencies of its own" goal (see README/wiki's Home page) the same way
// server/db.js leans on node:sqlite instead of a driver package.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;

// Stored as "<saltHex>:<hashHex>" in the users table's password_hash column
// — self-contained, so verifying never needs a second lookup for the salt.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

// Constant-time compare (crypto.timingSafeEqual) rather than `===` on the
// derived hash, so a login attempt can't be timed to leak how many leading
// bytes of the real hash it got right.
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  let candidate;
  try {
    candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  const storedBuf = Buffer.from(hashHex, 'hex');
  if (storedBuf.length !== candidate.length) return false;
  return crypto.timingSafeEqual(candidate, storedBuf);
}

// Opaque bearer token for the sessions table — 256 bits, nothing derived
// from user/time data an attacker could guess toward.
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { hashPassword, verifyPassword, generateSessionToken };
