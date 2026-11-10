// ---------------------------------------------------------------------------
// Automatic series background (fanart) from TheTVDB.
//
// fillSeriesFanartFromTvdb(series, tvdbId) sets series.fanart to TheTVDB's
// best background (see fetchTvdbArtworks in tvdb.js: English first, then
// language-neutral, by score) when the series doesn't have one yet. It runs
// right after a series' episodes are first fetched (so on add, or the first
// time its page opens) and on every episode refresh (the Refresh episodes
// menu item and the scheduled Refresh Series task), so existing series fill
// in too.
//
// series.fanart_source records who set the background:
//   NULL   — nobody yet; eligible for an automatic fill (retried on each
//            refresh until TheTVDB has one)
//   'tvdb' — filled automatically; left alone from then on
//   'user' — set or removed from the series page's Change background
//            dialog; never touched automatically again
// ---------------------------------------------------------------------------
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { fetchTvdbArtworks } = require('./tvdb');

async function fillSeriesFanartFromTvdb(series, tvdbId) {
  if (!tvdbId) return null;
  const row = await db.prepare('SELECT id, title, fanart, fanart_source FROM series WHERE id = ?').get(series.id);
  if (!row || row.fanart_source != null || row.fanart) return null;
  try {
    const backgrounds = await fetchTvdbArtworks(tvdbId, 'background');
    if (backgrounds.length === 0) return null;
    const url = backgrounds[0].url;
    // Re-checked in the UPDATE itself, so a background the user picked
    // while this request was in flight isn't overwritten.
    await db.prepare("UPDATE series SET fanart = ?, fanart_source = 'tvdb' WHERE id = ? AND fanart_source IS NULL AND (fanart IS NULL OR fanart = '')").run(url, row.id);
    logInfo('SeriesService', `"${row.title}": background set from TheTVDB`);
    return url;
  } catch (err) {
    // Never fails the add/refresh it rides along with.
    logWarn('SeriesService', `"${row.title}": couldn't fetch a background from TheTVDB: ${err.message}`);
    return null;
  }
}

module.exports = { fillSeriesFanartFromTvdb };
