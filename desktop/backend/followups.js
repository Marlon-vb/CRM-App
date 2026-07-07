/* Cadence backend — follow-up engine (ported from PipeWise Phase FU).
 *
 * The core of the Queue: derives a per-relationship conversation STATE from
 * Telegram activity + Granola meeting notes + todos + extracted promises,
 * then builds a prioritized, BUNDLED work queue.
 *
 * States (each tracked relationship is in exactly one):
 *   reply    — counterparty spoke last; the user owes a response
 *   recap    — a Granola meeting happened recently and no outbound message
 *              has gone to that chat since (recap unsent)
 *   waiting  — the user spoke last; ball is in their court
 *   cold     — silence has exceeded the relationship's cadence
 *   healthy  — within cadence, nothing owed either way
 *
 * Bundling: a relationship's queue item absorbs its open todos and overdue
 * promises, so "reply to Dmitri" + "send the deck" is ONE card — one send
 * clears both.
 *
 * Data-flow note (changed from PipeWise): the BACKEND owns the Telegram
 * cache now. telegram.js sweeps on the server.js timer and routes pass
 * telegram.getLastSweep().chats into build_queue({telegramData}) — the
 * injected-data signature survives so the stubbed-db harness can feed a
 * fake cache. build_queue itself still never sweeps Telegram — queue
 * builds stay fast and rate-limit-free, and we fall back to
 * relationships.telegram_last_activity when a chat is missing.
 *
 * The Anthropic call goes through module.exports._anthropic_create (same
 * stub seam as todos.js / drafting.js) so verification can run without keys.
 */

const db = require("./db");
const settings = require("./settings");
const { HAIKU_MODEL } = require("./config");

let Anthropic = null;
let _HAS_ANTHROPIC = false;
try {
  Anthropic = require("@anthropic-ai/sdk");
  _HAS_ANTHROPIC = true;
} catch {
  _HAS_ANTHROPIC = false;
}

// Touch cadence lives on the relationship row now (cadence_days, default
// 14) — the PipeWise stage-based defaults and followup_cadences table died
// with the deal model. set_cadence() below is the write path routes use.

// A Granola meeting counts as "recap due" for this long after it happens.
const _RECAP_WINDOW_HOURS = 72;
// 'after_reply' snoozes resurface unconditionally after this failsafe.
const _AFTER_REPLY_FAILSAFE_DAYS = 7;
// A promise this old (no due hint) counts as overdue.
const _PROMISE_OVERDUE_DAYS = 3;

function _svc503(message) {
  const e = new Error(message);
  e.status = 503;
  return e;
}

async function _anthropic_create(params) {
  if (!_HAS_ANTHROPIC) {
    throw _svc503("anthropic SDK not installed — run `npm install` in the desktop/ folder.");
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

// ── small helpers ───────────────────────────────────────────────────

const _HOUR = 3600 * 1000;
const _DAY = 24 * _HOUR;

function _ts(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function _hoursSince(iso, now) {
  const t = _ts(iso);
  return t === null ? null : Math.max(0, (now - t) / _HOUR);
}

// Human-scale age for why-lines: hours under a day, days after ("994h
// ago" reads as line noise; "41d ago" reads as a relationship state).
function _agoLabel(hours) {
  const h = Math.round(hours);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Is this snooze still active (i.e. should the item stay hidden)?
function _snooze_active(snooze, lastInboundISO, now) {
  if (!snooze) return false;
  if (snooze.mode === "until") {
    const u = _ts(snooze.until);
    return u !== null && u > now;
  }
  // after_reply: hidden while nothing NEW has arrived since the snapshot…
  const failsafe = _ts(snooze.createdAt);
  if (failsafe !== null && now - failsafe > _AFTER_REPLY_FAILSAFE_DAYS * _DAY) {
    return false; // …but never longer than the failsafe window.
  }
  const snap = _ts(snooze.lastInboundAt);
  const last = _ts(lastInboundISO);
  if (last === null) return true;       // still silent → stay hidden
  if (snap === null) return false;      // no snapshot → be safe, resurface
  return last <= snap;                  // resurface once something new lands
}

// ── cadence write path ──────────────────────────────────────────────

// Per-relationship touch cadence. Clamps into the 1–365 range the
// cadence_days CHECK enforces, then persists via update_relationship.
function set_cadence(relationshipId, days) {
  const n = Number(days);
  if (!Number.isFinite(n)) {
    const e = new Error("days must be a number between 1 and 365");
    e.status = 400;
    throw e;
  }
  const d = Math.min(365, Math.max(1, Math.round(n)));
  const rel = db.update_relationship(relationshipId, { cadenceDays: d });
  if (!rel) {
    const e = new Error("Relationship not found");
    e.status = 404;
    throw e;
  }
  return { relationshipId: rel.id, days: rel.cadenceDays };
}

// ── queue builder ───────────────────────────────────────────────────

/**
 * Build the follow-up queue.
 * @param {object} opts
 * @param {object} opts.telegramData  backend sweep cache:
 *   { [groupName]: chatResult } where chatResult = { matched, messages[],
 *   last_message, waiting_on, … } — routes pass telegram.getLastSweep().chats.
 * @returns {{ items: object[], summary: object, generatedAt: string }}
 */
function build_queue({ telegramData = {} } = {}) {
  const now = Date.now();
  const relationships = db.list_relationships();
  const snoozes = db.list_fu_snoozes();
  const promises = db.list_fu_promises(null, "open");
  const sqlDb = db.getDb();

  const openTodos = sqlDb
    .prepare("SELECT * FROM todos WHERE completed = 0 AND deleted = 0")
    .all()
    .map(db._todo_row_to_dict);

  const recentNotes = sqlDb
    .prepare(
      `SELECT * FROM notes
       WHERE meeting_date IS NOT NULL AND meeting_date >= ?
       ORDER BY meeting_date DESC`
    )
    .all(new Date(now - _RECAP_WINDOW_HOURS * _HOUR).toISOString())
    .map(db._note_row_to_dict);

  const promisesByRelationship = {};
  for (const p of promises) {
    if (p.relationshipId == null) continue;
    (promisesByRelationship[p.relationshipId] ||= []).push(p);
  }
  const todosByRelationship = {};
  const standaloneTodos = [];
  for (const t of openTodos) {
    if (t.relationshipId != null) (todosByRelationship[t.relationshipId] ||= []).push(t);
    else standaloneTodos.push(t);
  }
  const notesByRelationship = {};
  for (const n of recentNotes) {
    if (n.relationshipId != null) (notesByRelationship[n.relationshipId] ||= []).push(n);
  }

  const items = [];
  const summary = { reply: 0, recap: 0, waiting: 0, cold: 0, healthy: 0,
                    tracked: 0, openPromisesMine: 0, openPromisesTheirs: 0 };

  for (const p of promises) {
    if (p.direction === "mine") summary.openPromisesMine += 1;
    else summary.openPromisesTheirs += 1;
  }

  for (const relationship of relationships) {
    if (relationship.archivedAt) continue;           // archived — skip
    // Bind by primary group name, falling back to the rel:<id> cache key —
    // the fallback is what makes DM-only clients (no primary binding, chats
    // attached via relationship_chats) visible to reply/cold detection at
    // all (audit M3). The sweep writes both keys for every tracked client.
    const group = relationship.telegramChat ? relationship.telegramChat.group : null;
    const tg =
      (group ? telegramData[group] : null) ||
      telegramData[`rel:${relationship.id}`] ||
      null;
    summary.tracked += 1;

    const lastMsg = tg && tg.matched ? tg.last_message : null;
    const lastActivityISO =
      (lastMsg && lastMsg.date) ||
      (relationship.telegramChat && relationship.telegramChat.lastActivity) ||
      null;
    const lastInboundISO = lastMsg && !lastMsg.is_me ? lastMsg.date : null;
    const cadenceDays = relationship.cadenceDays ?? 14;
    // Never-contacted clients used to be permanently "healthy" (audit M9) —
    // a tracked client with zero recorded activity goes cold measured from
    // when it was added, so the relaunch radar covers the whole book.
    const neverContacted = lastActivityISO === null;
    const silentSinceISO = lastActivityISO || relationship.createdAt || null;
    const hoursSilent = _hoursSince(silentSinceISO, now);
    const daysSilent = hoursSilent === null ? null : hoursSilent / 24;

    const relTodos = todosByRelationship[relationship.id] || [];
    const relPromises = promisesByRelationship[relationship.id] || [];
    const overduePromises = relPromises.filter(
      (p) =>
        p.direction === "mine" &&
        _hoursSince(p.promisedAt || p.createdAt, now) > _PROMISE_OVERDUE_DAYS * 24
    );

    const bundle = [
      ...relTodos.map((t) => ({ type: "todo", id: t.id, label: t.task, dueDate: t.dueDate ?? t.due_date ?? null })),
      ...overduePromises.map((p) => ({ type: "promise", id: p.id, label: p.text, dueHint: p.dueHint })),
    ];

    const base = {
      relationshipId: relationship.id,
      relationshipName: relationship.name,
      company: relationship.company,
      group,
      contact: relationship.telegramChat ? relationship.telegramChat.contact || null : null,
      cadenceDays,
      daysSilent: daysSilent === null ? null : Math.round(daysSilent * 10) / 10,
      lastActivity: lastActivityISO,
      waitingOn: tg && tg.matched ? tg.waiting_on : "unknown",
      messages: tg && tg.matched ? (tg.messages || []).slice(0, 5) : [],
      // One-line "what was last discussed" from telegram.js's summary
      // generator — gives cold/promise cards context without an LLM call.
      actionSummary: tg && tg.matched ? tg.action_summary || null : null,
      // Multi-chat: WHICH of the relationship's chats spoke last (the sweep
      // aggregate's active chat) — drafts and sends target it, so a reply
      // owed in a DM goes back to that DM, not the group room.
      activeChatId: tg && tg.matched ? tg.activeChatId ?? tg.chat_id ?? null : null,
      activeChatName: tg && tg.matched ? tg.activeChatName ?? tg.chat_name ?? null : null,
      chatCount: tg && tg.matched ? tg.chatCount ?? 1 : 0,
      bundle,
    };

    // 1) Recap due — meeting note newer than the last outbound message.
    const relNotes = notesByRelationship[relationship.id] || [];
    let recapNote = null;
    for (const n of relNotes) {
      const meetTs = _ts(n.meetingDate);
      if (meetTs === null) continue;
      const outboundAfter = (base.messages || []).some(
        (m) => m.is_me && _ts(m.date) !== null && _ts(m.date) > meetTs
      );
      if (!outboundAfter) { recapNote = n; break; }
    }
    if (recapNote) {
      const key = `recap:${recapNote.id}`;
      const hoursSinceMeet = _hoursSince(recapNote.meetingDate, now) ?? 0;
      summary.recap += 1;
      if (!_snooze_active(snoozes[key], lastInboundISO, now)) {
        items.push({
          ...base, key, kind: "recap",
          noteId: recapNote.id,
          noteTitle: recapNote.title,
          noteSummary: (recapNote.summary || "").slice(0, 2000),
          meetingDate: recapNote.meetingDate,
          why: `Meeting "${recapNote.title}" ${_agoLabel(hoursSinceMeet)} — recap not sent`,
          urgency: 90 + Math.min(40, hoursSinceMeet),
        });
      }
      continue; // recap outranks other states for this relationship
    }

    // 2) Reply owed.
    if (base.waitingOn === "me") {
      const key = `reply:${relationship.id}`;
      const hoursOwed = _hoursSince(lastMsg ? lastMsg.date : null, now) ?? 0;
      summary.reply += 1;
      if (!_snooze_active(snoozes[key], lastInboundISO, now)) {
        items.push({
          ...base, key, kind: "reply",
          lastInbound: lastMsg ? { text: (lastMsg.text || "").slice(0, 500), date: lastMsg.date, sender: lastMsg.sender || null } : null,
          why: `${(lastMsg && lastMsg.sender) || "They"} wrote ${_agoLabel(hoursOwed)} — you haven't replied`,
          urgency: 100 + Math.min(60, hoursOwed),
        });
      }
      continue;
    }

    // 3) Cold — silence beyond cadence (applies when waiting on them too:
    //    a dead "their turn" still needs a nudge once cadence blows).
    if (daysSilent !== null && daysSilent > cadenceDays) {
      const key = `cold:${relationship.id}`;
      summary.cold += 1;
      if (!_snooze_active(snoozes[key], lastInboundISO, now)) {
        items.push({
          ...base, key, kind: "cold",
          why: neverContacted
            ? `No contact recorded — added ${Math.round(daysSilent)}d ago, initiate outreach`
            : `${Math.round(daysSilent)}d silent — cadence is ${cadenceDays}d`,
          urgency: 40 + Math.min(30, daysSilent - cadenceDays),
        });
      }
      continue;
    }

    // 4) Within cadence: waiting on them, or healthy. A healthy relationship
    //    with overdue bundle items (promise/todo) still surfaces — promises
    //    kept is the whole point.
    if (base.waitingOn === "them") summary.waiting += 1;
    else summary.healthy += 1;

    if (overduePromises.length > 0) {
      const key = `promise:${relationship.id}`;
      if (!_snooze_active(snoozes[key], lastInboundISO, now)) {
        items.push({
          ...base, key, kind: "promise",
          why: `You promised: "${overduePromises[0].text}" — ${Math.round(_hoursSince(overduePromises[0].promisedAt || overduePromises[0].createdAt, now) / 24)}d ago, still open`,
          urgency: 80,
        });
      }
    }
  }

  // 5) Standalone todos due today or overdue (no relationship attached).
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  for (const t of standaloneTodos) {
    const due = t.dueDate ?? t.due_date ?? null;
    if (!due) continue;
    const dueTs = _ts(due) ?? _ts(due + "T23:59:59");
    if (dueTs === null || dueTs > todayEnd.getTime()) continue;
    const key = `todo:${t.id}`;
    if (_snooze_active(snoozes[key], null, now)) continue;
    const overdueDays = Math.max(0, (now - dueTs) / _DAY);
    items.push({
      key, kind: "todo",
      todoId: t.id,
      relationshipId: null, relationshipName: null, company: null,
      group: null, contact: null, bundle: [],
      title: t.task,
      notes: t.notes || null,
      dueDate: due,
      priority: t.priority || "medium",
      source: t.source || "manual",
      why: overdueDays >= 1 ? `Overdue ${Math.round(overdueDays)}d` : "Due today",
      urgency: 60 + Math.min(25, overdueDays * 5),
    });
  }

  items.sort((a, b) => b.urgency - a.urgency);

  // Time-to-clear estimate: sends ≈3 min, todos ≈2 min.
  const etaMinutes = items.reduce(
    (s, it) => s + (it.kind === "todo" ? 2 : 3), 0
  );

  return {
    items,
    summary: { ...summary, queueSize: items.length, etaMinutes },
    generatedAt: new Date().toISOString(),
  };
}

// ── promise extraction (LLM) ────────────────────────────────────────

// Deep-feed knobs (audit M7): extraction used to see only the sweep
// aggregate's ~8 newest messages of each relationship's most recent chat —
// commitments in active groups scrolled past unseen. It now pulls real
// history via telegram._fetch_recent_conversations: every linked chat
// (groups AND DMs, each its own conversation), capped per chat, two weeks
// back. The 12h throttle in server.js still bounds LLM spend.
const _PROMISE_LOOKBACK_DAYS = 14;
const _PROMISE_MSGS_PER_CHAT = 25;
const _PROMISE_MAX_CHATS = 60;

const _PROMISE_TOOL = {
  name: "record_promises",
  description: "Record commitments made in the conversations.",
  input_schema: {
    type: "object",
    properties: {
      promises: {
        type: "array",
        items: {
          type: "object",
          properties: {
            conversation_index: { type: "integer" },
            direction: { type: "string", enum: ["mine", "theirs"] },
            text: { type: "string", description: "The commitment, short imperative form, max 120 chars" },
            due_hint: { type: "string", description: "Verbatim timing words if any, e.g. 'by Monday', 'this week'" },
          },
          required: ["conversation_index", "direction", "text"],
        },
      },
    },
    required: ["promises"],
  },
};

function _build_promise_system_prompt(profile) {
  return (
    `You extract concrete COMMITMENTS from business chat conversations.\n` +
    `The user is ${profile.contextLine}. Messages marked is_me=true are theirs.\n` +
    `A commitment is a specific deliverable someone said they would do:\n` +
    `"I'll send the deck", "we'll get you redlines this week", "I'll intro you to X".\n` +
    `direction "mine" = the user committed; "theirs" = the counterparty did.\n` +
    `Skip: vague intentions ("let's catch up soon"), questions, completed items,\n` +
    `scheduling chatter, and anything already delivered later in the conversation.\n` +
    `Max 5 promises per conversation. Empty list is a fine answer.`
  );
}

async function extract_promises(telegramData = {}, conversations = null) {
  const relById = new Map();
  for (const r of db.list_relationships()) {
    if (!r.archivedAt) relById.set(r.id, r);
  }

  // Deep feed (audit M7): real per-chat history, every linked chat tagged
  // with its relationship. Lazy require keeps the stubbed-db test harness
  // (which injects `conversations`) from ever loading GramJS.
  if (conversations === null) {
    try {
      const telegram = require("./telegram");
      conversations = await telegram._fetch_recent_conversations(
        _PROMISE_LOOKBACK_DAYS, _PROMISE_MSGS_PER_CHAT, _PROMISE_MAX_CHATS
      );
    } catch {
      conversations = null; // Telegram unreachable — sweep-cache fallback below
    }
  }

  // Both feeds keep messages newest-first (messages[0] = latest), matching
  // the sweep cache convention — sourceRef/promisedAt read messages[0].
  const convos = [];
  const pushConvo = (relationship, chatName, messages) => {
    const msgs = (messages || []).slice(0, _PROMISE_MSGS_PER_CHAT).map((m) => ({
      is_me: Boolean(m.is_me),
      sender: m.sender || (m.is_me ? "me" : "them"),
      date: m.date || null,
      text: (m.text || "").slice(0, 400),
    }));
    if (!msgs.some((m) => m.text.trim())) return;
    convos.push({
      relationshipId: relationship.id,
      relationshipName: relationship.name,
      chatName: chatName || null,
      messages: msgs,
    });
  };

  if (conversations && conversations.length) {
    for (const c of conversations) {
      if (c.relationship_id == null) continue; // untracked dialogs feed todos, not promises
      const rel = relById.get(c.relationship_id);
      if (!rel) continue;
      pushConvo(rel, c.chat_name, c.messages);
    }
  } else {
    // Sweep-cache fallback — shallow (the ~8-message aggregate) but better
    // than skipping the cycle. Same group-name → rel:<id> binding as
    // build_queue so DM-only clients are scanned too (audit M3).
    for (const relationship of relById.values()) {
      const group = relationship.telegramChat ? relationship.telegramChat.group : null;
      const tg =
        (group ? telegramData[group] : null) ||
        telegramData[`rel:${relationship.id}`] ||
        null;
      if (!tg || !tg.matched || !(tg.messages || []).length) continue;
      pushConvo(relationship, tg.activeChatName || group, tg.messages.slice(0, 8));
    }
  }
  if (!convos.length) return { inserted: 0, scanned: 0 };

  const profile = settings.getUserProfile();
  const payload = convos.map((c, i) =>
    `[conversation ${i}] relationship: ${c.relationshipName}` +
    (c.chatName && c.chatName !== c.relationshipName ? ` — chat: ${c.chatName}` : "") + "\n" +
    c.messages
      .slice()
      .reverse()
      .map((m) => `  ${m.is_me ? profile.nameRef + " (is_me=true)" : m.sender}: ${m.text}`)
      .join("\n")
  ).join("\n\n");

  const resp = await module.exports._anthropic_create({
    model: HAIKU_MODEL,
    max_tokens: 4000,
    system: _build_promise_system_prompt(profile),
    tools: [_PROMISE_TOOL],
    tool_choice: { type: "tool", name: "record_promises" },
    messages: [{ role: "user", content: payload }],
  });

  let raw = [];
  for (const block of resp.content || []) {
    if (block.type === "tool_use" && block.name === "record_promises") {
      raw = (block.input || {}).promises || [];
    }
  }

  const mapped = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const ci = p.conversation_index;
    if (!Number.isInteger(ci) || ci < 0 || ci >= convos.length) continue;
    const convo = convos[ci];
    const newest = convo.messages[0];
    mapped.push({
      relationshipId: convo.relationshipId,
      direction: p.direction === "theirs" ? "theirs" : "mine",
      text: (p.text || "").trim(),
      source: "telegram",
      sourceRef: newest ? newest.date : null,
      promisedAt: newest ? newest.date : null,
      dueHint: (p.due_hint || "").trim() || null,
    });
  }
  const { inserted } = db.upsert_fu_promises(mapped);
  return { inserted, scanned: convos.length };
}

// ── recap drafting (LLM) ────────────────────────────────────────────

async function draft_recap(noteId) {
  const sqlDb = db.getDb();
  const noteRow = sqlDb.prepare("SELECT * FROM notes WHERE id = ?").get(noteId);
  if (!noteRow) {
    const e = new Error("Note not found");
    e.status = 404;
    throw e;
  }
  const note = db._note_row_to_dict(noteRow);
  let relationship = null;
  if (note.relationshipId != null) {
    const rr = sqlDb
      .prepare("SELECT * FROM relationships WHERE id = ?")
      .get(note.relationshipId);
    if (rr) relationship = db._relationship_row_to_dict(rr);
  }

  // Reuse the voice-aware system prompt from drafting.js so recaps sound
  // like the user's Telegram register, not like meeting minutes.
  const drafting = require("./drafting");
  const profile = settings.getUserProfile();

  const user_prompt =
    (relationship
      ? `Relationship: ${relationship.name}${relationship.company ? ` (${relationship.company})` : ""}\n`
      : "") +
    `Meeting: ${note.title}\nDate: ${note.meetingDate || "recently"}\n\n` +
    `Granola meeting notes (markdown):\n${(note.summary || "").slice(0, 3500)}\n\n` +
    `Write the short recap message ${profile.nameRef} should send to the ` +
    `counterparty's Telegram group: what was agreed, who does what next, ` +
    `and any dates. Group register ("Hi Team" style opener). Keep it tight — ` +
    `under 120 words, no bullet-point walls, no formal sign-off.`;

  const resp = await module.exports._anthropic_create({
    model: HAIKU_MODEL,
    max_tokens: 400,
    system: drafting._build_draft_system_prompt(),
    messages: [{ role: "user", content: user_prompt }],
  });

  const parts = [];
  for (const block of resp.content || []) {
    if (block.type === "text") parts.push(block.text);
  }
  let draft = parts.join("\n").trim();
  if (draft.startsWith('"') && draft.endsWith('"') && (draft.match(/"/g) || []).length === 2) {
    draft = draft.slice(1, -1).trim();
  }
  return { draft, noteId, relationshipId: note.relationshipId };
}

module.exports = {
  _HAS_ANTHROPIC,
  _anthropic_create,
  _snooze_active,
  set_cadence,
  build_queue,
  extract_promises,
  draft_recap,
};
