/* Cadence backend — new-conversation suggestions CRUD.
 *
 * Adapted from PipeWise db/suggestions.js onto the light schema: the
 * deal-shaped payload (suggested_company/stage/evidence_*) reduces to a
 * neutral "new conversation" record — group, chat id, suggested name,
 * first message, message count.
 *
 * Lifecycle: pending → accepted (routes create a relationship from it) |
 * dismissed (suppressed from future sweeps). Unlike PipeWise, the
 * relationship creation lives in routes.js, not here — accept is just a
 * status change plus a create_relationship call at the route layer, so
 * this module stays free of cross-domain coupling.
 *
 * Dedupe is load-bearing: the sweep inserts with ON CONFLICT
 * (telegram_group, status) DO NOTHING, and list_active_groups feeds the
 * sweep's suppression filter (a group with a pending OR dismissed
 * suggestion is never re-suggested).
 */
const { getDb, _bind, ValidationError } = require("./core");

const VALID_SUGGESTION_STATUSES = new Set(["pending", "accepted", "dismissed"]);

function _suggestion_row_to_dict(row) {
  return {
    id: row.id,
    telegramGroup: row.telegram_group,
    telegramChatId: row.telegram_chat_id,
    suggestedName: row.suggested_name,
    firstMessage: row.first_message,
    messageCount: row.message_count,
    status: row.status,
    createdAt: row.created_at,
  };
}

// Insert a pending suggestion. Returns the new dict, or null when the
// UNIQUE(telegram_group, status) dedupe swallowed it (already pending).
function insert_suggestion(body) {
  const group = (body.telegramGroup || "").trim();
  if (!group) throw new ValidationError("telegramGroup is required");
  const info = getDb()
    .prepare(
      `INSERT INTO suggestions
         (telegram_group, telegram_chat_id, suggested_name,
          first_message, message_count, status)
       VALUES (?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(telegram_group, status) DO NOTHING`
    )
    .run(
      ..._bind([
        group,
        // GramJS dialog IDs are bigints — always store as TEXT.
        body.telegramChatId != null ? String(body.telegramChatId) : null,
        body.suggestedName ?? null,
        body.firstMessage ?? null,
        body.messageCount != null ? Math.trunc(Number(body.messageCount)) || 0 : null,
      ])
    );
  if (info.changes === 0) return null;
  return get_suggestion(info.lastInsertRowid);
}

function list_suggestions(status = "pending") {
  const rows = getDb()
    .prepare("SELECT * FROM suggestions WHERE status = ? ORDER BY id DESC")
    .all(status);
  return rows.map(_suggestion_row_to_dict);
}

function get_suggestion(suggestion_id) {
  const row = getDb()
    .prepare("SELECT * FROM suggestions WHERE id = ?")
    .get(suggestion_id);
  return row ? _suggestion_row_to_dict(row) : null;
}

function set_suggestion_status(suggestion_id, status) {
  if (!VALID_SUGGESTION_STATUSES.has(status)) {
    throw new ValidationError("status must be pending, accepted, or dismissed");
  }
  const db = getDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM suggestions WHERE id = ?")
      .get(suggestion_id);
    if (!row) return null;
    if (row.status !== status) {
      // UNIQUE(telegram_group, status): a leftover row from an earlier
      // lifecycle (e.g. re-accepting a group whose relationship was later
      // deleted) would collide with this move. The old row is stale by
      // definition — drop it first.
      db.prepare(
        "DELETE FROM suggestions WHERE telegram_group = ? AND status = ? AND id != ?"
      ).run(row.telegram_group, status, suggestion_id);
      db.prepare(
        "UPDATE suggestions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(status, suggestion_id);
    }
    return get_suggestion(suggestion_id);
  });
  return tx();
}

// Groups with a pending OR dismissed suggestion — the sweep's suppression
// filter, so a dialog the user already saw (or said no to) never comes back.
function list_active_groups() {
  const rows = getDb()
    .prepare(
      "SELECT DISTINCT telegram_group FROM suggestions " +
        "WHERE status IN ('pending', 'dismissed')"
    )
    .all();
  return rows.map((r) => r.telegram_group);
}

module.exports = {
  _suggestion_row_to_dict,
  insert_suggestion,
  list_suggestions,
  get_suggestion,
  set_suggestion_status,
  list_active_groups,
};
