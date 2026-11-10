import { useEffect, useRef, useState } from 'react';
import { icons } from '../../lib/icons.jsx';

// ---------------------------------------------------------------------------
// System > Updates' "Install a Version" card — Phase 2 of the Updates
// feature. Pick a branch tip or a GitHub release, see whether it's an
// upgrade, a downgrade or a branch switch, then install it. The server
// stages and builds it while this version keeps running, backs up the
// database, and restarts; launcher.js applies it and rolls back on its own if
// the new version doesn't start (see server/lib/updater.js and launcher.js).
//
// This component polls GET /api/system-updates on its own while an install
// is running and through the restart (when the server is briefly
// unreachable), and hands every fresh response up through onData so the
// rest of the page stays current too.
// ---------------------------------------------------------------------------

const POLL_MS = 2000;
const RESTART_GIVE_UP_MS = 6 * 60 * 1000;

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function RelationSummary({ preview }) {
  const { comparison: c, target: t } = preview;
  let pill;
  let text;
  if (c.relation === 'upgrade') {
    pill = <span className="status-pill status-on">{icons.check} Upgrade</span>;
    text = `${plural(c.aheadBy, 'new commit')} since this build.`;
  } else if (c.relation === 'downgrade') {
    pill = <span className="status-pill status-warn">{icons.alert} Downgrade</span>;
    text = `Goes back ${plural(c.behindBy, 'commit')} to an older version.`;
  } else if (c.relation === 'switch') {
    pill = <span className="status-pill status-warn">{icons.alert} Branch switch</span>;
    text = `Adds ${plural(c.aheadBy, 'commit')} and drops ${plural(c.behindBy, 'commit')} that this build has.`;
  } else if (c.relation === 'identical') {
    pill = <span className="status-pill status-off">Installed</span>;
    text = 'This is the version that is running now.';
  } else {
    pill = <span className="status-pill status-warn">{icons.alert} Unknown</span>;
    text = "This install doesn't record which commit it was built from, so it can't tell whether this is newer or older.";
  }
  return (
    <div className="install-preview">
      <div className="install-preview-head">
        {pill}
        <span className="settings-meta">{text}</span>
      </div>
      <p className="settings-meta">
        <a href={t.htmlUrl || '#'} target="_blank" rel="noreferrer noopener" style={{ fontFamily: 'var(--font-mono)' }}>{t.shortSha}</a>
        {' — '}{t.message}{t.date ? ` (${formatDateTime(t.date)})` : ''}
      </p>
      {c.commits && c.commits.length > 0 && (
        <details className="install-commits">
          <summary>{c.relation === 'upgrade' ? "What's new" : 'Commits this version has that the running one does not'}</summary>
          {c.commits.map((cm) => (
            <p className="changelog-item" key={cm.sha}>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginRight: '8px' }}>
                <a href={cm.htmlUrl || '#'} target="_blank" rel="noreferrer noopener">{cm.shortSha}</a>
              </span>
              <span>{cm.message}</span>
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

function LastResult({ result }) {
  if (!result) return null;
  const label = (result.to && result.to.label) || 'the selected version';
  if (result.status === 'success') {
    return (
      <div className="install-result is-success">
        <span className="status-pill status-on">{icons.check} Updated</span>
        <span className="settings-meta">Installed {label}{result.finishedAt ? ` on ${formatDateTime(result.finishedAt)}` : ''}.</span>
      </div>
    );
  }
  const dbNote = {
    restored: ' The database was restored from the pre-update backup.',
    'not-restored-postgres': ' The Postgres database was left as it was; if anything looks wrong, restore the pre-update backup from System > Backup.',
    missing: ' The pre-update backup was missing, so the database was left as it was.',
    'restore-failed': ' Restoring the database backup failed; restore it from System > Backup.',
  }[result.database] || '';
  return (
    <div className="install-result is-failed">
      <span className="status-pill status-fail">{icons.alert} {result.status === 'rolled-back' ? 'Rolled back' : 'Update failed'}</span>
      <span className="settings-meta">
        {result.status === 'rolled-back'
          ? `The update to ${label} was undone and the previous version restored. ${result.reason || ''}${dbNote}`
          : `The update to ${label} didn't install. Nothing was changed. ${result.reason || ''}`}
        {result.finishedAt ? ` (${formatDateTime(result.finishedAt)})` : ''}
      </span>
    </div>
  );
}

function Progress({ install, restarting, stalled }) {
  const currentIdx = install.phases.findIndex((p) => p.id === install.phase);
  const failed = !!install.error;
  return (
    <div className="install-progress">
      <ol className="install-steps">
        {install.phases.map((p, i) => {
          let cls = 'is-pending';
          if (restarting && p.id === 'restart') cls = 'is-current';
          else if (i < currentIdx || (restarting && i <= currentIdx)) cls = 'is-done';
          else if (i === currentIdx) cls = failed ? 'is-failed' : 'is-current';
          return (
            <li key={p.id} className={cls}>
              <span className="install-step-mark">{cls === 'is-done' ? icons.check : cls === 'is-failed' ? icons.x : null}</span>
              {p.label}
            </li>
          );
        })}
      </ol>
      {restarting && (
        <p className="settings-meta" style={{ marginTop: '8px' }}>
          {stalled
            ? 'Kitsune has not come back yet. Check the service logs on the server; if the new version failed to start, the previous one is restored automatically.'
            : 'Kitsune is restarting into the new version. This page reloads when it is back.'}
        </p>
      )}
      {install.log && install.log.length > 0 && (
        <details className="install-log" open={failed}>
          <summary>Details</summary>
          <pre>{install.log.join('\n')}</pre>
        </details>
      )}
    </div>
  );
}

function ConfirmModal({ preview, onCancel, onConfirm, busy }) {
  const [ack, setAck] = useState(false);
  const { target, comparison } = preview;
  const warn = comparison.relation !== 'upgrade';
  return (
    <div className="modal-overlay open" role="dialog" aria-modal="true">
      <div className="modal-box wide">
        <div className="modal-header">
          <h2>Install {target.label}?</h2>
          <button className="modal-close" type="button" aria-label="Close" onClick={onCancel}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <p className="modal-label">
            Kitsune downloads and builds this version while it keeps running, backs up the database, then restarts. It is unavailable for about a minute.
            If the new version does not start, Kitsune puts the previous version and your database back automatically.
          </p>
          {warn && (
            <div className="install-warning">
              <p>
                {comparison.relation === 'downgrade' && <>This goes <strong>back</strong> to an older version.</>}
                {comparison.relation === 'switch' && <>This switches branches and drops {plural(comparison.behindBy, 'commit')} the running version has.</>}
                {comparison.relation === 'unknown' && <>Kitsune can&apos;t tell whether this version is newer or older than the running one.</>}
                {' '}The older code may not understand changes a newer version made to your database. The pre-update backup stays in System &gt; Backup if you need to restore it.
              </p>
              <label className="install-ack">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand
              </label>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn-accent" onClick={onConfirm} disabled={busy || (warn && !ack)}>
            {busy ? 'Starting…' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DockerInstructions({ support }) {
  const image = support.dockerImage;
  return (
    <>
      <p className="card-desc">{support.message}</p>
      <div className="install-docker">
        <p className="settings-meta">Pick the tag for what you want to run:</p>
        <table className="install-docker-tags">
          <tbody>
            <tr><td>Latest release</td><td><code>{image}:latest</code></td></tr>
            <tr><td>A specific release</td><td><code>{image}:&lt;release tag&gt;</code></td></tr>
            <tr><td>development branch</td><td><code>{image}:development</code></td></tr>
          </tbody>
        </table>
        <p className="settings-meta">Then, from the folder with your compose file:</p>
        <pre>docker compose pull kitsune{'\n'}docker compose up -d kitsune</pre>
        <p className="settings-meta">Your data lives in the mounted /config volume, so it carries over.</p>
      </div>
    </>
  );
}

export default function InstallVersion({ data, onData }) {
  const install = data.install;
  const support = install.support;

  const [targets, setTargets] = useState(null);
  const [targetsError, setTargetsError] = useState(null);
  const [kind, setKind] = useState('branch');
  const [ref, setRef] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  // Set when an install starts, so the restart (and the server being
  // unreachable during it) is followed through to a result.
  const [awaiting, setAwaiting] = useState(null); // { startedAt, unreachableSince }
  const pollRef = useRef(null);

  async function loadTargets(refresh) {
    setTargetsError(null);
    try {
      const res = await fetch(`/api/system-updates/targets${refresh ? '?refresh=1' : ''}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setTargets(body);
      if (!ref) {
        const preferred = body.branches.find((b) => b.name === data.branch) || body.branches[0];
        if (preferred) setRef(preferred.name);
      }
    } catch (err) {
      setTargetsError(err.message);
    }
  }

  useEffect(() => {
    if (support.supported) loadTargets(false);
    // Already mid-install when the page opened (another tab, or a reload).
    if (install.running) setAwaiting({ startedAt: install.startedAt, unreachableSince: null });
    return () => clearTimeout(pollRef.current);
  }, []);

  // Preview whenever the selection changes.
  useEffect(() => {
    if (!support.supported || !ref) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    fetch(`/api/system-updates/preview?type=${kind}&ref=${encodeURIComponent(ref)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
      })
      .then((body) => { if (!cancelled) setPreview(body); })
      .catch((err) => { if (!cancelled) { setPreview(null); setPreviewError(err.message); } })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [kind, ref]);

  // Poll through the install and the restart.
  useEffect(() => {
    if (!awaiting) return undefined;
    pollRef.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/system-updates', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fresh = await res.json();
        onData(fresh);
        const result = fresh.install.lastResult;
        const finished = result && result.finishedAt && awaiting.startedAt && result.finishedAt >= awaiting.startedAt;
        if (finished && result.status === 'success') {
          // New version, new frontend bundle — load it.
          setTimeout(() => window.location.reload(), 1200);
          setAwaiting(null);
          return;
        }
        if (finished || (!fresh.install.running && fresh.install.error)) {
          setAwaiting(null);
          return;
        }
        setAwaiting({ ...awaiting, unreachableSince: null });
      } catch {
        setAwaiting({ ...awaiting, unreachableSince: awaiting.unreachableSince || Date.now() });
      }
    }, POLL_MS);
    return () => clearTimeout(pollRef.current);
  }, [awaiting]);

  async function startInstall() {
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch('/api/system-updates/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: kind, ref, confirm: true }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setConfirming(false);
      setAwaiting({ startedAt: new Date(Date.now() - 5000).toISOString(), unreachableSince: null });
      onData({ ...data, install: { ...install, running: true, phase: 'resolve', error: null, log: [] } });
    } catch (err) {
      setStartError(err.message);
      setConfirming(false);
    } finally {
      setStarting(false);
    }
  }

  const restarting = install.restarting || (awaiting && awaiting.unreachableSince != null);
  const stalled = awaiting && awaiting.unreachableSince != null && Date.now() - awaiting.unreachableSince > RESTART_GIVE_UP_MS;
  const busy = install.running || restarting;
  const showProgress = busy || (install.error && install.log.length > 0);

  if (!support.supported) {
    return (
      <div className="settings-card">
        <h2>Install a Version</h2>
        {support.reason === 'docker' ? <DockerInstructions support={support} /> : <p className="card-desc">{support.message}</p>}
      </div>
    );
  }

  const options = kind === 'branch'
    ? (targets ? targets.branches.map((b) => ({ value: b.name, label: b.name })) : [])
    : (targets ? targets.releases.map((r) => ({ value: r.tag, label: `${r.name}${r.prerelease ? ' (pre-release)' : ''}${r.publishedAt ? ` — ${formatDateTime(r.publishedAt)}` : ''}` })) : []);

  return (
    <div className="settings-card">
      <h2>Install a Version</h2>
      <p className="card-desc">Switch to any branch or release. The database is backed up first, and a version that fails to start is rolled back automatically.</p>

      {!busy && <LastResult result={install.lastResult} />}

      {support.isGitCheckout && !busy && (
        <p className="install-note">This install is a git checkout. Installing from here replaces its files, so <code>git status</code> will show changes afterwards; keep using <code>git pull</code> instead if you manage it with git.</p>
      )}

      {showProgress ? (
        <Progress install={install} restarting={restarting} stalled={stalled} />
      ) : (
        <>
          <div className="install-picker">
            <div className="install-kind" role="tablist">
              <button type="button" className={kind === 'branch' ? 'is-active' : ''} onClick={() => { setKind('branch'); setRef(targets && targets.branches[0] ? targets.branches[0].name : ''); }}>Branch</button>
              <button type="button" className={kind === 'release' ? 'is-active' : ''} onClick={() => { setKind('release'); setRef(targets && targets.releases[0] ? targets.releases[0].tag : ''); }}>Release</button>
            </div>
            <select className="field-select" value={ref} onChange={(e) => setRef(e.target.value)} disabled={!targets || options.length === 0}>
              {options.length === 0 && <option value="">{targets ? (kind === 'release' ? 'No releases published yet' : 'No branches found') : 'Loading…'}</option>}
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button type="button" className="btn-test" onClick={() => loadTargets(true)} title="Refresh the list from GitHub">{icons.refresh}</button>
          </div>

          {targetsError && <p className="form-error">{targetsError}</p>}
          {previewLoading && <p className="settings-meta">Comparing with the running version…</p>}
          {previewError && !previewLoading && <p className="form-error">{previewError}</p>}
          {preview && !previewLoading && <RelationSummary preview={preview} />}
          {startError && <p className="form-error">{startError}</p>}
          {install.error && !install.log.length && <p className="form-error">{install.error}</p>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
            <button
              type="button"
              className="btn-accent"
              disabled={!preview || previewLoading || preview.comparison.relation === 'identical'}
              onClick={() => setConfirming(true)}
            >
              {icons.download} Install
            </button>
          </div>
        </>
      )}

      {install.error && !busy && install.log.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
          <button type="button" className="btn-test" onClick={() => onData({ ...data, install: { ...install, error: null, log: [] } })}>Choose another version</button>
        </div>
      )}

      {confirming && preview && (
        <ConfirmModal preview={preview} busy={starting} onCancel={() => setConfirming(false)} onConfirm={startInstall} />
      )}
    </div>
  );
}
