// ---------------------------------------------------------------------------
// GET /api/mal/search — official MyAnimeList search, retried on transient
// failures, falling back to TheTVDB (anime-filtered) if it keeps failing.
// ---------------------------------------------------------------------------
const { logWarn, logError } = require('../logger');
const { sendJson } = require('../lib/http');
const { sleep } = require('../lib/util');
const { fetchMalSearchOnce, MAL_MAX_ATTEMPTS, MAL_RETRY_DELAYS_MS } = require('../lib/mal');
const { tvdbSearchAnimeOnly } = require('../lib/tvdb');
const { filterRelevantResults } = require('../lib/search-relevance');

async function handleMalApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/mal/search') return false;

  const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
  if (!q.trim()) {
    sendJson(res, 200, []);
    return true;
  }
  const query = q.trim();

  // Tier 1: the official API, retried on transient failures. officialResults
  // stays null until an attempt actually succeeds (even with zero matches)
  // — that's what distinguishes "MAL genuinely has nothing for this query"
  // from "MAL never came back with an answer at all" below, since a
  // mid-retry failure followed by an eventual success shouldn't be treated
  // as a failure just because an earlier attempt errored.
  let officialErr = null;
  let officialResults = null;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= MAL_MAX_ATTEMPTS; attempt++) {
    attemptsMade = attempt;
    try {
      officialResults = await fetchMalSearchOnce(query);
      break;
    } catch (err) {
      officialErr = err;
      // Retrying into a rate limit only makes it worse, and retrying with
      // no client id configured is pointless — go straight to TVDB either way.
      if (err.code === 'MAL_RATE_LIMIT' || err.code === 'MAL_NO_CLIENT_ID') break;
      if (attempt < MAL_MAX_ATTEMPTS) {
        const delay = MAL_RETRY_DELAYS_MS[attempt - 1] || 1500;
        logWarn('MalService', `Search attempt ${attempt}/${MAL_MAX_ATTEMPTS} failed (${err.message}) — retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  // Filtered down to results that actually share enough of the query's own
  // words to plausibly be the show someone's looking for — see
  // lib/search-relevance.js. MAL's own search index does loose/fuzzy text
  // matching, and for a multi-word query that means real, unrelated shows
  // regularly come back right alongside the right one. Confirmed real case:
  // searching "a lull in the sea" — the exact, correct title of a real show
  // — came back with all 10 of MAL's `limit=10` results, and only one of
  // them was actually that show; the rest matched on nothing more than a
  // shared word ("sea", matching "Children of the Sea") or an incidental
  // substring ("season" containing "sea", "lullaby" containing "lull").
  // This never changes what MAL itself returned, just what Kitsune shows
  // for it.
  const officialRelevant = officialResults ? filterRelevantResults(query, officialResults) : null;

  // A real, relevant hit from MAL is always trusted as-is — no need to also
  // ask TVDB when MAL already found the right thing.
  if (officialRelevant && officialRelevant.length > 0) {
    sendJson(res, 200, officialRelevant);
    return true;
  }

  // Tier 2: TVDB, filtered to anime (and through the same relevance filter
  // below). Used to run only when the official API actually failed or was
  // unreachable, never when it succeeded — but a genuine, non-erroring MAL
  // result that comes back empty, or comes back full of the kind of noise
  // the relevance filter above rejects down to nothing, isn't actually the
  // same as "no matches exist anywhere": MAL's search only matches a
  // title/synonym it has on file for a given entry, and not every show's
  // English fan-translation is registered there. Confirmed real case: "My
  // Big Sister Arrived" comes back with zero MAL matches for Oneechan ga
  // Kita — MAL only lists "My Sister Came"/"Onee-chan" as its English
  // synonyms for that entry — but TheTVDB indexes the exact same show under
  // that title, so a query MAL can't usefully answer can still resolve
  // correctly through the fallback. Now runs whenever tier 1 didn't produce
  // anything worth showing, distinguished below only for how a TVDB failure
  // on top of it gets reported.
  const officialReason = officialResults === null
    ? (officialErr.code === 'MAL_NO_CLIENT_ID' ? 'was skipped (no MAL_CLIENT_ID)'
      : officialErr.code === 'MAL_RATE_LIMIT' ? 'is rate-limiting us'
      : `failed after ${attemptsMade} attempt(s) (${officialErr.message})`)
    : officialResults.length === 0 ? 'returned zero results'
    : 'returned nothing relevant';

  logWarn('MalService', `Official API search ${officialReason} — falling back to TVDB.`);
  try {
    const results = await tvdbSearchAnimeOnly(query);
    sendJson(res, 200, filterRelevantResults(query, results));
  } catch (fallbackErr) {
    if (officialResults !== null) {
      // MAL itself already succeeded (just with nothing relevant to show)
      // — only the TVDB fallback attempt failed on top of that, which isn't
      // really a search failure from the user's perspective. Same "no
      // matches" outcome an empty result from MAL would have been on its
      // own, not a 502.
      logWarn('MalService', `TVDB fallback also failed after a genuine empty/irrelevant MAL result: ${fallbackErr.message}`);
      sendJson(res, 200, []);
    } else {
      logError('MalService', `TVDB fallback also failed: ${fallbackErr.message}`);
      sendJson(res, 502, {
        error: `MyAnimeList's official API ${officialReason}, and the TheTVDB fallback also failed (${fallbackErr.message}).`,
      });
    }
  }
  return true;
}

module.exports = { handleMalApi };
