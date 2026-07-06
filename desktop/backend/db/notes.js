/* Cadence backend — Granola meeting-notes CRUD.
 *
 * Ported from PipeWise db/notes.js. Each note has a stable granola_id (the
 * source system's id) and a best-effort match to a relationship.
 * _match_note_to_relationship tries three signals in order of confidence:
 * attendee email ∈ relationship.contact_emails; attendee-email domain ⊃
 * company name; company name ⊃ note title. Returns null if none match —
 * the row still gets inserted, just with relationship_id=NULL.
 *
 * The PipeWise contacts table is gone, so signal 1 reads the JSON
 * contact_emails column on relationships instead of contact rows.
 * Matching is re-run on every sync, so adding an email to a relationship
 * retro-links its earlier meetings on the next sync.
 *
 * upsert_synced_notes is the entry point Granola sync calls. It dedups
 * by granola_id (UNIQUE), so re-running the sync is safe.
 */
const { getDb, _bind, _now_iso, _alnum_lower } = require("./core");

function _note_row_to_dict(row) {
  let attendees;
  try {
    attendees = JSON.parse(row.attendees || "[]");
  } catch (e) {
    attendees = [];
  }
  return {
    id: row.id,
    granolaId: row.granola_id,
    title: row.title || "",
    summary: row.summary || "",
    attendees: attendees,
    owner: row.owner,
    relationshipId: row.relationship_id,
    meetingDate: row.meeting_date,
    noteCreatedAt: row.note_created_at,
    noteUpdatedAt: row.note_updated_at,
    syncedAt: row.synced_at,
  };
}

// Best-effort match of a Granola note to a relationship.
// emailToRelationship: {lowercased email → relationship id}, built once per
// sync from the relationships' contact_emails JSON columns.
function _match_note_to_relationship(note, emailToRelationship, relationships) {
  const attendees = note.attendees || [];

  // 1. attendee email ∈ relationship.contact_emails
  for (const a of attendees) {
    const em = (a.email || "").trim().toLowerCase();
    if (em && em in emailToRelationship) return emailToRelationship[em];
  }

  // 2. attendee email domain vs company name
  const domains = new Set();
  for (const a of attendees) {
    const em = (a.email || "").trim().toLowerCase();
    if (em.includes("@")) domains.add(_alnum_lower(em.split("@")[1]));
  }
  for (const r of relationships) {
    const comp = _alnum_lower(r.company);
    if (comp.length < 3) continue;
    for (const dom of domains) {
      if (dom.includes(comp)) return r.id;
    }
  }

  // 3. company name in the note title
  const titleNorm = _alnum_lower(note.title);
  for (const r of relationships) {
    const comp = _alnum_lower(r.company);
    if (comp.length >= 4 && titleNorm.includes(comp)) return r.id;
  }

  return null;
}

function list_synced_notes(relationship_id = null) {
  let rows;
  if (relationship_id != null) {
    rows = getDb()
      .prepare(
        "SELECT * FROM notes WHERE relationship_id = ? ORDER BY meeting_date DESC, id DESC"
      )
      .all(relationship_id);
  } else {
    rows = getDb()
      .prepare("SELECT * FROM notes ORDER BY meeting_date DESC, id DESC")
      .all();
  }
  return rows.map(_note_row_to_dict);
}

function get_note_by_id(note_id) {
  const row = getDb().prepare("SELECT * FROM notes WHERE id = ?").get(note_id);
  return row ? _note_row_to_dict(row) : null;
}

function upsert_synced_notes(notes) {
  if (!notes || notes.length === 0) return { synced: 0, new: 0, matched: 0 };
  let newCount = 0;
  let matched = 0;
  const db = getDb();

  // Matching context — built once per sync. Archived relationships are
  // included on purpose: their past meetings should stay linked.
  const relationships = db
    .prepare("SELECT id, name, company, contact_emails FROM relationships")
    .all();
  const emailToRelationship = {};
  for (const r of relationships) {
    let emails;
    try {
      emails = JSON.parse(r.contact_emails || "[]");
    } catch (e) {
      emails = [];
    }
    if (!Array.isArray(emails)) continue;
    for (const em of emails) {
      const key = String(em || "").trim().toLowerCase();
      // first relationship claiming an email wins (stable: id ASC order)
      if (key && !(key in emailToRelationship)) emailToRelationship[key] = r.id;
    }
  }

  const selById = db.prepare("SELECT id FROM notes WHERE granola_id = ?");
  const upd = db.prepare(
    `UPDATE notes
        SET title = ?, summary = ?, attendees = ?, owner = ?,
            relationship_id = ?, meeting_date = ?, note_created_at = ?,
            note_updated_at = ?, synced_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE granola_id = ?`
  );
  const ins = db.prepare(
    `INSERT INTO notes
       (granola_id, title, summary, attendees, owner, relationship_id,
        meeting_date, note_created_at, note_updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const note of notes) {
    const gid = note.granolaId;
    if (!gid) continue;
    const relationshipId = _match_note_to_relationship(
      note, emailToRelationship, relationships
    );
    if (relationshipId) matched += 1;
    const attendeesJson = JSON.stringify(note.attendees || []);
    const existing = selById.get(gid);
    if (existing) {
      upd.run(
        ..._bind([
          note.title,
          note.summary,
          attendeesJson,
          note.owner,
          relationshipId,
          note.meetingDate,
          note.createdAt,
          note.updatedAt,
          _now_iso(),
          gid,
        ])
      );
    } else {
      newCount += 1;
      ins.run(
        ..._bind([
          gid,
          note.title,
          note.summary,
          attendeesJson,
          note.owner,
          relationshipId,
          note.meetingDate,
          note.createdAt,
          note.updatedAt,
          _now_iso(),
        ])
      );
    }
  }
  return { synced: notes.length, new: newCount, matched: matched };
}

// Re-run matching for notes that never found a relationship — called after
// a relationship is created (manually or from an accepted suggestion) so a
// new client's past meetings link up immediately instead of waiting for the
// next Granola sync. Returns how many notes got linked.
function rematch_unmatched_notes() {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM notes WHERE relationship_id IS NULL")
    .all();
  if (rows.length === 0) return 0;

  // Same matching context as upsert_synced_notes.
  const relationships = db
    .prepare("SELECT id, name, company, contact_emails FROM relationships")
    .all();
  const emailToRelationship = {};
  for (const r of relationships) {
    let emails;
    try {
      emails = JSON.parse(r.contact_emails || "[]");
    } catch (e) {
      emails = [];
    }
    if (!Array.isArray(emails)) continue;
    for (const em of emails) {
      const key = String(em || "").trim().toLowerCase();
      if (key && !(key in emailToRelationship)) emailToRelationship[key] = r.id;
    }
  }

  const upd = db.prepare(
    "UPDATE notes SET relationship_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  );
  let linked = 0;
  for (const row of rows) {
    const note = _note_row_to_dict(row);
    const relationshipId = _match_note_to_relationship(
      note, emailToRelationship, relationships
    );
    if (relationshipId) {
      upd.run(relationshipId, row.id);
      linked += 1;
    }
  }
  return linked;
}

module.exports = {
  _note_row_to_dict,
  list_synced_notes,
  get_note_by_id,
  upsert_synced_notes,
  rematch_unmatched_notes,
};
