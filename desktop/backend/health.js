/* Cadence backend — dependency health ledger.
 *
 * The audit's core finding: all three external dependencies (Telegram
 * session, Anthropic key, Supabase session) can die silently while the
 * queue keeps rendering confidently on stale data. This module is the
 * single place background work records success/failure, and
 * GET /api/health reads it — both UIs render a persistent banner off it.
 *
 * Keys: 'sweep' (Telegram), 'todos' + 'promises' (Anthropic extraction),
 * 'granola' (note sync). Cloud health comes from publisher.status()
 * directly. record(key, null) clears; record(key, message) sets the error
 * and stamps when. lastOkAt survives errors so the UI can say "last
 * succeeded 3h ago".
 */

const _state = {}; // key → { error: string|null, at: ISO, lastOkAt: ISO|null }

function record(key, error) {
  const prev = _state[key] || { lastOkAt: null };
  _state[key] = {
    error: error ? String(error) : null,
    at: new Date().toISOString(),
    lastOkAt: error ? prev.lastOkAt : new Date().toISOString(),
  };
}

function get() {
  return JSON.parse(JSON.stringify(_state));
}

module.exports = { record, get };
