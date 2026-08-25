// ---------------------------------------------------------------------------
// Post-search relevance filter for /api/mal/search (server/routes/mal-search.js)
// — applied to results from BOTH tiers (the official MyAnimeList API and the
// TheTVDB anime-only fallback) right before they go back to the client.
//
// Confirmed real case that motivated this: searching "a lull in the sea"
// (the exact, correct title of a real show) against MAL's official API came
// back with all 10 of its `limit=10` results, and only one of them —
// "A Lull in the Sea" itself — was actually relevant. The other nine were
// things like "Attack on Titan: Final Season", "Ghost in the Shell", and
// "Fruits Basket: The Final Season" — shows that share an incidental
// SUBSTRING with a query word ("season" contains "sea", "lullaby" contains
// "lull") or a single common word ("sea" alone, matching "Children of the
// Sea"/"Between the Sky and Sea") but have nothing else to do with the
// query. MAL's own search index is doing that fuzzy/partial matching, not
// this app — nothing here changes what MAL's API itself returns — so this
// re-scores and drops the results we got back instead, using how many of
// the query's real (non-stopword) words actually appear as whole words in
// each candidate's own title/alt-titles.
// ---------------------------------------------------------------------------

// Deliberately short — just common English function words that carry near
// zero identifying signal in a title search and would otherwise dominate
// the match ratio for a natural-language query like "a lull in the sea" or
// "the promised neverland". NOT stripping anything a real title plausibly
// leads with ("No Game No Life", "Is It Wrong to Try to Pick Up Girls...")
// — this list stays narrow on purpose.
const SEARCH_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'is']);

// A result needs at least this fraction of the query's meaningful words to
// actually appear (as whole words, not substrings) in its own title/alt
// titles to survive. Chosen against the real case above: a 2-word
// meaningful query ("lull", "sea") needs BOTH words present — a single
// shared word like "sea" alone (0.5) isn't enough on its own, which is
// exactly what excludes "Children of the Sea"/"Between the Sky and Sea"
// while still keeping "A Lull in the Sea" (which matches both). A longer,
// multi-word query only needs a solid majority, not every single word, so a
// close-but-not-exact title match (a sequel, a colon-subtitle variant)
// still survives.
const RELEVANCE_THRESHOLD = 0.6;

function tokenize(text) {
  return (text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

// Falls back to every token (no stopword stripping) if the query turns out
// to be nothing BUT stopwords/punctuation — better to filter loosely than
// to end up with zero meaningful tokens and reject everything.
function meaningfulQueryTokens(query) {
  const all = tokenize(query);
  const stripped = all.filter((t) => !SEARCH_STOPWORDS.has(t));
  return stripped.length > 0 ? stripped : all;
}

// Every text field a result carries its title(s) under — varies by which
// tier produced the result (mapMalOfficialResult in lib/mal.js has
// titleNative/altTitleSynonyms; mapTvdbResult in lib/tvdb.js always sets
// altTitleSynonyms to [] and titleNative doesn't exist on it at all — both
// shapes work here since missing fields are just filtered out below).
function resultTokens(result) {
  const fields = [result.title, result.titleNative, ...(result.altTitleSynonyms || [])].filter(Boolean);
  return new Set(tokenize(fields.join(' ')));
}

// Filters `results` (already-mapped search-result objects, MAL or TVDB
// shape) down to the ones that plausibly match `query`, dropping the
// exact-substring-but-wrong-show noise a title-text search engine can
// return for a multi-word natural-language query. Never filters to
// zero-meaningful-tokens queries (a single-letter search, a query that's
// pure punctuation) — nothing meaningful to score against, so every raw
// result passes through unchanged rather than being rejected outright.
function filterRelevantResults(query, results) {
  const queryTokens = meaningfulQueryTokens(query);
  if (queryTokens.length === 0) return results;
  return results.filter((result) => {
    const titleTokens = resultTokens(result);
    const matchCount = queryTokens.filter((t) => titleTokens.has(t)).length;
    return matchCount / queryTokens.length >= RELEVANCE_THRESHOLD;
  });
}

module.exports = { filterRelevantResults };
