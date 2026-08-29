// ---------------------------------------------------------------------------
// /api/ssl — real cert/key file upload for Settings > General's "Enable
// SSL" toggle, which previously had no way to actually supply a
// certificate at all. Uploaded bytes are written to fixed paths under
// data/ssl/ (cert.pem / key.pem); the *original* filename, upload time, and
// size are tracked in app_settings' generic section store (see
// routes/app-settings.js) under the 'ssl' section, since the on-disk
// filename is always the same regardless of what the file was actually
// called before upload.
//
// Scope note, same as Backup's own real-file-handling: this stores real
// bytes and lets you replace/remove them, but nothing in server.js actually
// reads cert.pem/key.pem to switch the running HTTP server over to HTTPS —
// doing that live (swapping http.createServer for an https one, or
// restarting the process with different args) is a real server-behavior
// change well outside "let people upload a file," and every other toggle on
// this settings page (bind address, port, proxy) is equally just a saved
// preference with no live effect on this mockup's own server either.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');

const SSL_DIR = path.join(__dirname, '..', '..', 'data', 'ssl');
if (!fs.existsSync(SSL_DIR)) fs.mkdirSync(SSL_DIR, { recursive: true });

const CERT_PATH = path.join(SSL_DIR, 'cert.pem');
const KEY_PATH = path.join(SSL_DIR, 'key.pem');

// Generous but not unbounded — a real cert/key PEM file is a few KB; this
// just guards against someone pointing the file picker at something huge by
// mistake (base64 inflates the raw byte count by ~4/3, checked after
// decoding, against the real file size).
const MAX_BYTES = 512 * 1024;

const KIND_CONFIG = {
  cert: { filePath: CERT_PATH, marker: '-----BEGIN CERTIFICATE-----', label: 'certificate' },
  key: { filePath: KEY_PATH, marker: 'PRIVATE KEY-----', label: 'private key' },
};

async function readSslMeta() {
  const row = await db.prepare("SELECT data FROM app_settings WHERE section = 'ssl'").get();
  return row ? JSON.parse(row.data) : {};
}

async function writeSslMeta(patch) {
  const merged = { ...(await readSslMeta()), ...patch };
  await db.prepare(`
    INSERT INTO app_settings (section, data, updated_at) VALUES ('ssl', ?, ?)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(JSON.stringify(merged), db.now());
  return merged;
}

// Real file existence always wins over the saved metadata — if cert.pem
// somehow isn't on disk (deleted by hand, a fresh copy of just the DB file,
// etc.) this reports "not uploaded" rather than trusting stale metadata
// that would make Download/Remove act on a file that isn't there.
async function statusFor(kind) {
  const { filePath } = KIND_CONFIG[kind];
  if (!fs.existsSync(filePath)) return null;
  const meta = await readSslMeta();
  const stat = fs.statSync(filePath);
  return {
    filename: meta[`${kind}OriginalName`] || `${kind}.pem`,
    sizeBytes: stat.size,
    uploadedAt: meta[`${kind}UploadedAt`] || stat.mtime.toISOString(),
  };
}

async function handleSslApi(req, res, urlPath) {
  // GET /api/ssl/status
  if (req.method === 'GET' && urlPath === '/api/ssl/status') {
    sendJson(res, 200, { cert: await statusFor('cert'), key: await statusFor('key') });
    return true;
  }

  // POST /api/ssl/cert, POST /api/ssl/key — body: { filename, contentBase64 }
  const uploadMatch = req.method === 'POST' && urlPath.match(/^\/api\/ssl\/(cert|key)$/);
  if (uploadMatch) {
    const kind = uploadMatch[1];
    const config = KIND_CONFIG[kind];
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const filename = String(body.filename || `${kind}.pem`).trim();
    let content;
    try {
      content = Buffer.from(String(body.contentBase64 || ''), 'base64');
    } catch {
      sendJson(res, 400, { error: 'Could not decode file contents' });
      return true;
    }
    if (content.length === 0) {
      sendJson(res, 400, { error: 'That file is empty' });
      return true;
    }
    if (content.length > MAX_BYTES) {
      sendJson(res, 400, { error: `That file is larger than expected for a ${config.label} (max 512 KB)` });
      return true;
    }
    // Light sanity check, not full PEM/X.509 parsing — catches "picked the
    // wrong file entirely" (a random binary, a screenshot, the cert where
    // the key belongs) without pretending to validate the certificate/key
    // is actually well-formed or matches anything.
    const text = content.toString('utf8');
    if (!text.includes(config.marker)) {
      sendJson(res, 400, { error: `That doesn't look like a ${config.label} (PEM) file.` });
      return true;
    }
    fs.writeFileSync(config.filePath, content);
    const uploadedAt = new Date().toISOString();
    await writeSslMeta({ [`${kind}OriginalName`]: filename, [`${kind}UploadedAt`]: uploadedAt });
    logInfo('Ssl', `Uploaded ${config.label}: "${filename}" (${content.length} bytes)`);
    sendJson(res, 200, await statusFor(kind));
    return true;
  }

  // DELETE /api/ssl/cert, DELETE /api/ssl/key
  const deleteMatch = req.method === 'DELETE' && urlPath.match(/^\/api\/ssl\/(cert|key)$/);
  if (deleteMatch) {
    const kind = deleteMatch[1];
    const config = KIND_CONFIG[kind];
    if (fs.existsSync(config.filePath)) {
      try {
        fs.unlinkSync(config.filePath);
      } catch (err) {
        logWarn('Ssl', `Could not remove ${config.label}: ${err.message}`);
      }
    }
    await writeSslMeta({ [`${kind}OriginalName`]: null, [`${kind}UploadedAt`]: null });
    logInfo('Ssl', `Removed uploaded ${config.label}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handleSslApi };
