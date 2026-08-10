// Tiny shared promise-based delay, used both by TheTVDB pagination (be
// polite between pages) and the MAL search route's retry backoff.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { sleep };
