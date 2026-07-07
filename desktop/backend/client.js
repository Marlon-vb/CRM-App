/* Cadence backend — CLIENT-mode data layer.
 *
 * When this Mac runs as a client (settings.isClient()), it has no local
 * book and no Telegram — it reads what a HUB Mac published to Cadence Cloud
 * and writes back only the phone-safe fields. This module is the exact
 * desktop analogue of mobile/src/lib/cloud.js's Cadence-shaped helpers:
 * same tables, same reads, same targeted writes — rendered back into the
 * dict shapes the desktop frontend already expects (so routes.js can serve
 * the same /api surface without the frontend knowing it's on cloud).
 *
 * It goes through desktop/backend/cloud.js (rest/userId) — the same authed
 * REST client the hub's publisher uses — so auth, refresh, and the stub
 * seam (cloud._fetch) all carry over. It NEVER calls the publisher: a
 * client must not push (see publisher._enabled isHub guard).
 */
const cloud = require("./cloud");

function _uid() {
  const id = cloud.userId();
  if (!id) {
    const e = new Error("Not signed in to Cadence Cloud.");
    e.status = 401;
    throw e;
  }
  return id;
}

// ── row → frontend dict (mirrors db/*.js _row_to_dict shapes) ────────

function _todo(row) {
  return {
    id: row.local_id,
    task: row.task,
    source: row.source || "manual",
    sourceRef: null,           // not published — client can't dedupe-extract
    sourceConversation: null,
    sourceSnippet: null,
    relationshipId: row.relationship_local_id ?? null,
    dueDate: row.due_date ?? null,
    priority: row.priority || "medium",
    starred: Boolean(row.starred),
    myDay: Boolean(row.my_day),
    sortOrder: row.sort_order ?? 0,
    completed: Boolean(row.completed),
    completedAt: row.completed_at ?? null,
    notes: null,               // not published
    deleted: Boolean(row.deleted),
  };
}

function _relationship(row) {
  return {
    id: row.local_id,
    name: row.name,
    company: row.company ?? null,
    contactEmails: [],
    cadenceDays: row.cadence_days ?? 14,
    archivedAt: row.archived_at ?? null,
    telegramChat: row.telegram_chat_id
      ? { group: null, contact: null, chatId: row.telegram_chat_id, lastActivity: row.last_activity ?? null }
      : null,
    createdAt: null,
    updatedAt: row.updated_at ?? null,
  };
}

// ── reads ────────────────────────────────────────────────────────────

async function listTodos(includeCompleted = true) {
  _uid();
  const q = includeCompleted
    ? "cadence_todos?deleted=eq.false&order=sort_order.asc"
    : "cadence_todos?deleted=eq.false&completed=eq.false&order=sort_order.asc";
  const rows = await cloud.rest(q);
  return (rows || []).map(_todo);
}

async function listRelationships() {
  _uid();
  const rows = await cloud.rest("cadence_relationships?select=*");
  return (rows || []).map(_relationship);
}

// The queue the hub published. payload is the full build_queue item, so the
// desktop QueueView renders context (why, bundle, last message, note
// summary) straight from it — no server-side rebuild on the client.
async function listQueue() {
  _uid();
  const rows = await cloud.rest(
    "cadence_queue_items?select=item_key,kind,urgency,payload,swept_at,generated_at&order=urgency.desc"
  );
  const items = (rows || []).map((r) => ({
    ...(r.payload || {}),
    key: r.item_key,
    kind: r.kind,
    urgency: r.urgency,
  }));
  const summary = { reply: 0, recap: 0, waiting: 0, cold: 0, healthy: 0,
                    tracked: 0, openPromisesMine: 0, openPromisesTheirs: 0 };
  for (const it of items) if (summary[it.kind] != null) summary[it.kind] += 1;
  summary.queueSize = items.length;
  summary.etaMinutes = items.reduce((s, it) => s + (it.kind === "todo" ? 2 : 3), 0);
  return {
    items,
    summary,
    sweptAt: rows && rows[0] ? rows[0].swept_at ?? null : null,
    generatedAt: rows && rows[0] ? rows[0].generated_at ?? null : null,
  };
}

// The snoozed drawer: active (non-tombstoned) snoozes with human labels
// resolved from the cloud relationships + todos (audit C7, client edition).
async function listSnoozes() {
  _uid();
  const [snoozeRows, rels, todos] = await Promise.all([
    cloud.rest("cadence_snoozes?cleared=eq.false&select=item_key,mode,until,last_inbound_at"),
    cloud.rest("cadence_relationships?select=local_id,name"),
    cloud.rest("cadence_todos?select=local_id,task"),
  ]);
  const relById = new Map((rels || []).map((r) => [r.local_id, r.name]));
  const todoById = new Map((todos || []).map((t) => [t.local_id, t.task]));
  return (snoozeRows || []).map((s) => {
    const [kind, idPart] = String(s.item_key).split(":");
    let label = s.item_key;
    if (["reply", "cold", "promise"].includes(kind)) label = relById.get(Number(idPart)) || s.item_key;
    else if (kind === "todo") label = todoById.get(Number(idPart)) || s.item_key;
    return { itemKey: s.item_key, kind, label, mode: s.mode, until: s.until ?? null };
  });
}

// ── writes (only the fields the hub's publisher pulls back) ──────────

async function patchTodo(localId, patch) {
  const uid = _uid();
  const body = {};
  if ("completed" in patch) body.completed = Boolean(patch.completed);
  if ("starred" in patch) body.starred = Boolean(patch.starred);
  if ("myDay" in patch) body.my_day = Boolean(patch.myDay);
  // completed_at keeps the hub's Completed section honest after it pulls.
  if ("completed" in patch) body.completed_at = patch.completed ? new Date().toISOString() : null;
  if (!Object.keys(body).length) return { ok: true };
  await cloud.rest(
    `cadence_todos?user_id=eq.${uid}&local_id=eq.${localId}`,
    { method: "PATCH", headers: { Prefer: "return=minimal" }, body }
  );
  return { ok: true, id: localId, ...patch };
}

async function snooze(itemKey, mode, until, lastInboundAt) {
  const uid = _uid();
  await cloud.rest("cadence_snoozes?on_conflict=user_id,item_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: {
      user_id: uid, item_key: itemKey,
      mode: mode === "after_reply" ? "after_reply" : "until",
      until: until || null, last_inbound_at: lastInboundAt || null, cleared: false,
    },
  });
  return { ok: true };
}

async function unsnooze(itemKey) {
  const uid = _uid();
  await cloud.rest("cadence_snoozes?on_conflict=user_id,item_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: { user_id: uid, item_key: itemKey, cleared: true },
  });
  return { ok: true };
}

async function resolvePromise(localId, status) {
  const uid = _uid();
  const st = ["kept", "dropped", "open"].includes(status) ? status : "kept";
  await cloud.rest(
    `cadence_promises?user_id=eq.${uid}&local_id=eq.${localId}`,
    { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { status: st } }
  );
  return { ok: true, id: localId, status: st };
}

module.exports = {
  listTodos,
  listRelationships,
  listQueue,
  listSnoozes,
  patchTodo,
  snooze,
  unsnooze,
  resolvePromise,
};
