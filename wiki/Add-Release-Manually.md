# Add a Release Manually

When search can't find the release you want, or ranks it below something worse, you can add it by hand. Kitsune shows which episode each file is, and once you confirm, the release is handled like a grab from search: it goes to qBittorrent, shows in the queue, and is imported, renamed and recorded in history.

## Where

- **Series page header**: **Add release** works on the whole series.
- **Season tab row**: the link icon works on that season. Files from other seasons in the same pack are still offered, marked "from another season". A pack that covers several seasons is fine to add from any one of them.

## What you can paste

- A **magnet link**.
- A **.torrent file**, using **Choose .torrent…**.
- A **link to a .torrent**. A Nyaa view page (`https://nyaa.si/view/123`, or a mirror with the same layout) is turned into its download link automatically. Kitsune downloads the file itself, so qBittorrent never needs to reach the site. A link that redirects to a magnet works too.

## The preview

Click **Read release** and Kitsune shows:

- The release name, its quality (read from the name), its size and how many files it has.
- One row per episode, with the file matched to it. Episode matching uses the same rules as [Manual Import](Manual-Import), absolute numbering included, so a pack that numbers Season 2 as 13–25 still lines up.
- Which episodes are checked to start with: those that are missing, have aired, and have a matching file. Downloaded episodes are listed but unchecked, so you can check one to replace its file. Episodes already in the queue can't be checked.
- Video files that didn't match an episode (creditless OP/ED, trailers, unparseable names), in a collapsed list.
- Warnings when:
  - the release is a magnet, so its file list isn't known yet
  - none of its files matched this series
  - the exact torrent is already in the queue
  - the release is on this series' blocklist

A magnet carries no file list until qBittorrent fetches its metadata. For a magnet, the scope's missing, aired episodes are checked instead, the same assumption a batch grab from search makes. Uncheck any the release doesn't contain.

## After adding

- There's one queue row per checked episode, all tracking the same torrent by its real info hash.
- Each row remembers the file that was confirmed for it (`queue.file_hint`). At import time that file is used instead of re-guessing from the name. If qBittorrent's "Don't create subfolder" layout dropped the top folder, the file is found by name, but only when exactly one file has that name. A hint that no longer matches anything falls back to the normal guess.
- History rows record the indexer as **Manual**, so manual adds are easy to tell apart from search grabs.

## API

| Method | Path | Body |
|---|---|---|
| POST | `/api/manual-grab/preview` | `{ seriesId, seasonNumber?, magnet \| url \| torrentBase64 }` |
| POST | `/api/manual-grab` | `{ token, episodeIds }` |

The preview returns a token that's valid for 15 minutes and can be used once. Nothing is sent to the download client until the second call. Both endpoints require sign-in. An uploaded .torrent can be up to 8 MB.

## Side fix

`guessSeasonEpisode` no longer reads `Mob Psycho 100 - 13.mkv` as episode 100. Its "NUMBER - TITLE" patterns now reject a "title" that is itself just an episode number. This also helps Library Import, Manual Import and the queue's automatic import for any show whose name ends in a number.

## Tests

`node scripts/test-manual-grab.js` runs 57 checks against a temp copy of the app with its own SQLite database, a fake qBittorrent and a fake .torrent host. It covers:
- magnets, including base32 hashes, and redirects to magnets
- uploaded and linked .torrent files
- absolute-numbered packs and extras
- the exact bytes uploaded to qBittorrent
- queue rows, file hints and history
- duplicate, blocklist and wrong-show warnings
- auth and validation
