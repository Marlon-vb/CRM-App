/* Cadence backend — follow-up engine persistence.
 *
 * Ported from PipeWise db/followups.js. CRUD for the two follow-up tables:
 *   - followup_snoozes   parked queue items ('until' | 'after_reply')
 *   - followup_promises  commitments extracted from chats + Granola notes
 *
 * The PipeWise followup_cadences table is GONE — the per-relationship
 * cadence lives on relationships.cadence_days now (see BUILD_SPEC.md), so
 * the cadence helpers were removed with it. Cadence writes go through
 * relationships.update_relationship({cadenceDays}).
 *
 * Both tables are local-only for now. When cloud sync lands (Phase 4),
 * followup_promises has a natural key on (user_id, relationship_id, text)
 * and followup_snoozes on (user_id, item_key) — follow the naturalKeyCols
 * pattern documented in the PipeWise CLAUDE.md.
 *
 * The queue-building logic itself lives in ../followups.js — this module
 * is storage only, mirroring the db/<domain>.js convention.
 */

const { getDb, _now_iso } = require("./core");

// ── row → dict ──────────────────────────────────────────────────────

function _promise_row_to_dict(row) {
  return {
    id: row.id,
    relationshipId: row.relationship_id,
    direction: row.direction,
    text: row.text,
    source: row.source,
    sourceRef: row.source_ref ?? null,
    promisedAt: row.promised_at ?? null,
    dueHint: row.due_hint ?? null,
    status: row.status,
    resolvedAt: row.resolved_at ?? null,
    createdAt: row.created_at,
  };
}

// ── snoozes ─────────────────────────────────────────────────────────

// Map of item_key → {mode, until, lastInboundAt} for the queue builder.
function list_snoozes() {
  const rows = getDb().prepare("SELECT * FROM followup_snoozes").all();
  const map = {};
  for (const r of rows) {
    map[r.item_key] = {
      mode: r.mode,
      until: r.until ?? null,
      lastInboundAt: r.last_inbound_at ?? null,
      createdAt: r.created_at,
    };
  }
  return map;
}

// Upsert — snoozing an already-snoozed item replaces the old snooze.
function set_snooze(itemKey, mode, until, lastInboundAt) {
  if (!itemKey || typeof itemKey !== "string") {
    throw new Error("itemKey required");
  }
  getDb()
    .prepare(
      `INSERT INTO followup_snoozes (item_key, mode, until, last_inbound_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, item_key)
       DO UPDATE SET mode = excluded.mode, until = excluded.until,
                     last_inbound_at = excluded.last_inbound_at,
                     created_at = CURRENT_TIMESTAMP`
    )
    .run(itemKey, mode === "after_reply" ? "after_reply" : "until",
         until ?? null, lastInboundAt ?? null);
  return { ok: true };
}

function clear_snooze(itemKey) {
  getDb().prepare("DELETE FROM followup_snoozes WHERE item_key = ?").run(itemKey);
  return { ok: true };
}

// ── promises ────────────────────────────────────────────────────────

function list_promises(relationshipId = null, status = "open") {
  const db = getDb();
  let rows;
  if (relationshipId != null) {
    rows = status === "all"
      ? db.prepare("SELECT * FROM followup_promises WHERE relationship_id = ? ORDER BY created_at DESC").all(relationshipId)
      : db.prepare("SELECT * FROM followup_promises WHERE relationship_id = ? AND status = ? ORDER BY created_at DESC").all(relationshipId, status);
  } else {
    rows = status === "all"
      ? db.prepare("SELECT * FROM followup_promises ORDER BY created_at DESC").all()
      : db.prepare("SELECT * FROM followup_promises WHERE status = ? ORDER BY created_at DESC").all(status);
  }
  return rows.map(_promise_row_to_dict);
}

// Idempotent insert — UNIQUE(user_id, relationship_id, text) absorbs
// re-extraction. Returns the number of NEW rows actually inserted.
function upsert_promises(items) {
  if (!items || !items.length) return { inserted: 0 };
  const db = getDb();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO followup_promises
       (relationship_id, direction, text, source, source_ref, promised_at, due_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let inserted = 0;
  const tx = db.transaction((rows) => {
    for (const p of rows) {
      const text = (p.text || "").trim();
      if (!text || text.length > 300) continue;
      const info = ins.run(
        p.relationshipId ?? null,
        p.direction === "theirs" ? "theirs" : "mine",
        text,
        p.source === "granola" ? "granola" : "telegram",
        p.sourceRef ?? null,
        p.promisedAt ?? null,
        p.dueHint ?? null
      );
      if (info.changes > 0) inserted += 1;
    }
  });
  tx(items);
  return { inserted };
}

function resolve_promise(id, status) {
  const st = ["kept", "dropped", "open"].includes(status) ? status : "kept";
  const info = getDb()
    .prepare(
      `UPDATE followup_promises
       SET status = ?, resolved_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .run(st, st === "open" ? null : _now_iso(), id);
  if (info.changes === 0) {
    const e = new Error("Promise not found");
    e.status = 404;
    throw e;
  }
  const row = getDb().prepare("SELECT * FROM followup_promises WHERE id = ?").get(id);
  return _promise_row_to_dict(row);
}

module.exports = {
  _promise_row_to_dict,
  list_snoozes,
  set_snooze,
  clear_snooze,
  list_promises,
  upsert_promises,
  resolve_promise,
};
