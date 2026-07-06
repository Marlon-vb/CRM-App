/* Cadence backend — relationships CRUD.
 *
 * Adapted from PipeWise db/deals.js. The relationships table is the spine
 * of the app: todos, notes, and promises FK into it, and suggestions become
 * relationships on accept. The helpers here are the only supported way to
 * mutate a relationship row.
 *
 * Differences from the deals model (per BUILD_SPEC.md):
 *  - No stage/amount/pipeline columns — the row is just {name, company,
 *    telegram binding, contact_emails, cadence_days, archived_at}.
 *  - archived_at replaces lost_at: the queue engine skips archived rows.
 *  - telegram_chat_id is first-class (TEXT — GramJS dialog IDs are bigints,
 *    better-sqlite3 has no native BigInt support). The sweep prefers it as
 *    the join key and self-heals it via set_telegram_chat_id after a
 *    successful name match.
 *  - contact_emails is a JSON array column — Granola note matching signal 1.
 *  - No contacts[] enrichment — the contacts table is gone.
 */
const { getDb, _bind, _now_iso, ValidationError } = require("./core");

// ── row → API dict (matches the spec's relationship shape) ────────

function _relationship_row_to_dict(row) {
  let contactEmails;
  try {
    contactEmails = JSON.parse(row.contact_emails || "[]");
  } catch (e) {
    contactEmails = [];
  }
  if (!Array.isArray(contactEmails)) contactEmails = [];
  // telegramChat is null when the relationship has no Telegram binding at
  // all; otherwise all four keys are present (null when unset) so the
  // frontend never has to guard individual keys.
  let telegramChat = null;
  if (row.telegram_group || row.telegram_chat_id) {
    telegramChat = {
      group: row.telegram_group ?? null,
      contact: row.telegram_contact ?? null,
      chatId: row.telegram_chat_id ?? null,
      lastActivity: row.telegram_last_activity ?? null,
    };
  }
  return {
    id: row.id,
    name: row.name,
    company: row.company ?? null,
    contactEmails: contactEmails,
    cadenceDays: row.cadence_days,
    archivedAt: row.archived_at ?? null,
    telegramChat: telegramChat,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── relationship CRUD ─────────────────────────────────────────────

const _REL_WRITABLE = new Set([
  "name", "company", "telegram_group", "telegram_contact",
  "telegram_chat_id", "telegram_last_activity", "contact_emails",
  "cadence_days",
]);

const _REL_FIELD_MAP = {
  name: "name",
  company: "company",
  telegramGroup: "telegram_group",
  telegramContact: "telegram_contact",
  telegramChatId: "telegram_chat_id",
  telegramLastActivity: "telegram_last_activity",
  contactEmails: "contact_emails",
  cadenceDays: "cadence_days",
};

function _flatten_relationship_input(body) {
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k in _REL_FIELD_MAP) {
      out[_REL_FIELD_MAP[k]] = v;
    } else if (k === "telegramChat") {
      // Accept the nested shape too so round-tripping a relationship dict
      // through PATCH works (same convenience deals.js offered).
      const tg = v || {};
      out.telegram_group = tg.group ?? null;
      out.telegram_contact = tg.contact ?? null;
      out.telegram_chat_id = tg.chatId ?? null;
      out.telegram_last_activity = tg.lastActivity ?? null;
    }
  }

  // GramJS dialog IDs are bigints — always store as TEXT.
  if (out.telegram_chat_id != null) {
    out.telegram_chat_id = String(out.telegram_chat_id);
  }

  // contact_emails is a JSON array column; reject anything else so a bad
  // write can't break the Granola note matcher's per-row parse.
  if ("contact_emails" in out && out.contact_emails != null) {
    if (!Array.isArray(out.contact_emails)) {
      throw new ValidationError("contactEmails must be an array");
    }
    out.contact_emails = JSON.stringify(
      out.contact_emails.map((e) => String(e).trim()).filter(Boolean)
    );
  }

  // cadence_days carries the CHECK (1..365) — validate here so the caller
  // gets a clean 400 instead of a SQLITE_CONSTRAINT 500. Same rule the
  // PipeWise set_cadence helper enforced.
  if ("cadence_days" in out && out.cadence_days != null) {
    const d = Number(out.cadence_days);
    if (!Number.isInteger(d) || d < 1 || d > 365) {
      throw new ValidationError("cadenceDays must be an integer between 1 and 365");
    }
    out.cadence_days = d;
  }

  const result = {};
  for (const [k, v] of Object.entries(out)) {
    if (_REL_WRITABLE.has(k)) result[k] = v;
  }
  return result;
}

function list_relationships(include_archived = false) {
  const sql = include_archived
    ? "SELECT * FROM relationships ORDER BY id ASC"
    : "SELECT * FROM relationships WHERE archived_at IS NULL ORDER BY id ASC";
  return getDb().prepare(sql).all().map(_relationship_row_to_dict);
}

function get_relationship(relationship_id) {
  const row = getDb()
    .prepare("SELECT * FROM relationships WHERE id = ?")
    .get(relationship_id);
  return row ? _relationship_row_to_dict(row) : null;
}

function create_relationship(body) {
  const flat = _flatten_relationship_input(body || {});
  if (!(flat.name || "").trim()) {
    throw new ValidationError("name is required");
  }
  flat.name = flat.name.trim();
  const cols = Object.keys(flat);
  const sql = `INSERT INTO relationships (${cols.join(", ")}) VALUES (${cols
    .map(() => "?")
    .join(", ")})`;
  const info = getDb().prepare(sql).run(..._bind(cols.map((c) => flat[c])));
  return get_relationship(info.lastInsertRowid);
}

function update_relationship(relationship_id, body) {
  const flat = _flatten_relationship_input(body || {});
  const cols = Object.keys(flat);
  if (cols.length === 0) return null;
  const sql =
    `UPDATE relationships SET ${cols.map((c) => `${c} = ?`).join(", ")}, ` +
    "updated_at = CURRENT_TIMESTAMP WHERE id = ?";
  const info = getDb()
    .prepare(sql)
    .run(..._bind([...cols.map((c) => flat[c]), relationship_id]));
  if (info.changes === 0) return null;
  return get_relationship(relationship_id);
}

function archive_relationship(relationship_id) {
  const info = getDb()
    .prepare(
      "UPDATE relationships SET archived_at = ?, " +
        "updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    )
    .run(_now_iso(), relationship_id);
  if (info.changes === 0) return null;
  return get_relationship(relationship_id);
}

function unarchive_relationship(relationship_id) {
  const info = getDb()
    .prepare(
      "UPDATE relationships SET archived_at = NULL, " +
        "updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    )
    .run(relationship_id);
  if (info.changes === 0) return null;
  return get_relationship(relationship_id);
}

function delete_relationship(relationship_id) {
  // FKs handle the children: todos/notes SET NULL, promises CASCADE.
  return (
    getDb()
      .prepare("DELETE FROM relationships WHERE id = ?")
      .run(relationship_id).changes > 0
  );
}

// ── sweep write-backs (telegram.js) ───────────────────────────────

// Stamp the newest message time. Called by the sweep for every matched
// chat AND by the send route after a successful send.
function set_telegram_last_activity(relationship_id, iso) {
  return (
    getDb()
      .prepare(
        "UPDATE relationships SET telegram_last_activity = ?, " +
          "updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
      .run(iso ?? null, relationship_id).changes > 0
  );
}

// Self-healing binding upgrade: after a successful fuzzy NAME match the
// sweep writes the resolved chat_id back so future joins are exact.
function set_telegram_chat_id(relationship_id, chat_id) {
  return (
    getDb()
      .prepare(
        "UPDATE relationships SET telegram_chat_id = ?, " +
          "updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
      .run(chat_id != null ? String(chat_id) : null, relationship_id).changes > 0
  );
}

module.exports = {
  _relationship_row_to_dict,
  list_relationships,
  get_relationship,
  create_relationship,
  update_relationship,
  archive_relationship,
  unarchive_relationship,
  delete_relationship,
  set_telegram_last_activity,
  set_telegram_chat_id,
};
