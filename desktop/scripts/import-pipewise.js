#!/usr/bin/env node
/* Cadence — one-time importer from a PipeWise database (Phase 3).
 *
 * Usage:
 *   node desktop/scripts/import-pipewise.js /path/to/pipewise.db [--force]
 *
 * Reads the PipeWise SQLite file READ-ONLY and writes into the Cadence DB
 * that desktop/backend/config.js resolves (dev: app/data/cadence.db; set
 * CADENCE_DB_PATH to target somewhere else). Quit Cadence first — two
 * writers on one SQLite file is asking for trouble. Run against a COPY of
 * pipewise.db if you want belt and braces; this script never writes to it.
 *
 * What imports:
 *   deals              → relationships (stage → cadence_days via the
 *                        PipeWise stage defaults; followup_cadences
 *                        override wins; lost_at → archived_at;
 *                        contacts' emails → contact_emails)
 *   todos              → todos (everything preserved, INCLUDING completed
 *                        and soft-deleted rows — the extraction dedupe
 *                        depends on tombstones, and source_ref stays
 *                        byte-identical so re-extraction can't duplicate)
 *   notes              → notes (upsert by granola_id)
 *   followup_promises  → followup_promises (INSERT OR IGNORE on the
 *                        (user_id, relationship_id, text) natural key)
 *
 * What deliberately does not import: snoozes (ephemeral, and their item
 * keys embed PipeWise row ids), suggestions, outreach_queue, pipeline
 * metadata (stage/amount/committed), opportunity caches, telegram_groups.
 *
 * Idempotence: a `pipewise_imported_at` _meta flag blocks accidental
 * re-runs; --force overrides and then per-row matching keeps things sane
 * (relationships match by exact name, todos by source_ref or
 * task+created_at, notes by granola_id, promises by natural key).
 */
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2).filter((a) => a !== "--force");
const force = process.argv.includes("--force");
const sourcePath = args[0];

if (!sourcePath) {
  console.error("Usage: node desktop/scripts/import-pipewise.js /path/to/pipewise.db [--force]");
  process.exit(1);
}
if (!fs.existsSync(sourcePath)) {
  console.error(`Source database not found: ${sourcePath}`);
  process.exit(1);
}

const Database = require("better-sqlite3");
const db = require("../backend/db");

// PipeWise stage → default touch cadence, verbatim from its followups.js.
// Used only when the deal has no followup_cadences override.
const STAGE_CADENCE_DEFAULTS = {
  sql: 7, nurture: 14, proposal: 5, compliance: 7, contract: 3, closed: 30,
};

function main() {
  db._init_db();
  const dest = db.getDb();
  const src = new Database(sourcePath, { readonly: true, fileMustExist: true });

  const importedAt = db._meta_get("pipewise_imported_at");
  if (importedAt && !force) {
    console.error(
      `This Cadence DB already imported a PipeWise database (${importedAt}).\n` +
        "Re-run with --force to import again (rows are matched, not duplicated)."
    );
    process.exit(1);
  }

  const srcTables = new Set(
    src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  );
  for (const required of ["deals", "todos", "notes"]) {
    if (!srcTables.has(required)) {
      console.error(`Source is missing the '${required}' table — is this really a pipewise.db?`);
      process.exit(1);
    }
  }

  // ── source reads (column-defensive: lost_at etc. arrived via ALTERs) ──
  const deals = src.prepare("SELECT * FROM deals").all();
  const contactsByDeal = new Map();
  if (srcTables.has("contacts")) {
    for (const c of src.prepare("SELECT deal_id, email FROM contacts").all()) {
      if (!c.email || !String(c.email).trim()) continue;
      const list = contactsByDeal.get(c.deal_id) || [];
      list.push(String(c.email).trim().toLowerCase());
      contactsByDeal.set(c.deal_id, list);
    }
  }
  const cadenceByDeal = new Map();
  if (srcTables.has("followup_cadences")) {
    for (const r of src.prepare("SELECT deal_id, days FROM followup_cadences").all()) {
      cadenceByDeal.set(r.deal_id, r.days);
    }
  }

  const counts = {
    relationships: 0, relationshipsMatched: 0,
    todos: 0, todosSkipped: 0,
    notesNew: 0, notesUpdated: 0,
    promises: 0, promisesSkipped: 0,
  };

  // created_at/updated_at are NOT NULL in Cadence — an explicit NULL
  // overrides the column DEFAULT and (under INSERT OR IGNORE) becomes a
  // silently dropped row. Coalesce to import time for any source row
  // missing its timestamps.
  const importStamp = db._now_iso();
  const ts = (v) => v || importStamp;

  const tx = dest.transaction(() => {
    // ── 1. deals → relationships ──────────────────────────────────────
    const relByName = dest.prepare("SELECT id FROM relationships WHERE name = ?");
    const insRel = dest.prepare(
      `INSERT INTO relationships
         (name, company, telegram_group, telegram_contact,
          telegram_last_activity, contact_emails, cadence_days, archived_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const idMap = new Map(); // pipewise deal id → cadence relationship id
    for (const d of deals) {
      const existing = relByName.get(d.name);
      if (existing) {
        idMap.set(d.id, existing.id);
        counts.relationshipsMatched += 1;
        continue;
      }
      const emails = [...new Set(contactsByDeal.get(d.id) || [])];
      const rawCadence =
        cadenceByDeal.get(d.id) ?? STAGE_CADENCE_DEFAULTS[d.stage] ?? 14;
      const cadence = Math.min(365, Math.max(1, Math.round(Number(rawCadence) || 14)));
      const info = insRel.run(
        d.name,
        d.company || null,
        d.telegram_group || null,
        d.telegram_contact || null,
        d.telegram_last_activity || null,
        JSON.stringify(emails),
        cadence,
        d.lost_at || null, // archived: the queue engine skips these
        ts(d.created_at),
        ts(d.updated_at)
      );
      idMap.set(d.id, Number(info.lastInsertRowid));
      counts.relationships += 1;
    }

    // ── 2. todos (tombstones and completed rows included — dedupe fuel) ─
    const todoByRef = dest.prepare("SELECT id FROM todos WHERE source_ref = ?");
    const todoByTask = dest.prepare(
      "SELECT id FROM todos WHERE task = ? AND created_at IS ?"
    );
    const insTodo = dest.prepare(
      `INSERT INTO todos
         (task, source, source_ref, source_conversation, source_snippet,
          relationship_id, due_date, priority, starred, my_day, sort_order,
          completed, completed_at, notes, deleted, deleted_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of src.prepare("SELECT * FROM todos").all()) {
      const dupe = t.source_ref
        ? todoByRef.get(t.source_ref)
        : todoByTask.get(t.task, t.created_at ?? null);
      if (dupe) {
        counts.todosSkipped += 1;
        continue;
      }
      insTodo.run(
        t.task, t.source || "manual", t.source_ref || null,
        t.source_conversation || null, t.source_snippet || null,
        t.deal_id != null ? idMap.get(t.deal_id) ?? null : null,
        t.due_date || null, t.priority || "medium",
        t.starred ? 1 : 0, t.my_day ? 1 : 0, t.sort_order ?? 0,
        t.completed ? 1 : 0, t.completed_at || null, t.notes || null,
        t.deleted ? 1 : 0, t.deleted_at || null,
        ts(t.created_at), ts(t.updated_at)
      );
      counts.todos += 1;
    }

    // ── 3. notes (upsert by granola_id) ─────────────────────────────────
    const noteByGid = dest.prepare("SELECT id, relationship_id FROM notes WHERE granola_id = ?");
    const insNote = dest.prepare(
      `INSERT INTO notes
         (granola_id, title, summary, attendees, owner, relationship_id,
          meeting_date, note_created_at, note_updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const relinkNote = dest.prepare(
      "UPDATE notes SET relationship_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    for (const n of src.prepare("SELECT * FROM notes").all()) {
      const mappedRel = n.deal_id != null ? idMap.get(n.deal_id) ?? null : null;
      const existing = noteByGid.get(n.granola_id);
      if (existing) {
        // Same meeting already synced into Cadence — just adopt the link
        // if Cadence hadn't matched it to anyone yet.
        if (existing.relationship_id == null && mappedRel != null) {
          relinkNote.run(mappedRel, existing.id);
          counts.notesUpdated += 1;
        }
        continue;
      }
      insNote.run(
        n.granola_id, n.title || null, n.summary || null,
        n.attendees || "[]", n.owner || null, mappedRel,
        n.meeting_date || null, n.note_created_at || null,
        n.note_updated_at || null, n.synced_at || null
      );
      counts.notesNew += 1;
    }

    // ── 4. promises (natural key dedupes) ───────────────────────────────
    if (srcTables.has("followup_promises")) {
      const insPromise = dest.prepare(
        `INSERT OR IGNORE INTO followup_promises
           (relationship_id, direction, text, source, source_ref,
            promised_at, due_hint, status, resolved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const p of src.prepare("SELECT * FROM followup_promises").all()) {
        const mappedRel = p.deal_id != null ? idMap.get(p.deal_id) ?? null : null;
        if (p.deal_id != null && mappedRel == null) {
          counts.promisesSkipped += 1; // orphaned in the source — drop
          continue;
        }
        const info = insPromise.run(
          mappedRel, p.direction || "mine", p.text,
          p.source || "telegram", p.source_ref || null,
          p.promised_at || null, p.due_hint || null,
          p.status || "open", p.resolved_at || null,
          ts(p.created_at), ts(p.updated_at)
        );
        if (info.changes > 0) counts.promises += 1;
        else counts.promisesSkipped += 1;
      }
    }
  });
  tx();

  db._meta_set("pipewise_imported_at", new Date().toISOString());
  src.close();

  console.log("PipeWise import complete:");
  console.log(
    `  relationships: ${counts.relationships} imported` +
      (counts.relationshipsMatched ? `, ${counts.relationshipsMatched} matched existing by name` : "")
  );
  console.log(`  todos:         ${counts.todos} imported, ${counts.todosSkipped} already present`);
  console.log(`  notes:         ${counts.notesNew} imported, ${counts.notesUpdated} relinked`);
  console.log(`  promises:      ${counts.promises} imported, ${counts.promisesSkipped} skipped`);
  console.log("Launch Cadence — the first sweep will bind chats and refresh activity.");
}

main();
