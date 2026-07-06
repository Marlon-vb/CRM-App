/* Cadence backend — todos CRUD.
 *
 * Ported near-verbatim from PipeWise db/todos.js (deal_id →
 * relationship_id is the only structural change).
 *
 * Todos can be manual or extracted from Telegram / Granola transcripts.
 * Soft-deletes (deleted=1) instead of DELETE so the LLM extractor can dedup
 * against tombstones — extracting the same "follow up next week" five times
 * shouldn't surface five rows.
 *
 * Two dedup strategies in upsert_extracted_todos:
 *   - source_ref match — the source system's stable id (message id, etc.)
 *   - normalized-task match — _normalize_task() collapses whitespace and
 *     lowercases so trivial wording differences don't bypass dedup.
 *
 * sort_order is a REAL — newly-extracted items sort BELOW the current
 * min by appending decreasing offsets, so the latest extractions float
 * to the top without renumbering existing rows.
 */
const { getDb, _bind, _now_iso, _normalize_task, ValidationError } = require("./core");

const VALID_TODO_PRIORITIES = new Set(["high", "medium", "low"]);

const _TODO_FIELD_MAP = {
  task: "task",
  dueDate: "due_date",
  priority: "priority",
  starred: "starred",
  myDay: "my_day",
  sortOrder: "sort_order",
  completed: "completed",
  notes: "notes",
};

const _TODO_BOOL_FIELDS = new Set(["starred", "myDay", "completed"]);

function _todo_row_to_dict(row) {
  return {
    id: row.id,
    task: row.task,
    source: row.source || "manual",
    sourceRef: row.source_ref,
    sourceConversation: row.source_conversation || "",
    sourceSnippet: row.source_snippet || "",
    relationshipId: row.relationship_id,
    dueDate: row.due_date,
    priority: row.priority || "medium",
    starred: Boolean(row.starred),
    myDay: Boolean(row.my_day),
    sortOrder: row.sort_order,
    completed: Boolean(row.completed),
    completedAt: row.completed_at,
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function _flatten_todo_input(body) {
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!(k in _TODO_FIELD_MAP)) continue;
    const col = _TODO_FIELD_MAP[k];
    out[col] = _TODO_BOOL_FIELDS.has(k) ? (v ? 1 : 0) : v;
  }
  if ("priority" in out && out.priority && !VALID_TODO_PRIORITIES.has(out.priority)) {
    out.priority = "medium";
  }
  return out;
}

function list_todos(include_completed = true, completed_window_days = 7) {
  const rows = getDb()
    .prepare("SELECT * FROM todos WHERE deleted = 0 ORDER BY sort_order ASC, id ASC")
    .all();
  const todos = rows.map(_todo_row_to_dict);
  if (!include_completed) return todos.filter((t) => !t.completed);
  const cutoff = Date.now() / 1000 - completed_window_days * 86400;
  const out = [];
  for (const t of todos) {
    if (t.completed && t.completedAt) {
      const ts = Date.parse(t.completedAt);
      if (!Number.isNaN(ts) && ts / 1000 < cutoff) continue; // archived
    }
    out.push(t);
  }
  return out;
}

function create_todo(body) {
  const task = (body.task || "").trim();
  if (!task) throw new ValidationError("task is required");
  const flat = _flatten_todo_input(body);
  flat.task = task;
  if (!("priority" in flat)) flat.priority = "medium";
  flat.source = body.source === "telegram" ? "telegram" : "manual";
  for (const [jsonKey, col] of [
    ["sourceRef", "source_ref"],
    ["sourceConversation", "source_conversation"],
    ["sourceSnippet", "source_snippet"],
    ["relationshipId", "relationship_id"],
  ]) {
    if (body[jsonKey] != null) flat[col] = body[jsonKey];
  }
  if (flat.completed) flat.completed_at = _now_iso();
  const db = getDb();
  if (!("sort_order" in flat)) {
    const row = db
      .prepare(
        "SELECT COALESCE(MIN(sort_order), 0) AS m FROM todos WHERE deleted = 0"
      )
      .get();
    flat.sort_order = (row.m || 0) - 1; // new items sort to the top
  }
  const cols = Object.keys(flat);
  const sql = `INSERT INTO todos (${cols.join(", ")}) VALUES (${cols
    .map(() => "?")
    .join(", ")})`;
  const info = db.prepare(sql).run(..._bind(cols.map((c) => flat[c])));
  const row = db.prepare("SELECT * FROM todos WHERE id = ?").get(info.lastInsertRowid);
  return _todo_row_to_dict(row);
}

function update_todo(todo_id, body) {
  const flat = _flatten_todo_input(body);
  if (Object.keys(flat).length === 0) return null;
  if ("completed" in flat) {
    // keep completed_at in sync so the Completed section + archival work
    flat.completed_at = flat.completed ? _now_iso() : null;
  }
  const cols = Object.keys(flat);
  const sql =
    `UPDATE todos SET ${cols.map((c) => `${c} = ?`).join(", ")}, ` +
    "updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted = 0";
  const info = getDb()
    .prepare(sql)
    .run(..._bind([...cols.map((c) => flat[c]), todo_id]));
  if (info.changes === 0) return null;
  const row = getDb().prepare("SELECT * FROM todos WHERE id = ?").get(todo_id);
  return _todo_row_to_dict(row);
}

function delete_todo(todo_id) {
  // Soft-delete. The row stays so re-extraction can dedup against it.
  return (
    getDb()
      .prepare(
        "UPDATE todos SET deleted = 1, deleted_at = ?, " +
          "updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted = 0"
      )
      .run(_now_iso(), todo_id).changes > 0
  );
}

function reorder_todos(ordered_ids) {
  const stmt = getDb().prepare(
    "UPDATE todos SET sort_order = ?, updated_at = CURRENT_TIMESTAMP " +
      "WHERE id = ? AND deleted = 0"
  );
  ordered_ids.forEach((tid, idx) => {
    stmt.run(idx, Number(tid));
  });
  return list_todos();
}

function upsert_extracted_todos(items) {
  if (!items || items.length === 0) return { inserted: [], skipped: 0 };
  const inserted = [];
  let skipped = 0;
  const db = getDb();

  const existingRefs = new Set(
    db
      .prepare("SELECT source_ref FROM todos WHERE source_ref IS NOT NULL")
      .all()
      .map((r) => r.source_ref)
  );
  // Dedup against every non-deleted todo — completed included, no time limit.
  const existingTasks = new Set(
    db
      .prepare("SELECT task FROM todos WHERE deleted = 0")
      .all()
      .map((r) => _normalize_task(r.task))
  );
  const minSortRow = db
    .prepare("SELECT COALESCE(MIN(sort_order), 0) AS m FROM todos WHERE deleted = 0")
    .get();
  const minSort = minSortRow.m || 0;

  const ins = db.prepare(
    `INSERT INTO todos
       (task, source, source_ref, source_conversation,
        source_snippet, relationship_id, due_date, priority, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const sel = db.prepare("SELECT * FROM todos WHERE id = ?");

  items.forEach((item, i) => {
    const task = (item.task || "").trim();
    if (!task) {
      skipped += 1;
      return;
    }
    const ref = item.sourceRef || item.source_ref || null;
    const norm = _normalize_task(task);
    if ((ref && existingRefs.has(ref)) || existingTasks.has(norm)) {
      skipped += 1;
      return;
    }
    let priority = item.priority || "medium";
    if (!VALID_TODO_PRIORITIES.has(priority)) priority = "medium";
    let src = item.source || "telegram";
    if (src !== "telegram" && src !== "granola") src = "telegram";
    const info = ins.run(
      ..._bind([
        task,
        src,
        ref,
        item.sourceConversation || item.source_conversation || null,
        item.sourceSnippet || item.source_snippet || null,
        item.relationshipId || item.relationship_id || null,
        item.dueDate || item.due_date || null,
        priority,
        minSort - 1 - i, // newly-extracted items sort to the top
      ])
    );
    const row = sel.get(info.lastInsertRowid);
    inserted.push(_todo_row_to_dict(row));
    if (ref) existingRefs.add(ref);
    existingTasks.add(norm);
  });

  return { inserted, skipped };
}

module.exports = {
  _todo_row_to_dict,
  list_todos,
  create_todo,
  update_todo,
  delete_todo,
  reorder_todos,
  upsert_extracted_todos,
};
