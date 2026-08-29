// ---------------------------------------------------------------------------
// Nyaa.si real search — the one real indexer this app talks to, same spirit
// as server/lib/download-clients/qbittorrent.js being the one real download
// client: everywhere else (AnimeBytes, SubsPlease RSS, AniDex, Erai-raws on
// Settings > Indexers) stays exactly as simulated as before. Nyaa.si is a
// public, unauthenticated, no-API-key torrent index with a documented RSS
// search endpoint — the one indexer in this app's seed data it's actually
// possible to reach for real without asking anyone for credentials.
//
// This replaces server/lib/queue-sim.js's fabricated release candidates
// (see routes/releases.js) with real ones when Settings > Indexers' Nyaa.si
// row is enabled — real titles, real seeders/leechers, and a real magnet
// link built from the result's info hash. It does NOT change anything about
// how a grab is stored or downloaded on its own; server/routes/queue.js is
// what decides what to do with a real magnetUrl once one's been grabbed.
//
// No official JSON API exists — nyaa.si's own webapp (github.com/nyaadevs/
// nyaa) is what this is built against: RSS query params (`q`/`c`/`f`/`m`)
// and the `nyaa:` namespace's RSS item fields, both confirmed directly
// against that project's source rather than assumed. No XML parsing library
// is used (this backend has none — see README) — a small regex-based
// extractor is enough for RSS's flat, predictable item shape.
// ---------------------------------------------------------------------------
const { logDebug, logInfo, logWarn } = require('../logger');
const { getQualityTiers, rankReleaseCandidates } = require('./quality');

const NYAA_BASE = 'https://nyaa.si/';
const REQUEST_TIMEOUT_MS = 10000;
// The whole "Anime" category (every subcategory: English-translated,
// non-English-translated, raw, AMV) rather than just "English-translated"
// (1_2) alone — a real, confirmed miss: a well-known HorribleSubs episode
// release that's clearly a real, English-subbed file (and shows up
// immediately searching nyaa.si's own site directly, with no category
// filter applied) never came back from this app's own search at all,
// despite title-matching and batch-exclusion both correctly accepting it in
// isolation — the most likely explanation is upload-time category tagging
// on nyaa.si itself being inconsistent (especially for older uploads),
// landing some genuinely English-subbed releases under the general Anime
// category rather than specifically 1_2. Narrowing to 1_2 was meant to cut
// AMV/raw/non-English noise, but title-matching (titleMatchesEpisode) and
// batch-exclusion (isBatchRelease) already do that filtering on content,
// which is more reliable than trusting every uploader's category choice to
// be correct — silently missing a release the user is looking for is worse
// than an occasional true non-English/raw result slipping through to be
// ignored. See nyaa.si/help or nyaadevs/nyaa's category table for the full
// code list.
const ANIME_CATEGORY = '1_0';
const CANDIDATE_LIMIT = 8;

// nyaa.si's own bundled default tracker list (trackers.txt in its repo) —
// what it appends to torrents/magnets it generates itself. Used here as a
// fallback if a result's own `<link>` doesn't come back magnet-shaped (see
// buildMagnet below); reusing nyaa.si's own defaults rather than a
// different list keeps behavior consistent with what the site would have
// generated itself.
const DEFAULT_TRACKERS = [
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://exodus.desync.com:6969/announce',
];

// A plain fetch with no User-Agent looks like a bot to some
// Cloudflare-style protections — nyaa.si doesn't document a required UA,
// but community reports (see wiki) note plain/bare clients getting
// intermittently blocked, so a normal browser-shaped one is sent as cheap
// insurance rather than whatever Node's fetch defaults to.
const USER_AGENT = 'Mozilla/5.0 (compatible; Kitsune/1.0; self-hosted anime library manager)';

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT } });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s reaching Nyaa.si`);
    }
    throw new Error(`Could not reach Nyaa.si: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Minimal RSS parsing — no XML library in this zero-dependency backend (see
// README), but RSS's <item>...</item> shape is flat and predictable enough
// that a couple of regexes cover it without needing one. Namespaced tags
// (nyaa:seeders etc.) work with the same extractor — a colon has no special
// meaning to a JS regex.
// ---------------------------------------------------------------------------
function extractItemBlocks(xml) {
  const blocks = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) blocks.push(m[1]);
  return blocks;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return null;
  let val = m[1].trim();
  const cdata = val.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) val = cdata[1];
  return decodeXmlEntities(val.trim());
}

// nyaa:size comes back as a formatted string with an IEC binary prefix
// ("1.3 GiB", "701.4 MiB"), not a raw byte count — parsed here rather than
// stored as-is so it's comparable/sortable/formattable the same way every
// other sizeBytes field in this app already is.
const SIZE_UNITS = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
function parseSizeString(str) {
  if (!str) return 0;
  const m = String(str).trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return 0;
  const value = parseFloat(m[1]);
  const unit = SIZE_UNITS[m[2].toUpperCase()];
  if (!unit || Number.isNaN(value)) return 0;
  return Math.round(value * unit);
}

// Guards every `infoUrl` this file (and prowlarr-search.js, which re-uses
// this) ever hands to the frontend to open in a new tab (see
// release-picker-modal.js) — only a real http(s) address is ever treated as
// clickable. Cheap insurance against a malformed/missing value (or, in
// Prowlarr's case, a field this app doesn't fully control the shape of)
// ever becoming a `javascript:`-or-worse href; a release with no valid
// detail-page link just isn't clickable, same "degrade gracefully rather
// than show something wrong" rule this file already follows for a title
// that fails to classify into a quality tier.
function isHttpUrl(str) {
  if (!str) return false;
  try {
    return ['http:', 'https:'].includes(new URL(str).protocol);
  } catch {
    return false;
  }
}

function buildMagnet(infoHash, title) {
  const params = new URLSearchParams();
  params.set('dn', title);
  for (const tr of DEFAULT_TRACKERS) params.append('tr', tr);
  return `magnet:?xt=urn:btih:${infoHash}&${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Quality classification — a real Nyaa release title ("[SubsPlease] Frieren
// - 12 (1080p) [ABCD1234]") has to be mapped onto one of this app's own
// user-managed quality tiers (Settings > Quality — see server/lib/
// quality.js), same as queue-sim.js's fabricated releases already are,
// except here the resolution/source has to be *parsed*, not chosen. Fansub
// titles essentially always carry an explicit resolution tag, but source
// (WEB/Bluray/HDTV) is frequently omitted — anime simulcast fansub releases
// overwhelmingly are WEB-sourced, so that's the assumed default when no
// source token is present, rather than guessing something less common.
// ---------------------------------------------------------------------------
async function classifyQualityFromTitle(title) {
  const tiers = await getQualityTiers();
  if (tiers.length === 0) return 'Unknown';

  let resolution = null;
  if (/2160p|\b4k\b/i.test(title)) resolution = '2160p';
  else if (/1080p/i.test(title)) resolution = '1080p';
  else if (/720p/i.test(title)) resolution = '720p';
  else if (/480p|540p/i.test(title)) resolution = '480p';
  // No resolution tag at all is rare for a real release title — rather than
  // guess (e.g. defaulting to 1080p, which could easily be wrong), this is
  // reported as Unknown, the same sentinel queue-sim.js's own degenerate
  // case (every quality tier deleted) already uses.
  if (!resolution) return 'Unknown';

  let source = null;
  if (/blu-?ray|bdrip|\bbd\b/i.test(title)) source = 'Bluray';
  else if (/web-?dl|webrip|\bweb\b/i.test(title)) source = 'WEBDL';
  else if (/hdtv/i.test(title)) source = 'HDTV';

  if (resolution === '480p') {
    const name = source === 'WEBDL' ? 'WEBDL-480p' : 'SDTV';
    return tiers.find((t) => t.name === name)?.name || nearestInGroup(tiers, 'SD') || 'Unknown';
  }

  const candidateName = `${source || 'WEBDL'}-${resolution}`;
  const exact = tiers.find((t) => t.name === candidateName);
  if (exact) return exact.name;
  return nearestInGroup(tiers, resolution) || 'Unknown';
}

// Falls back to whatever tier IS configured in the right resolution group
// when the exact source-resolution combo (e.g. "HDTV-2160p") isn't one of
// the user's current tiers — picks the best-ranked tier in that group
// (last in position order, worst-to-best) rather than the first, so an
// unusual source guess still lands on a reasonable quality rather than the
// group's weakest option.
function nearestInGroup(tiers, resolutionGroup) {
  const inGroup = tiers.filter((t) => t.resolutionGroup === resolutionGroup);
  return inGroup.length ? inGroup[inGroup.length - 1].name : null;
}

// Best-effort match, not a real parser — a release title is free text, not
// a structured format, so this looks for the episode number in the handful
// of shapes fansub/scene releases actually use rather than claiming to
// handle every possible one.
function titleMatchesEpisode(title, episodeNum) {
  const n = Number(episodeNum);
  if (!Number.isFinite(n)) return false;
  const patterns = [
    new RegExp(`\\bE0*${n}\\b`, 'i'),          // "E12", "e012"
    new RegExp(`-\\s*0*${n}\\s*\\(`),           // "- 12 (1080p)" fansub style
    new RegExp(`-\\s*0*${n}\\b(?!\\d)`),        // "- 12" generally
    new RegExp(`\\b${String(n).padStart(2, '0')}\\b(?!\\d)`), // zero-padded standalone
  ];
  return patterns.some((re) => re.test(title));
}

// Fansub groups almost always use a show's short/primary title, not its
// full official one with a subtitle — "Frieren: Beyond Journey's End"
// searches much better as "Frieren." Strips anything after a colon or a
// dash used as a subtitle separator, plus non-alphanumeric punctuation, the
// same kind of cleanup queue-sim.js's makeReleaseTitle already does for the
// reverse direction (building a title, not searching for one).
//
// Real, confirmed bug: this used to split on *any* hyphen (`/[:—-]/`), not
// just one standing in for a subtitle separator — "Bludgeoning Angel
// Dokuro-chan" got cut down to "Bludgeoning Angel Dokuro", silently dropping
// "-chan" from every real search this app sent for that show (visible
// directly in System > Logs' own request-URL line). A hyphen that's part of
// a word (no surrounding whitespace — "Dokuro-chan," "Kaguya-sama") is never
// a subtitle separator; only a colon, or a dash with whitespace on both
// sides ("Kaguya-sama - Love is War"), plausibly is. Only those two shapes
// split the title now.
function simplifyTitleForSearch(title) {
  const primary = title.split(/:|\s[-—]\s/)[0];
  return primary.replace(/[^A-Za-z0-9]+/g, ' ').trim();
}

// Raw search against Nyaa.si's RSS endpoint — returns every usable result
// (has a real magnet, one way or another), unfiltered by episode number and
// unsorted. Throws on a genuine network/HTTP failure; a query with no
// results is not an error, it's just an empty array.
//
// `page` (nyaa.si's own `p=` param, 1-based) matters more than it looks:
// nyaa.si's default sort with no `s=`/`o=` is upload date descending, *not*
// relevance — so for a show with years of re-uploads (BD batches, raw
// groups, other subber groups reposting the same episodes) the original
// weekly per-episode release can be real, currently indexed, and still
// nowhere on page 1. Confirmed directly against the live site: searching
// "Tsugumomo" returns 0 of the real "[HorribleSubs] Tsugumomo - 01
// [1080p].mkv" release on page 1 (2017 upload) — everything on page 1 is a
// 2020-2026 BD/compilation re-upload of the same show. See
// searchWithFallback, which pages through this until it finds a match
// rather than trusting page 1 alone.
async function searchNyaa(query, page = 1) {
  const params = new URLSearchParams({
    page: 'rss', q: query, c: ANIME_CATEGORY,
    // f=0 (no filter) rather than f=1 ("no remakes") — same reasoning as
    // ANIME_CATEGORY above: "remake" is a self-reported uploader flag, not
    // something reliably indicating a release isn't wanted, and excluding
    // it silently is exactly the kind of narrowing that already turned out
    // to hide a real, wanted release once (see that comment). Content-level
    // filtering (titleMatchesEpisode/isBatchRelease, below) does the real
    // work of deciding what's relevant; a flagged remake that's still the
    // best/only seeded copy of an old episode showing up in results (for
    // the user to judge for themselves) beats it vanishing entirely.
    f: '0',
    m: '1', // undocumented but confirmed-in-source: makes <link> a ready-made magnet URI instead of a .torrent download link
  });
  if (page > 1) params.set('p', String(page));
  const url = `${NYAA_BASE}?${params.toString()}`;
  logDebug('IndexerService', `Nyaa.si request: ${url}`);
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Nyaa.si returned status ${res.status}`);
  const xml = await res.text();

  const items = extractItemBlocks(xml);
  const parsed = items.map((block) => {
    const title = extractTag(block, 'title') || 'Unknown';
    const link = extractTag(block, 'link');
    const infoHash = extractTag(block, 'nyaa:infoHash');
    const magnetUrl = link && link.startsWith('magnet:') ? link : (infoHash ? buildMagnet(infoHash, title) : null);
    // `m=1` (see the request params above) repurposes <link> as a ready-made
    // magnet URI instead of nyaa.si's normal torrent detail page — but the
    // RSS <guid> element is nyaa.si's own stable permalink to that page
    // ("https://nyaa.si/view/12345") regardless of `m`, since `m` only ever
    // documented itself as changing what <link> points to. This is what
    // lets the release picker open "more info" for a real result the same
    // way Sonarr/Radarr do — see release-picker-modal.js.
    const infoUrl = isHttpUrl(extractTag(block, 'guid')) ? extractTag(block, 'guid') : null;
    return {
      title,
      magnetUrl,
      infoHash: infoHash ? infoHash.toLowerCase() : null,
      infoUrl,
      sizeBytes: parseSizeString(extractTag(block, 'nyaa:size')),
      seeders: parseInt(extractTag(block, 'nyaa:seeders') || '0', 10) || 0,
      leechers: parseInt(extractTag(block, 'nyaa:leechers') || '0', 10) || 0,
      trusted: extractTag(block, 'nyaa:trusted') === 'Yes',
    };
  });
  const withMagnet = parsed.filter((r) => !!r.magnetUrl);
  logDebug(
    'IndexerService',
    `Nyaa.si query "${query}" page ${page}: RSS had ${items.length} item(s), ${withMagnet.length} usable (had a magnet/infoHash).`
    + (items.length > 0 && withMagnet.length === 0 ? ' All items were dropped — no magnetUrl/infoHash could be built from any of them.' : ''),
  );
  return withMagnet;
}

// How many pages of a single query to page through before giving up on that
// attempt and moving to the next (alt title, or done). nyaa.si's default
// sort with no `s=`/`o=` is upload date descending, not relevance — for a
// show with years of re-uploads (BD batches, raw groups, other subber
// groups reposting the same episodes over time) a real, currently-indexed
// original weekly episode release can be many pages deep, buried under
// newer unrelated re-uploads of the same show.
//
// This was originally 6, based on a manual check that placed Tsugumomo's
// original HorribleSubs releases "around page 6." That estimate was wrong
// by exactly one page: real production logs showed pages 1-6 (450 results —
// nearly this show's entire 456-result catalog) genuinely had zero episode-1
// matches, while the actual matching single-episode releases
// (`[Ohys-Raws] Tsugumomo - 01 ...`, `[Leopard-Raws] Tsugumomo - 01 RAW ...`
// — confirmed live to satisfy titleMatchesEpisode/isBatchRelease correctly
// in isolation) sit on page 7, the show's last page. A fixed cap this close
// to the true result count for one real show is fragile — a slightly
// longer-tailed one would hit the same one-page-short problem again — so
// this is now generous enough to comfortably clear that with room to spare,
// while still bounded: the empty-page check below (`results.length === 0`)
// is what actually stops the loop early for the vast majority of searches
// (a normal currently-airing show's page 1 already has everything), so this
// number mostly only matters for shows with an unusually long re-upload
// history like Tsugumomo's.
const MAX_PAGES_PER_ATTEMPT = 15;

// Shared by both single-episode and batch search below — tries the series'
// primary title (plus an optional narrowing term, e.g. a season's own
// name), then falls back through series.alt_titles in turn, same pattern
// server/lib/tvdb.js's resolveTvdbEpisodeSourceId already uses for the
// identical "the official title isn't what this external source calls it"
// problem. Stops at the first attempt whose results actually satisfy
// `matchFn`, paging forward within that attempt first (see
// MAX_PAGES_PER_ATTEMPT) before trying the next title. Throws on a genuine
// network/HTTP failure (from searchNyaa); returns an empty array, not an
// error, if nothing ever matched.
async function searchWithFallback(series, matchFn, { extraQueryTerm } = {}) {
  const attempts = [];
  if (extraQueryTerm) attempts.push(`${series.title} ${extraQueryTerm}`);
  attempts.push(series.title);
  let altTitles = [];
  try {
    altTitles = series.alt_titles ? JSON.parse(series.alt_titles) : [];
  } catch { /* malformed JSON — treat as no alt titles */ }
  attempts.push(...altTitles);

  logInfo(
    'IndexerService',
    `Nyaa.si search for "${series.title}" (id ${series.id}): trying ${attempts.length} title attempt(s) — ${JSON.stringify(attempts)}`,
  );

  let matches = [];
  const seenQueries = new Set();
  for (const attempt of attempts) {
    const query = simplifyTitleForSearch(attempt);
    // A title that's entirely non-Latin script (a Japanese alt title like
    // "つぐもも", say) strips down to an empty string here — simplifyTitleFor
    // Search only keeps [A-Za-z0-9]. Running searchNyaa with an empty `q`
    // isn't "search for this title," it's an unscoped query that returns
    // Nyaa's newest uploads across the whole Anime category, and those
    // unrelated results can still spuriously satisfy a loose matchFn like
    // titleMatchesEpisode — confirmed real: a currently-airing, completely
    // unrelated 2026 release matched "episode 1" and got shown to the user
    // in place of the actual wanted HorribleSubs release. Skip any attempt
    // that doesn't simplify to at least a couple of real characters, and
    // skip a query identical to one already tried (the primary title and an
    // alt title are sometimes literally the same string).
    if (query.length < 2 || seenQueries.has(query)) {
      logDebug('IndexerService', `Skipping attempt "${attempt}" — simplifies to "${query}" (${query.length < 2 ? 'too short/empty' : 'already tried'}).`);
      continue;
    }
    seenQueries.add(query);

    for (let page = 1; page <= MAX_PAGES_PER_ATTEMPT; page++) {
      const results = await searchNyaa(query, page);
      // An empty page means nyaa.si has run out of results for this query
      // entirely — no point requesting page N+1, it'll be empty too.
      if (results.length === 0) {
        logDebug('IndexerService', `Query "${query}" page ${page}: 0 results — end of results for this query, stopping pagination.`);
        break;
      }
      matches = results.filter(matchFn);
      logInfo(
        'IndexerService',
        `Query "${query}" page ${page}: ${results.length} result(s) back from Nyaa.si, ${matches.length} matched the filter for this search.`,
      );
      if (matches.length > 0) break;
    }
    if (matches.length > 0) {
      logInfo('IndexerService', `Nyaa.si search for "${series.title}" matched on query "${query}" — ${matches.length} release(s).`);
      break;
    }
  }
  if (matches.length === 0) {
    logInfo('IndexerService', `Nyaa.si search for "${series.title}" (id ${series.id}) found no matching releases after trying every title attempt.`);
  }
  return matches;
}

// `profile` (a series' Quality Profile, from server/lib/quality.js's
// getQualityProfile — null when the series has none assigned or it's since
// been deleted) ranks results but never filters them: every real match found
// is still returned, just with in-profile releases sorted to the top and
// each one annotated `inProfile` so the picker modal can flag the rest
// instead of hiding them. Sliced to CANDIDATE_LIMIT *after* ranking (not
// before) — profile-aware ranking has to happen before this slice, or a
// genuinely great in-profile match ranked outside the old tier-only top N
// could get cut before it ever had a chance to be promoted.
async function toReleaseCandidates(matches, extra, profile) {
  const releases = await Promise.all(matches.map(async (r) => ({
    title: r.title,
    quality: await classifyQualityFromTitle(r.title),
    sizeBytes: r.sizeBytes,
    indexer: 'Nyaa.si',
    protocol: 'torrent',
    seeders: r.seeders,
    magnetUrl: r.magnetUrl,
    infoHash: r.infoHash,
    infoUrl: r.infoUrl,
    source: 'real',
    ...extra,
  })));
  return (await rankReleaseCandidates(releases, { profile })).slice(0, CANDIDATE_LIMIT);
}

// High-level entry point used by routes/releases.js for a single episode's
// Search button. Returns { ok: true, releases } sorted
// best-quality-then-most-seeded-first, or { ok: false, error } for a real
// failure (Nyaa unreachable, bad response) — an empty releases array is a
// valid, non-error outcome (genuinely nothing found).
//
// titleMatchesEpisode alone isn't enough of a filter: a batch release title
// covering a whole season ("Tsugumomo (01-12) [1080p]", "... S01 Batch ...")
// very often contains a bare number that happens to match a single target
// episode too — "01-12" matches episode 1 as readily as a real single-
// episode release's "- 01 -" would. Left unfiltered, a per-episode Search
// would surface season-batch torrents alongside (or instead of) genuine
// single-episode ones, even though isBatchRelease already exists and is
// exactly the same "does this title look like a batch?" check
// searchBatchReleases (Search Season / Search All) uses in the other
// direction. Excluding it here is what keeps single-episode search results
// actually single-episode.
async function searchReleasesForEpisode(series, episode, profile) {
  const epCode = `S${String(episode.seasonNumber ?? 1).padStart(2, '0')}E${String(episode.num).padStart(2, '0')}`;
  logInfo('IndexerService', `Searching Nyaa.si for "${series.title}" ${epCode} (episode #${episode.num}, single-episode search — batch releases excluded).`);
  let matches;
  try {
    matches = await searchWithFallback(series, (r) => titleMatchesEpisode(r.title, episode.num) && !isBatchRelease(r.title));
  } catch (err) {
    logWarn('IndexerService', `Nyaa.si search failed for "${series.title}" ${epCode}: ${err.message}`);
    return { ok: false, error: err.message };
  }
  const releases = await toReleaseCandidates(matches, undefined, profile);
  logInfo('IndexerService', `Nyaa.si search for "${series.title}" ${epCode} finished: ${matches.length} raw match(es), ${releases.length} shown after quality sort/limit.`);
  return { ok: true, releases };
}

// A "batch" release bundles multiple episodes into one torrent — the usual
// way a finished show gets distributed once a fansub group wraps up a
// season, as opposed to one torrent per episode while it's still airing.
// There's no single reliable signal for this (release titles are free
// text), so this checks the handful of shapes real batch titles actually
// use: an explicit episode range ("01-12", "01~24"), the words "Batch" or
// "Complete", a season range ("Season 1-2", "S1~2", "season 01 & 02" — see
// below), or a scene-style season tag ("S01") with no accompanying episode
// number at all — best-effort, same honesty about it as every other
// title-parsing heuristic in this file.
//
// Real, confirmed miss: a real "Bludgeoning Angel Dokuro-chan" batch search
// only flagged 1 of 5 real Nyaa results as a batch even though 3 of the 5
// clearly were — "[Koten_Gars] ... {Season 1-2} ..." and "... season 01 &
// 02 ..." both slipped through every rule above. The old season-tag rule
// only recognized the abbreviated "S01" form, never the spelled-out word
// "Season", and the episode-range rule only matched hyphen/tilde-joined
// 2-4-digit numbers (built for zero-padded episode ranges like "01-24"),
// never an ampersand-joined or single-digit season range like "1-2" or
// "01 & 02". Added a dedicated season-range rule for this — it doesn't need
// the E##/S##E## exclusion guard the single-season-tag rule below needs,
// since a single-episode release never spans a range of seasons in the
// first place.
function isBatchRelease(title) {
  if (/\b\d{2,4}\s*[-~]\s*\d{2,4}\b/.test(title)) return true;
  if (/\bbatch\b/i.test(title)) return true;
  if (/\bcomplete\b/i.test(title)) return true;
  if (/\bs(?:eason)?s?\.?\s*\d{1,2}\s*(?:[-~&]|and)\s*(?:s(?:eason)?\.?\s*)?\d{1,2}\b/i.test(title)) return true;
  if (/\bS\d{1,2}\b/i.test(title) && !/\bS\d{1,2}\s*E\d{1,3}\b/i.test(title) && !/\bE\d{1,3}\b/i.test(title)) return true;
  return false;
}

// Backs Search Season / Search All (whole series) on the series detail page
// — same shape as searchReleasesForEpisode, but filtered to batch-looking
// results instead of a specific episode number. `extraQueryTerm` (a
// season's own custom name, when it has one — see server/routes/
// episodes.js's rename-season route) is tried first, alongside the plain
// series title, before falling back through alt_titles; this app doesn't
// attempt to parse an exact episode range out of a batch title (too
// unreliable across fansub/scene naming conventions to trust), so which
// *specific* episodes a grabbed batch ends up covering is decided by
// server/routes/queue.js from real Library data instead, not from anything
// parsed here.
async function searchBatchReleases(series, { extraQueryTerm, profile } = {}) {
  logInfo('IndexerService', `Searching Nyaa.si for "${series.title}" batch releases${extraQueryTerm ? ` (narrowed with "${extraQueryTerm}")` : ''}.`);
  let matches;
  try {
    matches = await searchWithFallback(series, (r) => isBatchRelease(r.title), { extraQueryTerm });
  } catch (err) {
    logWarn('IndexerService', `Nyaa.si batch search failed for "${series.title}": ${err.message}`);
    return { ok: false, error: err.message };
  }
  const releases = await toReleaseCandidates(matches, { isBatch: true }, profile);
  logInfo('IndexerService', `Nyaa.si batch search for "${series.title}" finished: ${matches.length} raw match(es), ${releases.length} shown after quality sort/limit.`);
  return { ok: true, releases };
}

// Backs Settings > Indexers' real Test button for the Nyaa.si row — a
// minimal, cheap request (a query nothing will realistically match, so the
// response body stays small) that just confirms Nyaa.si is reachable and
// answering with real RSS, the same "prove the real call works" bar
// Download Clients' Test already sets, without needing to search for
// anything meaningful.
async function testNyaaReachable() {
  let res;
  try {
    res = await fetchWithTimeout(`${NYAA_BASE}?page=rss&q=kitsune-connectivity-check&c=${ANIME_CATEGORY}`);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!res.ok) {
    return { ok: false, error: `Nyaa.si returned status ${res.status}.` };
  }
  const xml = await res.text();
  if (!/<rss[\s>]/i.test(xml)) {
    return { ok: false, error: 'Nyaa.si responded, but not with the RSS feed expected.' };
  }
  return { ok: true };
}

module.exports = {
  searchNyaa, searchReleasesForEpisode, searchBatchReleases, testNyaaReachable,
  classifyQualityFromTitle, titleMatchesEpisode, isBatchRelease, parseSizeString, buildMagnet, simplifyTitleForSearch,
  isHttpUrl,
};
