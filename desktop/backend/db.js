/* Cadence backend — SQLite persistence layer (barrel).
 *
 * The implementation lives under desktop/backend/db/:
 *   - core.js           connection, schema, migrations, helpers, ValidationError
 *   - relationships.js  relationship CRUD + _relationship_row_to_dict
 *   - suggestions.js    new-conversation suggestions
 *   - todos.js          todos + extracted-todo upsert + soft delete
 *   - notes.js          Granola meeting notes + best-effort relationship matching
 *   - followups.js      follow-up engine storage (snoozes + promises)
 *
 * Thin barrel, same convention as PipeWise — callers `require("./db")` and
 * never reach into the domain modules directly. If you add a new function
 * to one of the domain modules, remember to re-export it here.
 */

const core          = require("./db/core");
const relationships = require("./db/relationships");
const suggestions   = require("./db/suggestions");
const todos         = require("./db/todos");
const notes         = require("./db/notes");
const followups     = require("./db/followups");

module.exports = {
  // ── core ────────────────────────────────────────────────────────
  getDb:           core.getDb,
  ValidationError: core.ValidationError,
  _now_iso:        core._now_iso,
  _now_iso_offset: core._now_iso_offset,
  _normalize_task: core._normalize_task,
  _init_db:        core._init_db,
  _meta_get:       core._meta_get,
  _meta_set:       core._meta_set,

  // ── row→dict converters (kept here so external callers that reach
  // for them — e.g. routes assembling custom payloads — don't have to
  // know which domain module owns each one) ──────────────────────
  _relationship_row_to_dict: relationships._relationship_row_to_dict,
  _suggestion_row_to_dict:   suggestions._suggestion_row_to_dict,
  _todo_row_to_dict:         todos._todo_row_to_dict,
  _note_row_to_dict:         notes._note_row_to_dict,
  _promise_row_to_dict:      followups._promise_row_to_dict,

  // ── relationships ───────────────────────────────────────────────
  list_relationships:         relationships.list_relationships,
  get_relationship:           relationships.get_relationship,
  create_relationship:        relationships.create_relationship,
  update_relationship:        relationships.update_relationship,
  archive_relationship:       relationships.archive_relationship,
  unarchive_relationship:     relationships.unarchive_relationship,
  delete_relationship:        relationships.delete_relationship,
  set_telegram_last_activity: relationships.set_telegram_last_activity,
  set_telegram_chat_id:       relationships.set_telegram_chat_id,
  list_relationship_chats:    relationships.list_relationship_chats,
  add_relationship_chat:      relationships.add_relationship_chat,
  remove_relationship_chat:   relationships.remove_relationship_chat,
  set_chat_last_activity:     relationships.set_chat_last_activity,
  set_chat_chat_id:           relationships.set_chat_chat_id,

  // ── suggestions ─────────────────────────────────────────────────
  insert_suggestion:           suggestions.insert_suggestion,
  list_suggestions:            suggestions.list_suggestions,
  get_suggestion:              suggestions.get_suggestion,
  set_suggestion_status:       suggestions.set_suggestion_status,
  list_active_groups:          suggestions.list_active_groups,
  taken_client_names:          suggestions.taken_client_names,
  suggest_from_unmatched_notes: suggestions.suggest_from_unmatched_notes,

  // ── todos ───────────────────────────────────────────────────────
  list_todos:             todos.list_todos,
  create_todo:            todos.create_todo,
  update_todo:            todos.update_todo,
  delete_todo:            todos.delete_todo,
  reorder_todos:          todos.reorder_todos,
  upsert_extracted_todos: todos.upsert_extracted_todos,

  // ── notes ───────────────────────────────────────────────────────
  list_synced_notes:       notes.list_synced_notes,
  get_note_by_id:          notes.get_note_by_id,
  upsert_synced_notes:     notes.upsert_synced_notes,
  rematch_unmatched_notes: notes.rematch_unmatched_notes,

  // ── follow-up engine ────────────────────────────────────────────
  list_fu_snoozes:    followups.list_snoozes,
  set_fu_snooze:      followups.set_snooze,
  clear_fu_snooze:    followups.clear_snooze,
  list_fu_promises:   followups.list_promises,
  upsert_fu_promises: followups.upsert_promises,
  resolve_fu_promise: followups.resolve_promise,
};
