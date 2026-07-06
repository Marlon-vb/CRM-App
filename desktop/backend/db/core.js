/* Cadence backend — SQLite persistence layer (core).
 *
 * Ported from PipeWise db/core.js. Holds the single shared SQLite
 * connection, the schema DDL, all migrations (idempotent, additive), and
 * the _meta key/value helpers. Domain CRUD lives in sibling modules under
 * db/ and imports what it needs from here.
 *
 * Differences from PipeWise (per BUILD_SPEC.md):
 *  - deals → relationships: the 20-column deal model reduces to
 *    {name, company, telegram binding, contact_emails, cadence_days,
 *    archived_at} — the only columns the smart features actually read.
 *    Stage is gone; its single functional use (cadence defaults) is now the
 *    per-relationship cadence_days column (followup_cadences table folded in).
 *  - telegram_chat_id is stored on relationships (PipeWise captured it but
 *    joined by fuzzy name). TEXT, not INTEGER — GramJS dialog IDs are
 *    bigints and better-sqlite3 has no native BigInt support.
 *  - No contacts / outreach_queue / client_opportunity_cache /
 *    telegram_groups tables, no cloud_id columns (Phase 4 concern), and no
 *    demo seeding — production and dev both boot empty.
 *  - WAL journal mode so the 30-minute backend sweep can write while the
 *    UI reads without SQLITE_BUSY stalls.
 *
 * Notes preserved from the original Python→Node port:
 *  - better-sqlite3 is synchronous and single-threaded, so no lock is
 *    needed — one shared connection.
 *  - cur.lastrowid → info.lastInsertRowid ; cur.rowcount → info.changes.
 *  - Function names keep snake_case so PipeWise modules port near-
 *    mechanically.
 *  - _now_iso() uses Date.toISOString() — "…Z" with millisecond precision.
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { DATA_DIR, DB_PATH } = require("../config");

// ── connection ─────────────────────────────────────────────────────

let _conn = null;

function getDb() {
  if (_conn) return _conn;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _conn = new Database(DB_PATH);
  _conn.pragma("journal_mode = WAL");
  _conn.pragma("foreign_keys = ON");
  return _conn;
}

// ── small helpers ──────────────────────────────────────────────────

function _now_iso() {
  return new Date().toISOString();
}

function _now_iso_offset(deltaSeconds) {
  return new Date(Date.now() + deltaSeconds * 1000).toISOString();
}

// Lowercased, whitespace-collapsed task text — used for dedup comparison.
function _normalize_task(text) {
  return (text || "").toLowerCase().trim().split(/\s+/).filter(Boolean).join(" ");
}

// Keep only letters + digits, lowercased (unicode-aware, like Python isalnum).
function _alnum_lower(s) {
  return [...(s || "").toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join("");
}

// Map undefined → null so better-sqlite3 (which rejects undefined) is happy.
function _bind(values) {
  return values.map((v) => (v === undefined ? null : v));
}

// Thrown by create_* on invalid input. The routes error middleware reads
// .status → HTTP 400.
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

// ── schema ─────────────────────────────────────────────────────────

const SCHEMA_SQL = `
            -- Multi-tenancy (kept from PipeWise Phase 0) — accounts; every
            -- tenant table carries user_id. Single local user for now, but
            -- keeps the Phase 4 cloud-sync migration cheap.
            CREATE TABLE IF NOT EXISTS users (
              id             INTEGER PRIMARY KEY AUTOINCREMENT,
              email          TEXT NOT NULL UNIQUE,
              password_hash  TEXT,
              display_name   TEXT,
              created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            -- The spine of the app. Everything else FKs into it (todos,
            -- notes, promises) or relates semantically (suggestions become
            -- relationships on accept).
            CREATE TABLE IF NOT EXISTS relationships (
              id                     INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id                INTEGER NOT NULL DEFAULT 1,
              name                   TEXT NOT NULL,
              company                TEXT,
              telegram_group         TEXT,
              telegram_contact       TEXT,
              telegram_chat_id       TEXT,
              telegram_last_activity TEXT,
              contact_emails         TEXT NOT NULL DEFAULT '[]',
              cadence_days           INTEGER NOT NULL DEFAULT 14 CHECK (cadence_days BETWEEN 1 AND 365),
              archived_at            TEXT,
              created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS todos (
              id                  INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id             INTEGER NOT NULL DEFAULT 1,
              task                TEXT NOT NULL,
              source              TEXT NOT NULL DEFAULT 'manual',
              source_ref          TEXT,
              source_conversation TEXT,
              source_snippet      TEXT,
              relationship_id     INTEGER REFERENCES relationships(id) ON DELETE SET NULL,
              due_date            TEXT,
              priority            TEXT NOT NULL DEFAULT 'medium',
              starred             INTEGER NOT NULL DEFAULT 0,
              my_day              INTEGER NOT NULL DEFAULT 0,
              sort_order          REAL NOT NULL DEFAULT 0,
              completed           INTEGER NOT NULL DEFAULT 0,
              completed_at        TEXT,
              notes               TEXT,
              deleted             INTEGER NOT NULL DEFAULT 0,
              deleted_at          TEXT,
              created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS notes (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id          INTEGER NOT NULL DEFAULT 1,
              granola_id       TEXT NOT NULL UNIQUE,
              title            TEXT,
              summary          TEXT,
              attendees        TEXT,
              owner            TEXT,
              relationship_id  INTEGER REFERENCES relationships(id) ON DELETE SET NULL,
              meeting_date     TEXT,
              note_created_at  TEXT,
              note_updated_at  TEXT,
              synced_at        TEXT,
              created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            -- Snoozes: parked queue items. mode 'until' uses the until
            -- timestamp; mode 'after_reply' hides the item until a NEW
            -- inbound message arrives (last_inbound_at is the snapshot at
            -- snooze time), with a 7-day failsafe in the queue builder.
            CREATE TABLE IF NOT EXISTS followup_snoozes (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id          INTEGER NOT NULL DEFAULT 1,
              item_key         TEXT NOT NULL,
              mode             TEXT NOT NULL DEFAULT 'until',
              until            TEXT,
              last_inbound_at  TEXT,
              created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(user_id, item_key)
            );

            -- Promises: commitments extracted from outbound Telegram
            -- messages + Granola notes ("I'll send the deck by Monday").
            -- direction 'mine' = the user owes it, 'theirs' = counterparty.
            -- UNIQUE(user_id, relationship_id, text) makes re-extraction
            -- idempotent.
            CREATE TABLE IF NOT EXISTS followup_promises (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id          INTEGER NOT NULL DEFAULT 1,
              relationship_id  INTEGER REFERENCES relationships(id) ON DELETE CASCADE,
              direction        TEXT NOT NULL DEFAULT 'mine',
              text             TEXT NOT NULL,
              source           TEXT NOT NULL DEFAULT 'telegram',
              source_ref       TEXT,
              promised_at      TEXT,
              due_hint         TEXT,
              status           TEXT NOT NULL DEFAULT 'open',
              resolved_at      TEXT,
              created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(user_id, relationship_id, text)
            );

            -- New-client suggestions. Two sources feed this table:
            --   'telegram' — the sweep's unknown-dialog scan (the
            --     "<company> <> X" room-name convention + first-touch intent)
            --   'granola'  — unmatched meetings (title convention or
            --     attendee email domains)
            -- Lifecycle: pending → accepted (becomes a relationship) |
            -- dismissed (suppressed from future scans). dedupe_ref keys the
            -- UNIQUE: raw group name for telegram rows,
            -- 'granola:<normalized name>' for granola rows — inserts use
            -- ON CONFLICT DO NOTHING, so re-scans are idempotent.
            CREATE TABLE IF NOT EXISTS suggestions (
              id                INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id           INTEGER NOT NULL DEFAULT 1,
              source            TEXT NOT NULL DEFAULT 'telegram',
              telegram_group    TEXT,
              telegram_chat_id  TEXT,
              suggested_name    TEXT,
              company           TEXT,
              first_message     TEXT,
              message_count     INTEGER,
              dedupe_ref        TEXT NOT NULL,
              status            TEXT NOT NULL DEFAULT 'pending',
              created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(dedupe_ref, status)
            );

            -- Additional Telegram chats linked to a relationship beyond its
            -- primary binding (the telegram_* columns on relationships):
            -- per-person DMs, side rooms. The sweep walks primary + these,
            -- and the queue engine sees one AGGREGATED conversation per
            -- relationship (newest chat wins for waiting_on/messages,
            -- max(last_activity) for cold detection).
            CREATE TABLE IF NOT EXISTS relationship_chats (
              id                INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id           INTEGER NOT NULL DEFAULT 1,
              relationship_id   INTEGER NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
              kind              TEXT NOT NULL DEFAULT 'group',  -- group | dm
              telegram_group    TEXT,
              telegram_chat_id  TEXT,
              contact_name      TEXT,
              last_activity     TEXT,
              created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS _meta (
              key   TEXT PRIMARY KEY,
              value TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_relationships_archived ON relationships(archived_at);
            CREATE INDEX IF NOT EXISTS idx_relationship_chats_rel ON relationship_chats(relationship_id);
            CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);
            CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(completed);
            CREATE INDEX IF NOT EXISTS idx_todos_deleted ON todos(deleted);
            CREATE INDEX IF NOT EXISTS idx_todos_source_ref ON todos(source_ref);
            CREATE INDEX IF NOT EXISTS idx_notes_relationship ON notes(relationship_id);
            CREATE INDEX IF NOT EXISTS idx_notes_meeting_date ON notes(meeting_date);
            CREATE INDEX IF NOT EXISTS idx_fu_snoozes_key ON followup_snoozes(user_id, item_key);
            CREATE INDEX IF NOT EXISTS idx_fu_promises_relationship ON followup_promises(relationship_id, status);
`;

// ── schema + migrations ────────────────────────────────────────────

// Tenant-scoped tables — every row belongs to exactly one user.
const _TENANT_TABLES = [
  "relationships", "todos", "notes", "suggestions",
  "followup_snoozes", "followup_promises",
];

// Seed the single local user (id 1). All rows default to user_id 1, so
// current callers work unchanged until multi-account lands (Phase 4).
function _ensure_local_user() {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO users (id, email, display_name) " +
        "VALUES (1, 'local@cadence.app', 'Local User')"
    )
    .run();
}

// Additive: give every tenant table a user_id column + index. Idempotent —
// the ALTER only runs when the column is missing; the index is IF NOT EXISTS.
// A no-op on fresh installs (the DDL already has user_id) but kept so a
// future table added without the column self-heals like PipeWise's did.
function _ensure_user_id_columns() {
  const db = getDb();
  for (const t of _TENANT_TABLES) {
    const cols = new Set(db.pragma(`table_info(${t})`).map((r) => r.name));
    if (!cols.has("user_id")) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
      console.log(`[DB]   added user_id to ${t}`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_user ON ${t}(user_id)`);
  }
}

// Suggestions v1 → v2: add source/company/dedupe_ref and move the UNIQUE
// from (telegram_group, status) to (dedupe_ref, status) so Granola-sourced
// suggestions (no group) dedupe too. SQLite can't alter constraints, so
// this is a rename → recreate → copy → drop rebuild. Idempotent: keyed on
// the dedupe_ref column existing. Existing rows are all telegram-sourced.
function _ensure_suggestions_v2() {
  const db = getDb();
  const cols = new Set(db.pragma("table_info(suggestions)").map((r) => r.name));
  if (cols.has("dedupe_ref")) return;
  console.log("[DB]   migrating suggestions → v2 (source + dedupe_ref)");
  db.exec(`
    BEGIN;
    ALTER TABLE suggestions RENAME TO suggestions_v1;
    CREATE TABLE suggestions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL DEFAULT 1,
      source            TEXT NOT NULL DEFAULT 'telegram',
      telegram_group    TEXT,
      telegram_chat_id  TEXT,
      suggested_name    TEXT,
      company           TEXT,
      first_message     TEXT,
      message_count     INTEGER,
      dedupe_ref        TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(dedupe_ref, status)
    );
    INSERT INTO suggestions (id, user_id, source, telegram_group,
                             telegram_chat_id, suggested_name, company,
                             first_message, message_count, dedupe_ref,
                             status, created_at, updated_at)
      SELECT id, user_id, 'telegram', telegram_group, telegram_chat_id,
             suggested_name, NULL, first_message, message_count,
             telegram_group, status, created_at, updated_at
        FROM suggestions_v1;
    DROP TABLE suggestions_v1;
    COMMIT;
  `);
  // Indexes are dropped with the old table — recreate.
  db.exec("CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_suggestions_user ON suggestions(user_id)");
}

// For any dedupe_ref with both a 'pending' AND a 'dismissed' suggestion,
// delete the pending one. The dismissed entry wins (the user already said
// no) — and the pair would otherwise trip UNIQUE(dedupe_ref, status)
// on the next status change. Idempotent.
function _dedupe_dismissed_duplicates() {
  const info = getDb()
    .prepare(
      `DELETE FROM suggestions
        WHERE status = 'pending'
          AND dedupe_ref IN (
              SELECT dedupe_ref FROM suggestions WHERE status = 'dismissed'
          )`
    )
    .run();
  if (info.changes > 0) {
    console.log(
      `[DB]   cleaned up ${info.changes} duplicate pending suggestion` +
        `${info.changes !== 1 ? "s" : ""} (dismissed wins)`
    );
  }
}

function _init_db() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = getDb();
  db.exec(SCHEMA_SQL);

  // Local user + user_id on every tenant table.
  _ensure_local_user();
  _ensure_user_id_columns();

  // Additive column migrations go here as the schema evolves — same
  // pattern as PipeWise: check pragma table_info, ALTER only when missing.
  _ensure_suggestions_v2();
  _ensure_suggestion_attach_column();
  _dedupe_dismissed_duplicates();
}

// Attach-flavored suggestions ("this DM looks like client X — link it?")
// carry the target relationship id; accept attaches a relationship_chat
// instead of creating a new relationship. Additive, nullable.
function _ensure_suggestion_attach_column() {
  const db = getDb();
  const cols = new Set(db.pragma("table_info(suggestions)").map((r) => r.name));
  if (!cols.has("attach_relationship_id")) {
    db.exec("ALTER TABLE suggestions ADD COLUMN attach_relationship_id INTEGER");
    console.log("[DB]   added attach_relationship_id to suggestions");
  }
}

// ── _meta key/value helpers ────────────────────────────────────────

function _meta_get(key) {
  const row = getDb().prepare("SELECT value FROM _meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function _meta_set(key, value) {
  getDb()
    .prepare(
      "INSERT INTO _meta(key, value) VALUES(?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    .run(key, value);
}

module.exports = {
  // connection
  getDb,
  // helpers
  _now_iso,
  _now_iso_offset,
  _normalize_task,
  _alnum_lower,
  _bind,
  ValidationError,
  // schema + migrations
  _init_db,
  // _meta (exposed for callers that need to read/write app-level meta keys)
  _meta_get,
  _meta_set,
};
