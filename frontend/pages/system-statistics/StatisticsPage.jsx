import { useCallback, useEffect, useMemo, useState } from 'react';

// ---------------------------------------------------------------------------
// System > Statistics — library and activity statistics with charts, all
// from GET /api/system/statistics (server/routes/system-statistics.js).
//
// Charts are plain divs and a little SVG rather than a chart library: the
// shapes here are simple (bars, one line, a ring, a calendar grid), and
// building them from the theme's CSS tokens means every theme and custom
// accent color applies with no extra wiring. Chart colors are the --chart-*
// tokens in styles.css; the first series is always the accent.
// ---------------------------------------------------------------------------

const CHART_COLORS = ['var(--accent)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-muted)'];

function formatBytes(bytes, digits) {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const d = digits != null ? digits : (v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2);
  return `${v.toFixed(d)} ${units[i]}`;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function pct(n, d) {
  return d ? (n / d) * 100 : 0;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 3, 4, 5, 6, 8, 10]) {
    if (m * exp >= v) return m * exp;
  }
  return 10 * exp;
}

function shortNum(n) {
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`;
  return String(+n.toFixed(1));
}

function timeAgo(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}

function Card({ title, subtitle, children, className = '', right }) {
  return (
    <section className={`stats-card ${className}`}>
      <div className="stats-card-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="stats-card-sub">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }) {
  return <p className="stats-empty">{children}</p>;
}

function SummaryTiles({ s }) {
  const days = s.runtimeMinutes / 60 / 24;
  const haveShare = pct(s.monitoredAiredHave, s.monitoredAired);
  return (
    <div className="stats-tiles">
      <div className="stats-tile">
        <p className="stats-tile-label">Series</p>
        <p className="stats-tile-value">{fmt(s.series)}</p>
        <p className="stats-tile-sub">{fmt(s.airing)} airing · {fmt(s.finished)} finished{s.upcoming ? ` · ${fmt(s.upcoming)} upcoming` : ''}</p>
      </div>
      <div className="stats-tile">
        <p className="stats-tile-label">Episodes on disk</p>
        <p className="stats-tile-value">{fmt(s.episodesOnDisk)}</p>
        <div className="stats-meter" aria-hidden="true"><div style={{ width: `${haveShare}%` }} /></div>
        <p className="stats-tile-sub">{haveShare.toFixed(1)}% of {fmt(s.monitoredAired)} aired &amp; monitored</p>
      </div>
      <div className="stats-tile">
        <p className="stats-tile-label">Missing</p>
        <p className="stats-tile-value"><a href="wanted-missing.html" className="stats-tile-link">{fmt(s.missing)}</a></p>
        <p className="stats-tile-sub">{fmt(s.missingRecent)} aired in the last 30 days</p>
      </div>
      <div className="stats-tile">
        <p className="stats-tile-label">Library size</p>
        <p className="stats-tile-value">{formatBytes(s.libraryBytes, 1)}</p>
        <p className="stats-tile-sub">+{formatBytes(s.last12MonthsBytes, 1)} in 12 months</p>
      </div>
      <div className="stats-tile">
        <p className="stats-tile-label">Total runtime</p>
        <p className="stats-tile-value">{days >= 1 ? `${days.toFixed(1)} days` : `${fmt(Math.round(s.runtimeMinutes / 60))} h`}</p>
        <p className="stats-tile-sub">{fmt(Math.round(s.runtimeMinutes / 60))} hours of episodes</p>
      </div>
      <div className="stats-tile">
        <p className="stats-tile-label">Avg. episode size</p>
        <p className="stats-tile-value">{formatBytes(s.avgEpisodeBytes)}</p>
        <p className="stats-tile-sub">{fmt(s.probedFiles)} files with media info</p>
      </div>
    </div>
  );
}

function GrowthChart({ data, range }) {
  const points = data;
  const n = points.length;
  const maxImports = niceMax(Math.max(1, ...points.map((p) => p.imports)));
  const maxSize = niceMax(Math.max(1, ...points.map((p) => p.sizeBytes)));
  const leftTicks = [maxImports, (maxImports * 2) / 3, maxImports / 3, 0];
  const rightTicks = [maxSize, (maxSize * 2) / 3, maxSize / 3, 0];
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${(((i + 0.5) / n) * 100).toFixed(2)} ${(100 - pct(p.sizeBytes, maxSize)).toFixed(2)}`).join(' ');
  return (
    <div className="stats-growth">
      <div className="stats-axis stats-axis-left">
        {leftTicks.map((t, i) => <span key={i}>{shortNum(t)}</span>)}
      </div>
      <div className="stats-growth-main">
        <div className="stats-plot">
          <div className="stats-bars">
            {points.map((p, i) => (
              <div key={p.key} className="stats-bar-slot" title={`${p.label}: ${fmt(p.imports)} episodes imported · library ${formatBytes(p.sizeBytes, 1)}`}>
                <div className={`stats-bar${i === n - 1 ? ' is-partial' : ''}`} style={{ height: `${pct(p.imports, maxImports)}%` }} />
              </div>
            ))}
          </div>
          <svg className="stats-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path d={line} vectorEffect="non-scaling-stroke" />
          </svg>
          {points.map((p, i) => (
            <span key={p.key} className="stats-dot" style={{ left: `${((i + 0.5) / n) * 100}%`, top: `${100 - pct(p.sizeBytes, maxSize)}%` }} />
          ))}
        </div>
        <div className="stats-xlabels">
          {points.map((p) => <span key={p.key}>{p.label}</span>)}
        </div>
      </div>
      <div className="stats-axis stats-axis-right">
        {rightTicks.map((t, i) => <span key={i}>{formatBytes(t, 1).replace(' ', ' ')}</span>)}
      </div>
      <p className="sr-only">Imports: {points.map((p) => `${p.label} ${p.imports}`).join(', ')}.</p>
    </div>
  );
}

function DiskCard({ disk, config }) {
  const total = disk.reduce((n, d) => n + (d.totalBytes || 0), 0);
  const used = disk.reduce((n, d) => n + (d.usedBytes || 0), 0);
  return (
    <Card title="Disk usage" subtitle="Per root folder" className="stats-span-side">
      {disk.length === 0 && <Empty>No root folders configured yet.</Empty>}
      {disk.map((d) => {
        const usedPct = pct(d.usedBytes || 0, d.totalBytes || 0);
        const libPct = pct(d.libraryBytes || 0, d.totalBytes || 0);
        return (
          <div key={d.path} className="stats-disk-row">
            <div className="stats-disk-top">
              <span className="stats-mono">{d.path}</span>
              <span>{d.totalBytes != null ? `${formatBytes(d.usedBytes, 1)} of ${formatBytes(d.totalBytes, 1)}` : 'Unavailable'}</span>
            </div>
            {d.totalBytes != null && (
              <div className="stats-disk-bar" role="img" aria-label={`${usedPct.toFixed(0)}% used, ${libPct.toFixed(0)}% is library media`}>
                <div className="stats-disk-lib" style={{ width: `${libPct}%` }} />
                <div className="stats-disk-other" style={{ width: `${Math.max(0, usedPct - libPct)}%` }} />
              </div>
            )}
            <p className="stats-disk-meta">
              {formatBytes(d.libraryBytes, 1)} library
              {d.freeBytes != null && ` · ${formatBytes(d.freeBytes, 1)} free`}
              {d.monthsUntilFull != null && d.monthsUntilFull < 120 && ` · ~${Math.max(1, Math.round(d.monthsUntilFull))} months at current rate`}
            </p>
          </div>
        );
      })}
      {disk.length > 0 && (
        <div className="stats-legend">
          <span><i style={{ background: 'var(--accent)' }} />Library media</span>
          <span><i style={{ background: 'var(--chart-muted)' }} />Other files on the volume</span>
        </div>
      )}
      <div className="stats-disk-row">
        <div className="stats-disk-top"><span className="stats-mono">App data</span><span>{formatBytes((config.dbBytes || 0) + (config.backupsBytes || 0), 1)}</span></div>
        <p className="stats-disk-meta">{config.isPostgres ? 'Database on Postgres' : `Database ${formatBytes(config.dbBytes, 1)}`} · backups {formatBytes(config.backupsBytes, 1)}</p>
      </div>
      {total > 0 && (
        <div className="stats-card-foot"><span>Total used</span><strong>{formatBytes(used, 1)} of {formatBytes(total, 1)}</strong></div>
      )}
    </Card>
  );
}

function QualityCard({ quality, total }) {
  const max = Math.max(1, ...quality.map((q) => q.count));
  return (
    <Card title="Quality" subtitle="Episodes on disk by quality">
      {quality.length === 0 && <Empty>No episodes on disk yet.</Empty>}
      <div className="stats-hbars">
        {quality.map((q, i) => (
          <div key={q.name} className="stats-hbar">
            <div className="stats-hbar-top"><span>{q.name}</span><span className="stats-mono">{fmt(q.count)} · {pct(q.count, total).toFixed(1)}%</span></div>
            <div className="stats-track"><div style={{ width: `${pct(q.count, max)}%`, background: q.name === 'Unknown' ? 'var(--chart-muted)' : CHART_COLORS[i % 4] }} /></div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function StatusCard({ s }) {
  const parts = [
    { name: 'Airing', count: s.airing, color: 'var(--accent)' },
    { name: 'Finished', count: s.finished, color: 'var(--chart-2)' },
    { name: 'Upcoming', count: s.upcoming, color: 'var(--chart-3)' },
  ];
  const total = s.series || 1;
  let at = 0;
  const gap = s.series > 1 ? 1.2 : 0;
  const stops = parts.filter((p) => p.count > 0).map((p) => {
    const start = at;
    at += (p.count / total) * 360;
    return `${p.color} ${start}deg ${Math.max(start, at - gap)}deg, var(--surface-1) ${Math.max(start, at - gap)}deg ${at}deg`;
  });
  const bg = stops.length ? `conic-gradient(${stops.join(', ')})` : 'var(--surface-3)';
  return (
    <Card title="Series status" subtitle={`${fmt(s.series)} series in library`}>
      <div className="stats-donut-wrap">
        <div className="stats-donut" style={{ background: bg }} role="img" aria-label={parts.map((p) => `${p.count} ${p.name.toLowerCase()}`).join(', ')}>
          <div className="stats-donut-hole"><strong>{fmt(s.series)}</strong><span>series</span></div>
        </div>
      </div>
      <div className="stats-keylist">
        {parts.map((p) => (
          <div key={p.name}><i style={{ background: p.color }} /><span>{p.name}</span><span className="stats-mono">{fmt(p.count)}</span></div>
        ))}
      </div>
    </Card>
  );
}

function SplitBar({ label, parts }) {
  return (
    <div className="stats-split">
      <div className="stats-split-label">{label}</div>
      <div className="stats-split-bar">
        {parts.map((p, i) => (
          <div key={p.name} title={`${p.name} ${p.pct.toFixed(1)}%`} style={{ width: `${p.pct}%`, background: p.name === 'Other' || p.name === 'Unknown' || p.name === 'None' ? 'var(--chart-muted)' : CHART_COLORS[i % 4] }} />
        ))}
      </div>
      <div className="stats-legend">
        {parts.map((p, i) => (
          <span key={p.name}><i style={{ background: p.name === 'Other' || p.name === 'Unknown' || p.name === 'None' ? 'var(--chart-muted)' : CHART_COLORS[i % 4] }} />{p.name} <span className="stats-mono stats-dim">{p.pct.toFixed(0)}%</span></span>
        ))}
      </div>
    </div>
  );
}

function FormatsCard({ formats, probed }) {
  return (
    <Card title="Media formats" subtitle={probed ? `From media info on ${fmt(probed)} files` : 'From media info (ffprobe)'}>
      {!formats && <Empty>No files have media info yet. It's read with ffprobe when files are imported.</Empty>}
      {formats && (
        <>
          <SplitBar label="Video codec" parts={formats.video} />
          <SplitBar label="Audio" parts={formats.audio} />
          <SplitBar label="Subtitles" parts={formats.subtitles} />
        </>
      )}
    </Card>
  );
}

function PremiereCard({ years, unknown }) {
  const max = Math.max(1, ...years.map((y) => y.count));
  return (
    <Card title="Series by premiere year" subtitle={`When the shows in your library first aired${unknown ? ` · ${unknown} without a year` : ''}`} className="stats-span-wide">
      <div className="stats-cols">
        {years.map((y) => (
          <div key={y.label} className="stats-col" title={`${y.label}: ${y.count} series`}>
            <span className="stats-mono stats-col-n">{y.count || ''}</span>
            <div style={{ height: `${pct(y.count, max) * 0.82}%`, opacity: y.label.length === 4 && y.label !== '≤1999' ? 1 : 0.65 }} />
          </div>
        ))}
      </div>
      <div className="stats-cols-labels">
        {years.map((y) => <span key={y.label}>{y.label}</span>)}
      </div>
    </Card>
  );
}

function IndexersCard({ indexers, total }) {
  const max = Math.max(1, ...indexers.map((i) => i.count));
  return (
    <Card title="Imports by indexer" subtitle="Last 26 weeks">
      {indexers.length === 0 && <Empty>No imports in the last 26 weeks.</Empty>}
      <div className="stats-rankbars">
        {indexers.map((ix, i) => (
          <div key={ix.name} className="stats-rankbar">
            <span className="stats-rank-name">{ix.name}</span>
            <div className="stats-track stats-track-thick"><div style={{ width: `${pct(ix.count, max)}%`, background: CHART_COLORS[i % 4] }} /></div>
            <span className="stats-mono stats-rank-n">{fmt(ix.count)}</span>
          </div>
        ))}
      </div>
      {indexers.length > 0 && <p className="stats-card-note">{fmt(total)} imports in total</p>}
    </Card>
  );
}

const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];

function ActivityCard({ a }) {
  const max = Math.max(1, ...a.days.map((d) => d.count));
  const level = (c) => (c === 0 ? 0 : Math.min(4, Math.ceil((c / max) * 4)));
  const months = [];
  a.days.forEach((d, i) => {
    if (i % 7 !== 0) return;
    const m = new Date(`${d.date}T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    if (!months.length || months[months.length - 1].label !== m) months.push({ label: m, col: i / 7 });
  });
  const failRate = a.grabbed ? (a.failed / a.grabbed) * 100 : 0;
  return (
    <Card
      title="Download activity"
      subtitle={`Imports per day · last ${a.weeks} weeks`}
      className="stats-span-full"
      right={(
        <div className="stats-heat-legend" aria-hidden="true">Less{[0, 1, 2, 3, 4].map((l) => <i key={l} className={`lvl-${l}`} />)}More</div>
      )}
    >
      <div className="stats-activity">
        <div className="stats-heat-scroll">
          <div className="stats-heat">
            <div className="stats-heat-days">{DAY_LABELS.map((l, i) => <span key={i}>{l}</span>)}</div>
            <div className="stats-heat-grid" style={{ gridTemplateColumns: `repeat(${a.weeks}, minmax(12px, 1fr))` }} role="img" aria-label={`${fmt(a.imported)} imports over the last ${a.weeks} weeks`}>
              {a.days.map((d) => <div key={d.date} className={`lvl-${level(d.count)}`} title={`${d.date}: ${d.count ? `${d.count} import${d.count === 1 ? '' : 's'}` : 'No imports'}`} />)}
            </div>
          </div>
          <div className="stats-heat-months" style={{ gridTemplateColumns: `repeat(${a.weeks}, minmax(12px, 1fr))` }}>
            {months.map((m, i) => {
              const end = i + 1 < months.length ? months[i + 1].col : a.weeks;
              return <span key={`${m.label}-${m.col}`} style={{ gridRow: 1, gridColumn: `${m.col + 1} / ${end + 1}` }}>{end - m.col >= 2 ? m.label : ''}</span>;
            })}
          </div>
        </div>
        <div className="stats-counters">
          <div><p>Grabbed</p><strong>{fmt(a.grabbed)}</strong></div>
          <div><p>Imported</p><strong>{fmt(a.imported)}</strong></div>
          <div><p>Data imported</p><strong>{formatBytes(a.importedBytes, 1)}</strong></div>
          <div><p>Failed</p><strong>{fmt(a.failed)} {a.grabbed > 0 && <small>{failRate.toFixed(1)}%</small>}</strong></div>
        </div>
      </div>
    </Card>
  );
}

function LargestCard({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.bytes));
  return (
    <Card title="Largest series" className="stats-span-half">
      {rows.length === 0 && <Empty>No episodes on disk yet.</Empty>}
      {rows.length > 0 && (
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead><tr><th>Series</th><th className="num">Episodes</th><th className="num">Size</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={`series.html?id=${r.id}`} className="stats-row-link">{r.title}</a>
                    <div className="stats-track stats-track-thin"><div style={{ width: `${pct(r.bytes, max)}%` }} /></div>
                  </td>
                  <td className="num stats-dim">{fmt(r.episodes)}</td>
                  <td className="num">{formatBytes(r.bytes, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function GroupsCard({ rows }) {
  return (
    <Card title="Top release groups" className="stats-span-half" subtitle="Episodes on disk, by the release they were imported from">
      {rows.length === 0 && <Empty>No imported episodes to attribute yet.</Empty>}
      {rows.length > 0 && (
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead><tr><th>Group</th><th className="num">Episodes</th><th className="num">Avg. size</th><th className="num">Share</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td className={r.isOther ? 'stats-dim' : 'stats-mono'}>{r.name}</td>
                  <td className="num stats-dim">{fmt(r.episodes)}</td>
                  <td className="num stats-dim">{formatBytes(r.avgBytes)}</td>
                  <td className="num">{r.share.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function StatisticsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState('month');
  const [, tick] = useState(0);

  const load = useCallback((fresh) => {
    setLoading(true);
    fetch(`/api/system/statistics${fresh ? '?fresh=1' : ''}`)
      .then((res) => (res.ok ? res.json() : res.json().then((b) => Promise.reject(new Error(b.error || `HTTP ${res.status}`)))))
      .then((d) => { setData(d); setError(null); })
      .catch((err) => setError(err.message || 'Could not load statistics.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(false); }, [load]);
  // Keeps "Updated N min ago" current without refetching.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const growth = useMemo(() => (data ? (range === 'all' ? data.growth.allTime : data.growth.monthly) : []), [data, range]);

  return (
    <div className="stats-page">
      <div className="stats-toolbar">
        <p className="settings-subtitle" style={{ margin: 0 }}>Your library, its files, and what Kitsune has been doing.</p>
        <div className="stats-toolbar-actions">
          {data && <span className="stats-mono stats-dim stats-updated">Updated {timeAgo(data.generatedAt)}</span>}
          <button type="button" className="stats-refresh" onClick={() => load(true)} disabled={loading}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={loading ? 'stats-spin' : ''}><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
            {loading ? 'Calculating…' : 'Recalculate'}
          </button>
        </div>
      </div>

      {error && <p className="form-error">Could not load statistics: {error}</p>}
      {!data && !error && <p className="settings-empty">Calculating statistics…</p>}

      {data && (
        <>
          <SummaryTiles s={data.summary} />

          <div className="stats-grid">
            <Card
              title="Library growth"
              subtitle={range === 'all' ? `Episodes imported per ${data.growth.allTimeUnit} · since the first import` : 'Episodes imported per month · last 12 months'}
              className="stats-span-2"
              right={(
                <div className="stats-card-tools">
                  <div className="stats-legend">
                    <span><i style={{ background: 'var(--accent)' }} />Episodes imported</span>
                    <span><i className="is-line" />Library size</span>
                  </div>
                  <div className="stats-segmented" role="group" aria-label="Time range">
                    <button type="button" aria-pressed={range === 'month'} onClick={() => setRange('month')}>12 months</button>
                    <button type="button" aria-pressed={range === 'all'} onClick={() => setRange('all')}>All time</button>
                  </div>
                </div>
              )}
            >
              <GrowthChart data={growth} range={range} />
            </Card>
            <DiskCard disk={data.disk} config={data.config} />

            <QualityCard quality={data.quality} total={data.summary.episodesOnDisk} />
            <StatusCard s={data.summary} />
            <FormatsCard formats={data.formats} probed={data.summary.probedFiles} />

            <PremiereCard years={data.premiereYears} unknown={data.unknownPremiereYear} />
            <IndexersCard indexers={data.activity.indexers} total={data.activity.imported} />

            <ActivityCard a={data.activity} />

            <LargestCard rows={data.largest} />
            <GroupsCard rows={data.releaseGroups} />
          </div>

          <p className="stats-footnote">Computed live from the library database, import history and media info. Growth and activity go back as far as History Retention keeps history.</p>
        </>
      )}
    </div>
  );
}
