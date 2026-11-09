# Better Release Search: Unlabeled Packs, Cross-Site IDs, AnimeTosho, SeaDex

## What prompted this

"Search all" for *Special A* didn't find
[`[neoHEVC] Special A Class S.A. [DVD 480p x265 HEVC AC3] [Dual Audio]`](https://nyaa.land/view/1276684),
a 24-episode, 6.5 GiB complete-series pack. The search *did* find it, then threw it away:
batch search only kept titles `isBatchRelease()` recognized as packs (an episode range like
`01-24`, the words `Batch`/`Complete`, or a season tag like `S01`/`Season 1`), and this title
has none of those. The episode count only lives in the torrent's file list.

That exposed two separate problems, fixed separately:

1. **Recognizing a pack once found.** It's a title-parsing limit, so cross-site IDs don't help;
   the torrent's file list does.
2. **Searching with the wrong words.** Nyaa.si has no idea what a MAL/TVDB ID is, since a
   release is just a title. IDs help indirectly: they pin down exactly which show this is,
   which unlocks every known name for it and ID-keyed release sources.

## 1. Unlabeled packs: three-way title classification + file-list check

`server/lib/nyaa-search.js` — `classifyReleaseShape(title)` returns:

| Shape | Meaning | Example |
|---|---|---|
| `batch` | `isBatchRelease()` recognizes a pack shape | `[SubsPlease] Show (01-12) (1080p) [Batch]` |
| `single` | an explicit single-episode marker outside `[..]`/`(..)` tags: ` - 05`, `S01E05`, `E05`/`Ep 5`/`Episode 5`, `#05`, `第05話`, or a title ending in `.mkv` etc. | `[SubsPlease] Frieren - 05 (1080p).mkv` |
| `unknown` | neither | `[neoHEVC] Special A Class S.A. [DVD 480p ...]` (a pack), `[Group] Show 05 [1080p]` (a single) |

Batch search keeps `batch`, drops `single`, and settles `unknown` against the real file list
(`server/lib/torrent-files.js`): it downloads the `.torrent` (a few KB, from
`nyaa.si/download/<id>.torrent`), decodes it (`bencode.js`'s new `listTorrentFiles`), and keeps
it only if it holds **2+ episode files**. Creditless OP/ED, trailers, menus and non-video files
don't count. At most **10** unlabeled releases are checked per search attempt, largest first
(a real pack is almost always the biggest result), three at a time. File lists are cached for the
life of the process. Verified packs carry `fileCount`, shown in the release picker as
`batch (24 eps)`.

The check runs per title attempt (`searchWithFallback`'s new `verify` option), so an attempt whose
only "matches" turn out to be single episodes still falls through to the next alt title, as an
attempt with no matches always has.

**Prowlarr:** its search API doesn't give a fetchable `.torrent` for every indexer, so an
`unknown` Prowlarr result counts as a pack only when Prowlarr reports a file count (Torznab
`files`) of 2+. Otherwise it's excluded, as before.

## 2. Cross-site IDs on every series

`server/lib/anime-ids.js`. New `series` columns: `mal_id`, `anilist_id`, `anidb_id`, `tvdb_id`,
`ids_checked_at` (added by the same defensive `ALTER TABLE` migration as every other column;
verified on SQLite and Postgres 16).

- **Source:** [Fribb/anime-lists](https://github.com/Fribb/anime-lists) `anime-list-full.json`
  (an automatic merge of manami-project/anime-offline-database and Anime-Lists/anime-lists; about
  7.5 MB, about 40k entries). Downloaded into `data/anime-list-full.json`, re-downloaded weekly; a
  failed refresh keeps using the old copy. Override with `ANIME_LIST_URL`.
- **When:** right after a series is added (background, never blocks the add), on every manual
  **Refresh episodes**, and once at startup for older series (paced one every 2.5 s). A show the
  mapping doesn't cover is re-checked after 30 days. If the mapping couldn't be downloaded at
  all, the row stays unchecked so the next start retries.
- **TVDB-added series:** one TVDB ID covers a whole show, while MAL/AniList/AniDB have one entry
  per season, so the entry mapped to TVDB season 1 is used.
- **More titles for search:** with an AniList ID, AniList's English/romaji/native titles and
  synonyms are merged into `alt_titles` (existing titles keep their order; up to 12 total).
- **Too-short alt titles are skipped:** AniList synonyms include shorthand like `SA` / `S·A`,
  which searched bare would match unrelated packs. An extra alt title must simplify to 4+
  characters with a 3+ character word (`isUsableAltQuery`). The series' own title is always
  searched.
- **Duplicates:** adding a show whose MAL ID is already in the Library (from a MAL *or* TVDB
  result) now returns the same 409 as a title clash.
- **UI:** the series page shows MAL / AniList / AniDB / TVDB / SeaDex links under the title; the
  `GET /api/series` payload has `ids: { mal, anilist, anidb, tvdb }`.

## 3. AnimeTosho indexer (search by AniDB ID)

`server/lib/animetosho-search.js`. Add it in **Settings > Indexers > Add indexer > AnimeTosho**
(no credentials; the Test button is real). AnimeTosho mirrors Nyaa.si and links releases to their
AniDB anime, so for a series with an AniDB ID it asks for every release of that anime, which
finds packs whose titles match none of the series' names.

- Uses `feed.animetosho.org/json` (override with `ANIMETOSHO_FEED_URL`). Fields read: `title`,
  `link`, `info_hash`, `magnet_uri`, `torrent_url`, `total_size`, `num_files`, `seeders`,
  `leechers`, `anidb_aid`.
- **Self-checking ID filter:** the ID-scoped response must contain items tagged with that AniDB
  ID. If nothing in it is tagged with that ID, the request is treated as not honored and title
  search runs instead. Only items tagged with the ID are kept.
- AniDB has one entry per season, so the ID is used for whole-series and season-1 searches only;
  later seasons use title search.
- Same pack rules as Nyaa.si: unlabeled titles are checked against the file list; a release
  AnimeTosho reports as one file is never a pack, and an episode search skips anything with more
  than 3 files.
- Base32 magnet hashes are converted to hex, so a release found on both AnimeTosho and Nyaa.si
  dedupes to one row.

## 4. SeaDex (best-release picks, by AniList ID)

`server/lib/seadex.js`. Add it in **Settings > Indexers > Add indexer > SeaDex** (no credentials;
real Test). [SeaDex](https://releases.moe) is a community-curated "best release" list keyed by
AniList ID. API: PocketBase, `GET /api/collections/entries/records?filter=alID=<id>&expand=trs`
(shape confirmed against the `seadex` Python client). It tries `releases.moe` then `seadex.moe`;
override with `SEADEX_URL`. Results are cached for 6 hours.

- **Ranking signal:** any result from any indexer whose info hash SeaDex lists gets
  `seadex: 'best'` or `'alt'`. `quality.js`'s `rankReleaseCandidates` sorts those first among
  in-profile releases, ahead of quality tier, so **Grab best match takes SeaDex's pick when one
  was found**. It never lifts an out-of-profile release above an in-profile one. Flags are
  applied after dedupe, so the surviving copy (usually a real indexer's, with real seeders and its
  real title) is the one marked. The picker shows a `SeaDex best` / `SeaDex alt` badge.
- **Source:** for whole-series and season-1 batch searches, SeaDex's own public-tracker torrents
  are offered directly (magnet built from the listed hash), so the pick appears even if no title
  search found it. SeaDex has no release title, so one is built: `[Group] Series — SeaDex best`.
  Private-tracker entries (hash `<redacted>`) are never offered.

## 5. Add by ID or link

`server/routes/mal-search.js`. The Add New search box accepts:

- links: `myanimelist.net/anime/<id>`, `anilist.co/anime/<id>`, `anidb.net/anime/<id>` (and the
  old `animedb.pl?...aid=<id>` form), `thetvdb.com/series/<slug>` or `/dereferrer/series/<id>`
- prefixes: `mal:3470`, `anilist:3470` (or `al:`), `anidb:5584` (or `adb:`), `tvdb:81752`

A bare number is **not** treated as an ID ("86" and "91 Days" are real titles). The show is fetched
from MAL when it has a MAL ID (same result shape and add flow as a normal search), falling back to
TVDB (`fetchTvdbSeriesById`, plus its English translation for name/overview). AniList/AniDB IDs
are translated through the Fribb mapping. Results carry `ids`, which `POST /api/series` stores
immediately.

## Known limitation (not changed here)

`isBatchRelease`'s episode-range rule reads a title number followed by an episode number
(`Mob Psycho 100 - 05`) as a range (`100 - 05`), so such titles count as packs and are excluded
from single-episode search. This predates the work above; it needs its own fix (for example,
requiring both sides of a range to be the same width).
