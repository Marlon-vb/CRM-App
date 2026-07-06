/* Cadence backend — new-client suggestions CRUD.
 *
 * Adapted from PipeWise db/suggestions.js onto the light schema, then
 * extended to two sources:
 *   'telegram' — the sweep's unknown-dialog scan (room-name convention
 *     "<company> <> X" + first-touch intent patterns)
 *   'granola'  — unmatched meetings (title convention or attendee domains),
 *     derived here in suggest_from_unmatched_notes.
 *
 * Lifecycle: pending → accepted (routes create a relationship from it) |
 * dismissed (suppressed from future scans). Relationship creation lives in
 * routes.js, not here — accept is a status change plus a
 * create_relationship call at the route layer.
 *
 * Dedupe is load-bearing: inserts use ON CONFLICT (dedupe_ref, status)
 * DO NOTHING, where dedupe_ref = raw group name (telegram) or
 * 'granola:<normalized name>' (granola). list_active_groups feeds the
 * sweep's suppression filter; the taken-name set in
 * suggest_from_unmatched_notes suppresses cross-source repeats.
 */
const { getDb, _bind, ValidationError } = require("./core");
const detection = require("../detection");
const { list_relationships } = require("./relationships");

const VALID_SUGGESTION_STATUSES = new Set(["pending", "accepted", "dismissed"]);

// Granola suggestions only consider meetings this recent — an unmatched
// note from months ago is history, not a lead.
const _NOTE_SUGGEST_WINDOW_DAYS = 30;

function _suggestion_row_to_dict(row) {
  return {
    id: row.id,
    source: row.source || "telegram",
    telegramGroup: row.telegram_group,
    telegramChatId: row.telegram_chat_id,
    suggestedName: row.suggested_name,
    company: row.company,
    firstMessage: row.first_message,
    messageCount: row.message_count,
    // Attach flavor: accept links this chat to an existing relationship
    // (relationship_chats) instead of creating a new one.
    attachRelationshipId: row.attach_relationship_id ?? null,
    status: row.status,
    createdAt: row.created_at,
  };
}

// Insert a pending suggestion. Returns the new dict, or null when the
// UNIQUE(dedupe_ref, status) dedupe swallowed it (already pending).
function insert_suggestion(body) {
  const source = body.source === "granola" ? "granola" : "telegram";
  const group = (body.telegramGroup || "").trim() || null;
  const name = (body.suggestedName || "").trim() || null;
  if (source === "telegram" && !group) {
    throw new ValidationError("telegramGroup is required for telegram suggestions");
  }
  if (source === "granola" && !name) {
    throw new ValidationError("suggestedName is required for granola suggestions");
  }
  const dedupeRef =
    source === "telegram" ? group : `granola:${detection.normalize_name(name)}`;
  const info = getDb()
    .prepare(
      `INSERT INTO suggestions
         (source, telegram_group, telegram_chat_id, suggested_name,
          company, first_message, message_count, attach_relationship_id,
          dedupe_ref, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(dedupe_ref, status) DO NOTHING`
    )
    .run(
      ..._bind([
        source,
        group,
        // GramJS dialog IDs are bigints — always store as TEXT.
        body.telegramChatId != null ? String(body.telegramChatId) : null,
        name,
        (body.company || "").trim() || null,
        body.firstMessage ?? null,
        body.messageCount != null ? Math.trunc(Number(body.messageCount)) || 0 : null,
        body.attachRelationshipId ?? null,
        dedupeRef,
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
      // UNIQUE(dedupe_ref, status): a leftover row from an earlier
      // lifecycle (e.g. re-accepting a group whose relationship was later
      // deleted) would collide with this move. The old row is stale by
      // definition — drop it first.
      db.prepare(
        "DELETE FROM suggestions WHERE dedupe_ref = ? AND status = ? AND id != ?"
      ).run(row.dedupe_ref, status, suggestion_id);
      db.prepare(
        "UPDATE suggestions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(status, suggestion_id);
    }
    return get_suggestion(suggestion_id);
  });
  return tx();
}

// Telegram groups with a pending OR dismissed suggestion — the sweep's
// suppression filter, so a dialog the user already saw (or said no to)
// never comes back. Telegram-sourced rows only; granola dedupe rides the
// taken-name set below.
function list_active_groups() {
  const rows = getDb()
    .prepare(
      "SELECT DISTINCT telegram_group FROM suggestions " +
        "WHERE source = 'telegram' AND status IN ('pending', 'dismissed')"
    )
    .all();
  return rows.map((r) => r.telegram_group).filter(Boolean);
}

// Normalized names already spoken for — existing relationships (any state,
// by name AND company) plus pending/dismissed suggestions from either
// source. Scanners skip these so an accepted or dismissed client never
// re-surfaces under a second source.
function taken_client_names() {
  const taken = new Set();
  for (const r of list_relationships(true)) {
    const n = detection.normalize_name(r.name);
    if (n) taken.add(n);
    const c = detection.normalize_name(r.company);
    if (c) taken.add(c);
  }
  const rows = getDb()
    .prepare(
      "SELECT suggested_name, company FROM suggestions " +
        "WHERE status IN ('pending', 'dismissed')"
    )
    .all();
  for (const row of rows) {
    const n = detection.normalize_name(row.suggested_name);
    if (n) taken.add(n);
    const c = detection.normalize_name(row.company);
    if (c) taken.add(c);
  }
  return taken;
}

/* Derive pending suggestions from recent unmatched Granola notes.
   Called after every notes sync (route + todo extraction). profile is
   settings.getUserProfile() — the company drives the "<us> <> <them>"
   title tier; without one, only the attendee-domain tier fires.
   Returns the inserted dicts. */
function suggest_from_unmatched_notes(profile) {
  const company = (profile && profile.company) || "";
  const cutoff = Date.now() - _NOTE_SUGGEST_WINDOW_DAYS * 24 * 3600 * 1000;
  const rows = getDb()
    .prepare(
      "SELECT id, title, attendees, owner, meeting_date FROM notes " +
        "WHERE relationship_id IS NULL"
    )
    .all();
  const taken = taken_client_names();
  const added = [];
  for (const note of rows) {
    const t = note.meeting_date ? new Date(note.meeting_date).getTime() : NaN;
    if (!Number.isFinite(t) || t < cutoff) continue;
    const hit = detection.derive_note_client(
      { title: note.title, attendees: note.attendees, owner: note.owner },
      company
    );
    if (!hit) continue;
    const norm = detection.normalize_name(hit.name);
    if (norm.length < 2 || taken.has(norm)) continue;
    const dict = insert_suggestion({
      source: "granola",
      suggestedName: hit.name,
      company: hit.company,
      firstMessage: hit.evidence,
    });
    if (dict) {
      added.push(dict);
      taken.add(norm);
      console.log(`[suggest] granola client candidate: ${hit.name}`);
    }
  }
  return added;
}

module.exports = {
  _suggestion_row_to_dict,
  insert_suggestion,
  list_suggestions,
  get_suggestion,
  set_suggestion_status,
  list_active_groups,
  taken_client_names,
  suggest_from_unmatched_notes,
};
