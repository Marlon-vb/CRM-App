/* Cadence backend — Telegram + Granola → Todo extraction.
 *
 * Ported near-verbatim from PipeWise todos.js. Pulls recent messages from
 * relationship-linked chats (and recently-active dialogs) plus Granola
 * meeting notes, asks Haiku to surface actionable to-dos as structured JSON
 * via tool-use, validates the result, and upserts it (with dedup) into the
 * todos table.
 *
 * The Anthropic SDK is optional (same contract as drafting.js): if missing
 * or no key, _anthropic_create throws .status = 503. Results are cached
 * in-process for 30 minutes — server.js calls extract_todos() after every
 * sweep and the cache is what keeps that from overcalling Haiku. The
 * Anthropic call goes through module.exports._anthropic_create so the
 * verifier can stub the LLM layer.
 */

const crypto = require("crypto");

const db = require("./db");
const telegram = require("./telegram");
const granola = require("./granola");
const settings = require("./settings");
const { HAIKU_MODEL } = require("./config");

// Optional dep — only required for /api/todos/refresh.
let Anthropic = null;
let _HAS_ANTHROPIC = false;
try {
  const pkg = require("@anthropic-ai/sdk");
  Anthropic = pkg.default || pkg.Anthropic || pkg;
  _HAS_ANTHROPIC = true;
} catch (e) {
  _HAS_ANTHROPIC = false;
}

const CACHE_TTL_SECONDS = 30 * 60;
const _MAX_PROMPT_MESSAGES = 2000;

// In-process cache. `summary` holds the last real run's counts.
const _cache = { ts: 0, summary: null };

// ── tool schemas + system prompts ──────────────────────────────────

// Tool schemas — generic phrasing (works for any user). The personalised
// "who is this for" framing lives in the system prompt below.
const _EXTRACT_TOOL = {
  name: "record_todos",
  description: "Record the actionable to-do items found in the conversations.",
  input_schema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description:
                "Short imperative phrasing of the action, written from the " +
                "user's perspective, e.g. 'Send Tempo DAP to legal' — not " +
                "'I need to send the DAP'.",
            },
            conversation_index: {
              type: "integer",
              description: "0-based index of the conversation this came from.",
            },
            message_index: {
              type: "integer",
              description:
                "0-based index, within that conversation's message list, of " +
                "the message that triggered this todo.",
            },
            due: {
              type: "string",
              enum: ["today", "tomorrow", "this_week", "later", "none"],
              description: "Coarse due bucket inferred from the conversation.",
            },
            due_date: {
              type: "string",
              description:
                "Specific due date as YYYY-MM-DD, ONLY if the conversation " +
                "names an explicit calendar date. Otherwise omit this field.",
            },
            priority: {
              type: "string",
              enum: ["high", "medium", "low"],
              description:
                "high = the user explicitly committed to it or it blocks the " +
                "counterparty; medium = a clear pending next step; low = " +
                "nice-to-have.",
            },
          },
          required: [
            "task", "conversation_index", "message_index", "due", "priority",
          ],
        },
      },
    },
    required: ["todos"],
  },
};

// System prompts are personalised — name + role + company come from settings.
function _buildSystemPromptMessages(profile) {
  const author = profile.contextLine; // "Alex, BD lead at Acme" or "the user"
  const nameRef = profile.nameRef;    // "Alex" or "the user"
  return (
    `You extract actionable to-do items from Telegram conversations for ` +
    `${author}. A todo is a concrete next action that is ${nameRef}'s to take: ` +
    `a follow-up, an intro to make, a call to schedule, a document or deck ` +
    `to send, and so on.\n\n` +
    "Rules:\n" +
    `- Only surface actions that are genuinely ${nameRef}'s responsibility. ` +
    "  Skip things the counterparty owns, vague chit-chat, and items already " +
    "  clearly done.\n" +
    `- Phrase each task as a short imperative from ${nameRef}'s perspective.\n` +
    `- priority high = ${nameRef} explicitly committed to it, or it is blocking ` +
    "  the counterparty; medium = a clear pending next step; low = nice-to-have.\n" +
    "- Infer the `due` bucket from context. Use `due_date` only when an explicit " +
    "  calendar date is stated.\n" +
    "- `message_index` must point to the specific message that triggered the todo.\n" +
    `- Never produce a todo that duplicates one already on ${nameRef}'s list — ` +
    "  open or completed — shown above the conversations. Treat semantically- " +
    "  equivalent actions as the same todo and skip them.\n" +
    "- If there are no real action items, return an empty list.\n" +
    "Always respond by calling the record_todos tool."
  );
}

const _NOTES_EXTRACT_TOOL = {
  name: "record_todos",
  description: "Record the actionable to-do items found in the meeting notes.",
  input_schema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description:
                "Short imperative phrasing of the action, written from the " +
                "user's perspective.",
            },
            note_index: {
              type: "integer",
              description: "0-based index of the meeting note this came from.",
            },
            due: {
              type: "string",
              enum: ["today", "tomorrow", "this_week", "later", "none"],
              description: "Coarse due bucket inferred from the note.",
            },
            due_date: {
              type: "string",
              description:
                "Specific due date as YYYY-MM-DD, ONLY if the note names an " +
                "explicit calendar date. Otherwise omit.",
            },
            priority: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
          },
          required: ["task", "note_index", "due", "priority"],
        },
      },
    },
    required: ["todos"],
  },
};

function _buildSystemPromptNotes(profile) {
  const author = profile.contextLine;
  const nameRef = profile.nameRef;
  return (
    `You extract actionable to-do items from meeting notes for ${author}. ` +
    `A todo is a concrete next action that is ${nameRef}'s to take: a follow-` +
    "up, an intro to make, a document or deck to send, and so on.\n\n" +
    "Rules:\n" +
    `- Only surface actions that are genuinely ${nameRef}'s responsibility. ` +
    "  Skip things the other attendees own, and anything the notes show is " +
    "  already done.\n" +
    `- Phrase each task as a short imperative from ${nameRef}'s perspective.\n` +
    `- priority high = ${nameRef} explicitly committed to it, or it blocks the ` +
    "  counterparty; medium = a clear pending next step; low = nice-to-have.\n" +
    "- Infer the `due` bucket from context. Use `due_date` only when an explicit " +
    "  calendar date is stated.\n" +
    "- `note_index` must point to the meeting note the todo came from.\n" +
    `- Never produce a todo that duplicates one already on ${nameRef}'s list — ` +
    "  open or completed — shown above the notes. Treat semantically-equivalent " +
    "  actions as the same todo and skip them.\n" +
    "- If a note has no real action items, produce nothing for it.\n" +
    "Always respond by calling the record_todos tool."
  );
}

// ── helpers ─────────────────────────────────────────────────────────

const _WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

function _isoDate(d) {
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

function _todayStr() {
  const d = new Date();
  return `${_WEEKDAYS[d.getDay()]}, ${_isoDate(d)}`;
}

function _svc503(message) {
  const e = new Error(message);
  e.status = 503;
  return e;
}

// ── prompt building ─────────────────────────────────────────────────

function _existing_todos_lines(existing_todos, nameRef) {
  existing_todos = existing_todos || [];
  const open_t = existing_todos.filter((t) => !t.completed).slice(0, 120);
  const done_t = existing_todos.filter((t) => t.completed).slice(0, 120);
  if (!open_t.length && !done_t.length) return [];
  const out = [
    `${nameRef} ALREADY has the to-do items listed below. Do NOT create a todo ` +
      "that duplicates any of them — even if you would word it differently — " +
      "and do NOT create todos for actions these show are already handled.",
  ];
  if (open_t.length) {
    out.push("");
    out.push("Already on the list (open):");
    for (const t of open_t) out.push(`  - ${(t.task || "").trim()}`);
  }
  if (done_t.length) {
    out.push("");
    out.push("Already done (never recreate these):");
    for (const t of done_t) out.push(`  - ${(t.task || "").trim()}`);
  }
  out.push("");
  return out;
}

function _build_extraction_prompt(conversations, existing_todos = null, profile = null) {
  const p = profile || settings.getUserProfile();
  const lines = [`Today is ${_todayStr()}.`, ""];
  lines.push(..._existing_todos_lines(existing_todos, p.nameRef));
  const work = p.role ? `${p.role} work` : "work";
  const company = p.company ? ` at ${p.company}` : "";
  lines.push(
    `Below are recent Telegram conversations from ${p.nameRef}'s ${work}${company}. ` +
      "Each conversation is numbered; each message within it is numbered. " +
      "Messages are listed newest-first."
  );
  lines.push("");
  let total = 0;
  for (let ci = 0; ci < conversations.length; ci++) {
    if (total >= _MAX_PROMPT_MESSAGES) break;
    const conv = conversations[ci];
    lines.push(`=== Conversation ${ci}: ${conv.chat_name} ===`);
    const msgs = conv.messages || [];
    for (let mi = 0; mi < msgs.length; mi++) {
      const m = msgs[mi];
      const who = m.is_me ? p.nameRef : m.sender || "Them";
      const date = (m.date || "").slice(0, 10);
      const text = (m.text || "").replace(/\n/g, " ").trim();
      lines.push(`  [${mi}] (${date}) ${who}: ${text}`);
      total += 1;
    }
    lines.push("");
  }
  return lines.join("\n");
}

function _build_notes_prompt(notes, existing_todos = null, profile = null) {
  const p = profile || settings.getUserProfile();
  const lines = [`Today is ${_todayStr()}.`, ""];
  lines.push(..._existing_todos_lines(existing_todos, p.nameRef));
  const work = p.role ? `${p.role} work` : "work";
  const company = p.company ? ` at ${p.company}` : "";
  lines.push(
    `Below are recent meeting notes from ${p.nameRef}'s ${work}${company}, ` +
      "taken by an AI notetaker. Each note is numbered."
  );
  lines.push("");
  for (let ni = 0; ni < notes.length; ni++) {
    const note = notes[ni];
    const date = (note.meetingDate || note.noteCreatedAt || "").slice(0, 10);
    const attendees = (note.attendees || [])
      .filter((a) => a.name || a.email)
      .map((a) => (a.name || a.email || "").trim())
      .join(", ");
    lines.push(`=== Note ${ni}: ${note.title || "Untitled"} (${date}) ===`);
    if (attendees) lines.push(`Attendees: ${attendees}`);
    lines.push((note.summary || "").trim().slice(0, 2000));
    lines.push("");
  }
  return lines.join("\n");
}

// Map the LLM's coarse bucket / explicit date to an ISO due date.
function _resolve_due(due_bucket, explicit_date) {
  if (explicit_date) {
    const m = String(explicit_date).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (!Number.isNaN(d.getTime()) && d.getMonth() === Number(m[2]) - 1) {
        return _isoDate(d);
      }
    }
  }
  if (due_bucket === "none") return null;
  const offsets = { today: 0, tomorrow: 1, this_week: 3, later: 10 };
  if (!(due_bucket in offsets)) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsets[due_bucket]);
  return _isoDate(d);
}

// ── LLM calls ───────────────────────────────────────────────────────

async function _anthropic_create(params) {
  if (!_HAS_ANTHROPIC) {
    throw _svc503(
      "anthropic SDK not installed — run `npm install` in the desktop/ folder."
    );
  }
  const apiKey = settings.getAnthropicKey();
  if (!apiKey) {
    throw _svc503("Anthropic API key not set — add it in Cadence Settings.");
  }
  const client = new Anthropic({ apiKey });
  try {
    return await client.messages.create(params);
  } catch (e) {
    throw _svc503(`Anthropic API call failed: ${e.message}`);
  }
}

function _todos_from_tool_use(resp) {
  for (const block of resp.content || []) {
    if (block.type === "tool_use" && block.name === "record_todos") {
      const todos = (block.input || {}).todos || [];
      return Array.isArray(todos) ? todos : [];
    }
  }
  return [];
}

async function _llm_extract(conversations, existing_todos = null) {
  if (!conversations || !conversations.length) return [];
  const profile = settings.getUserProfile();
  const resp = await module.exports._anthropic_create({
    model: HAIKU_MODEL,
    max_tokens: 2000,
    system: _buildSystemPromptMessages(profile),
    tools: [_EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "record_todos" },
    messages: [
      { role: "user", content: _build_extraction_prompt(conversations, existing_todos, profile) },
    ],
  });
  return _todos_from_tool_use(resp);
}

async function _llm_extract_notes(notes, existing_todos = null) {
  if (!notes || !notes.length) return [];
  const profile = settings.getUserProfile();
  const resp = await module.exports._anthropic_create({
    model: HAIKU_MODEL,
    max_tokens: 2000,
    system: _buildSystemPromptNotes(profile),
    tools: [_NOTES_EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "record_todos" },
    messages: [
      { role: "user", content: _build_notes_prompt(notes, existing_todos, profile) },
    ],
  });
  return _todos_from_tool_use(resp);
}

// ── validation + mapping ────────────────────────────────────────────

function _sha1tag(task) {
  const norm = task.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  return crypto.createHash("sha1").update(norm, "utf8").digest("hex").slice(0, 8);
}

function _validate_and_map(raw_todos, conversations) {
  const items = [];
  for (const entry of raw_todos) {
    if (!entry || typeof entry !== "object") continue;
    const task = (entry.task || "").trim();
    if (!task || task.length > 300) continue;
    const ci = entry.conversation_index;
    if (!Number.isInteger(ci) || !(ci >= 0 && ci < conversations.length)) continue;
    const conv = conversations[ci];
    const msgs = conv.messages || [];

    const mi = entry.message_index;
    const msg =
      Number.isInteger(mi) && mi >= 0 && mi < msgs.length ? msgs[mi] : null;

    let priority = entry.priority;
    if (!["high", "medium", "low"].includes(priority)) priority = "medium";

    const due_date = _resolve_due(entry.due, entry.due_date);

    const task_tag = _sha1tag(task);
    let snippet = "";
    let source_ref;
    if (msg) {
      const mid = msg.id;
      const ref_msg = mid !== null && mid !== undefined ? mid : `m${mi}`;
      source_ref = `${conv.chat_id}:${ref_msg}:${task_tag}`;
      snippet = (msg.text || "").trim();
    } else {
      source_ref = `${conv.chat_id}:c:${task_tag}`;
    }

    items.push({
      task: task,
      source: "telegram",
      sourceRef: source_ref,
      sourceConversation: conv.chat_name || "",
      sourceSnippet: snippet.slice(0, 280),
      relationshipId: conv.relationship_id ?? null,
      dueDate: due_date,
      priority: priority,
    });
  }
  return items;
}

function _validate_and_map_notes(raw_todos, notes) {
  const items = [];
  for (const entry of raw_todos) {
    if (!entry || typeof entry !== "object") continue;
    const task = (entry.task || "").trim();
    if (!task || task.length > 300) continue;
    const ni = entry.note_index;
    if (!Number.isInteger(ni) || !(ni >= 0 && ni < notes.length)) continue;
    const note = notes[ni];
    let priority = entry.priority;
    if (!["high", "medium", "low"].includes(priority)) priority = "medium";
    const due_date = _resolve_due(entry.due, entry.due_date);
    const task_tag = _sha1tag(task);
    const gid = note.granolaId || "note";
    items.push({
      task: task,
      source: "granola",
      sourceRef: `granola:${gid}:${task_tag}`,
      sourceConversation: note.title || "Meeting note",
      sourceSnippet: (note.summary || "").trim().slice(0, 280),
      relationshipId: note.relationshipId ?? null,
      dueDate: due_date,
      priority: priority,
    });
  }
  return items;
}

// ── orchestration ───────────────────────────────────────────────────

async function _extract_from_granola(existing_todos) {
  try {
    db.upsert_synced_notes(await granola.fetch_recent_notes(30, 40));
    // Meetings that matched no tracked client are potential NEW clients —
    // surface them as suggestions (title convention / attendee domains).
    db.suggest_from_unmatched_notes(settings.getUserProfile());
  } catch (e) {
    console.log(`[todos] Granola note sync failed: ${e.message}`);
  }
  const notes = db
    .list_synced_notes()
    .filter((n) => (n.summary || "").trim())
    .slice(0, 40);
  if (!notes.length) return [[], 0];
  const raw = await _llm_extract_notes(notes, existing_todos);
  return [_validate_and_map_notes(raw, notes), notes.length];
}

async function extract_todos(force = false) {
  const now = Date.now() / 1000;
  if (
    !force &&
    _cache.summary !== null &&
    now - _cache.ts < CACHE_TTL_SECONDS
  ) {
    return { ..._cache.summary, inserted: [], skipped: 0, cached: true };
  }

  const conversations = await telegram._fetch_recent_conversations(30, 60, 60);
  const existing = db.list_todos(true, 45);
  const raw = await _llm_extract(conversations, existing);
  const items = _validate_and_map(raw, conversations);

  let note_items = [];
  let notes_scanned = 0;
  if (granola.hasKey()) {
    try {
      const r = await _extract_from_granola(existing);
      note_items = r[0];
      notes_scanned = r[1];
    } catch (e) {
      console.log(`[todos] Granola extraction skipped: ${e.message}`);
    }
  }

  const result = db.upsert_extracted_todos(items.concat(note_items));
  result.scanned = conversations.length;
  result.notesScanned = notes_scanned;
  result.extracted = items.length + note_items.length;
  result.cached = false;

  _cache.ts = now;
  _cache.summary = {
    scanned: result.scanned,
    notesScanned: notes_scanned,
    extracted: result.extracted,
  };
  return result;
}

module.exports = {
  _HAS_ANTHROPIC,
  _anthropic_create,
  _existing_todos_lines,
  _build_extraction_prompt,
  _build_notes_prompt,
  _resolve_due,
  _validate_and_map,
  _validate_and_map_notes,
  _llm_extract,
  _llm_extract_notes,
  _extract_from_granola,
  extract_todos,
};
