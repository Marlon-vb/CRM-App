/* Cadence backend — cloud publisher (Phase 4, Mac-as-hub).
 *
 * The Mac is the single compute hub: it owns Telegram, extraction, and the
 * queue build. This module keeps Supabase's cadence_ tables mirroring that
 * state so the iPhone app can read/act, and applies the phone's actions
 * back. One sync cycle = PULL (absorb phone edits: todo flips, snoozes,
 * promise resolutions) then PUSH (fresh relationships/todos/promises, the
 * recomputed queue, and the authoritative snooze set).
 *
 * Ordering does the conflict resolution: phone edits land locally BEFORE
 * the queue rebuild, so what gets pushed already reflects them. Row-level
 * ties fall to last-write-wins on updated_at (normalized to ISO — SQLite's
 * "YYYY-MM-DD HH:MM:SS" is UTC but JS would parse it as local time).
 *
 * Cursor semantics: _meta.cloud_pull_cursor advances only from PULLED
 * rows' updated_at. Our own pushes touch every row, so the cycle after a
 * push re-pulls them and no-ops — cheap at this scale, and it can never
 * skip a phone edit that raced the push.
 *
 * Failures set _lastError and never stop the loop — the Settings UI reads
 * status() and shows "last sync failed" without breaking sync forever.
 */
const cloud = require("./cloud");
const db = require("./db");
const settings = require("./settings");
const telegram = require("./telegram");
const followups = require("./followups");

const PUBLISH_DEBOUNCE_MS = 1500;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const _CURSOR_KEY = "cloud_pull_cursor";

let _inFlight = false;
let _debounceTimer = null;
let _intervalTimer = null;
let _lastError = null;
let _lastSyncAt = null;

// SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) → ISO. ISO input
// passes through. null stays null.
function _toIso(ts) {
  if (!ts) return null;
  const s = String(ts);
  if (s.includes("T")) return s;
  return s.replace(" ", "T") + "Z";
}

function _newer(aIso, bIso) {
  const a = aIso ? Date.parse(aIso) : NaN;
  const b = bIso ? Date.parse(bIso) : NaN;
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(b)) return true;
  return a > b;
}

function _enabled() {
  // isHub() is the load-bearing guard: a CLIENT install must NEVER push —
  // its local db is empty/foreign, and the push deletes cloud rows it
  // doesn't recognize, which would wipe the real hub's published data.
  // Defense-in-depth: server.js also never starts the interval in client
  // mode, but gating here means even a stray publishSoon() call no-ops.
  return settings.isHub() && settings.status().cloud.enabled &&
    cloud.isSignedIn() && cloud.isConfigured();
}

// ── PULL: apply the phone's actions locally ─────────────────────────

async function _pull(uid) {
  const cursor = db._meta_get(_CURSOR_KEY) || "1970-01-01T00:00:00Z";
  let maxSeen = cursor;
  const bump = (ts) => {
    if (ts && Date.parse(ts) > Date.parse(maxSeen)) maxSeen = ts;
  };

  // Todos: the phone edits completed / starred / my_day (never creates —
  // hub-keyed local_ids make the Mac the only minter in Phase 4).
  const todos = await cloud.rest(
    `cadence_todos?user_id=eq.${uid}&updated_at=gt.${encodeURIComponent(cursor)}` +
      `&select=local_id,completed,starred,my_day,updated_at`
  );
  const localTodos = new Map(db.list_todos(true, 36500).map((t) => [t.id, t]));
  for (const row of todos || []) {
    bump(row.updated_at);
    const local = localTodos.get(row.local_id);
    if (!local) continue;
    if (!_newer(row.updated_at, _toIso(local.updatedAt))) continue;
    const patch = {};
    if (Boolean(row.completed) !== Boolean(local.completed)) patch.completed = Boolean(row.completed);
    if (Boolean(row.starred) !== Boolean(local.starred)) patch.starred = Boolean(row.starred);
    if (Boolean(row.my_day) !== Boolean(local.myDay)) patch.myDay = Boolean(row.my_day);
    if (Object.keys(patch).length) {
      try {
        db.update_todo(row.local_id, patch);
        console.log(`[cloud] applied phone todo edit #${row.local_id}`);
      } catch (e) {
        console.log(`[cloud] todo apply failed #${row.local_id}: ${e.message}`);
      }
    }
  }

  // Snoozes: phone snoozes/unsnoozes queue items. cleared=true is the
  // unsnooze tombstone. Rows identical to local state are SKIPPED — our
  // own pushes touch updated_at, and blindly re-applying them every cycle
  // is what used to churn snooze rows (and, before set_snooze preserved
  // created_at, silently disabled the after-reply failsafe — audit M1/M8).
  const localSnoozes = db.list_fu_snoozes();
  const snoozes = await cloud.rest(
    `cadence_snoozes?user_id=eq.${uid}&updated_at=gt.${encodeURIComponent(cursor)}` +
      `&select=item_key,mode,until,last_inbound_at,cleared,updated_at`
  );
  for (const row of snoozes || []) {
    bump(row.updated_at);
    try {
      const local = localSnoozes[row.item_key];
      if (row.cleared) {
        if (local) db.clear_fu_snooze(row.item_key);
      } else if (
        !local ||
        local.mode !== (row.mode || "until") ||
        (local.until ?? null) !== (row.until ?? null) ||
        (local.lastInboundAt ?? null) !== (row.last_inbound_at ?? null)
      ) {
        db.set_fu_snooze(row.item_key, row.mode || "until", row.until, row.last_inbound_at);
      }
    } catch (e) {
      console.log(`[cloud] snooze apply failed ${row.item_key}: ${e.message}`);
    }
  }

  // Promises: the phone resolves kept/dropped.
  const promises = await cloud.rest(
    `cadence_promises?user_id=eq.${uid}&updated_at=gt.${encodeURIComponent(cursor)}` +
      `&select=local_id,status,updated_at`
  );
  const localPromises = new Map(db.list_fu_promises(null, "all").map((p) => [p.id, p]));
  for (const row of promises || []) {
    bump(row.updated_at);
    const local = localPromises.get(row.local_id);
    if (!local || local.status === row.status) continue;
    if (!_newer(row.updated_at, _toIso(local.updatedAt))) continue;
    try {
      db.resolve_fu_promise(row.local_id, row.status);
      console.log(`[cloud] applied phone promise ${row.status} #${row.local_id}`);
    } catch (e) {
      console.log(`[cloud] promise apply failed #${row.local_id}: ${e.message}`);
    }
  }

  db._meta_set(_CURSOR_KEY, maxSeen);
}

// ── PUSH: mirror the hub's state ────────────────────────────────────

const _UPSERT_HEADERS = {
  Prefer: "resolution=merge-duplicates,return=minimal",
};

async function _upsert(table, conflictCols, rows) {
  if (!rows.length) return;
  await cloud.rest(`${table}?on_conflict=${conflictCols}`, {
    method: "POST",
    headers: _UPSERT_HEADERS,
    body: rows,
  });
}

async function _push(uid) {
  // Relationships — display + deep-link data for the phone.
  const rels = db.list_relationships(true);
  await _upsert("cadence_relationships", "user_id,local_id", rels.map((r) => ({
    user_id: uid,
    local_id: r.id,
    name: r.name,
    company: r.company,
    cadence_days: r.cadenceDays,
    archived_at: r.archivedAt,
    last_activity:
      [r.telegramChat && r.telegramChat.lastActivity, ...(r.chats || []).map((c) => c.lastActivity)]
        .filter(Boolean).sort().pop() || null,
    telegram_chat_id: r.telegramChat ? r.telegramChat.chatId : null,
  })));

  // Todos — everything incl. completed AND soft-deleted rows (raw query;
  // list_todos hides tombstones, but the phone needs deleted=true to drop
  // a todo the Mac removed — otherwise ghosts linger cloud-side forever).
  const todoRows = db.getDb().prepare("SELECT * FROM todos").all();
  await _upsert("cadence_todos", "user_id,local_id", todoRows.map((t) => ({
    user_id: uid,
    local_id: t.id,
    task: t.task,
    relationship_local_id: t.relationship_id,
    source: t.source,
    due_date: t.due_date,
    priority: t.priority,
    starred: Boolean(t.starred),
    my_day: Boolean(t.my_day),
    completed: Boolean(t.completed),
    completed_at: t.completed_at,
    deleted: Boolean(t.deleted),
    sort_order: t.sort_order,
  })));

  // Promises.
  const promises = db.list_fu_promises(null, "all");
  await _upsert("cadence_promises", "user_id,local_id", promises.map((p) => ({
    user_id: uid,
    local_id: p.id,
    relationship_local_id: p.relationshipId,
    direction: p.direction,
    text: p.text,
    due_hint: p.dueHint,
    promised_at: p.promisedAt,
    status: p.status,
    resolved_at: p.resolvedAt,
  })));

  // ── clobber-window guard (audit M2) ──
  // A phone action written between this cycle's PULL and here would be
  // overwritten by the destructive steps below (snooze tombstoning, queue
  // deletion). Re-pull right before them: the cursor makes it nearly free
  // when nothing happened, and absorbs anything that raced the push.
  await _pull(uid);

  // Snoozes — authoritative local set (pull already absorbed the phone's);
  // anything cloud-side not in it gets the cleared tombstone.
  const snoozes = db.list_fu_snoozes();
  const snoozeKeys = Object.keys(snoozes);
  await _upsert("cadence_snoozes", "user_id,item_key", snoozeKeys.map((key) => ({
    user_id: uid,
    item_key: key,
    mode: snoozes[key].mode,
    until: snoozes[key].until,
    last_inbound_at: snoozes[key].lastInboundAt,
    cleared: false,
  })));
  const keyList = snoozeKeys.map((k) => `"${k.replace(/"/g, '')}"`).join(",");
  await cloud.rest(
    `cadence_snoozes?user_id=eq.${uid}&cleared=eq.false` +
      (snoozeKeys.length ? `&item_key=not.in.(${encodeURIComponent(keyList)})` : ""),
    { method: "PATCH", headers: _UPSERT_HEADERS, body: { cleared: true } }
  );

  // The computed queue — rebuilt fresh so it reflects everything above.
  const queue = followups.build_queue({
    telegramData: telegram.getLastSweep().chats || {},
  });
  const sweptAt = telegram.getLastSweep().sweptAt || null;
  await _upsert("cadence_queue_items", "user_id,item_key", queue.items.map((item) => ({
    user_id: uid,
    item_key: item.key,
    kind: item.kind,
    urgency: item.urgency,
    relationship_local_id: item.relationshipId ?? null,
    payload: item,
    swept_at: sweptAt,
    generated_at: queue.generatedAt,
  })));
  const itemKeys = queue.items.map((i) => `"${i.key.replace(/"/g, '')}"`).join(",");
  await cloud.rest(
    `cadence_queue_items?user_id=eq.${uid}` +
      (queue.items.length ? `&item_key=not.in.(${encodeURIComponent(itemKeys)})` : ""),
    { method: "DELETE", headers: { Prefer: "return=minimal" } }
  );

  return { queueSize: queue.items.length, todos: todoRows.length, relationships: rels.length };
}

// ── the cycle ───────────────────────────────────────────────────────

async function syncNow(reason = "manual") {
  if (!_enabled()) return { skipped: true };
  if (_inFlight) return { alreadyRunning: true };
  _inFlight = true;
  try {
    const uid = cloud.userId();
    await _pull(uid);
    const pushed = await _push(uid);
    _lastError = null;
    _lastSyncAt = new Date().toISOString();
    console.log(
      `[cloud] ${reason} sync — ${pushed.queueSize} queue item(s), ` +
        `${pushed.todos} todo row(s), ${pushed.relationships} client(s)`
    );
    return { ok: true, ...pushed };
  } catch (e) {
    // A definitive auth failure (refresh token dead) will fail identically
    // forever — clear the session so status() flips to signed-out and the
    // Settings UI shows "sign in again" instead of a groundhog-day error.
    if (e.status === 401) {
      try { await cloud.signOut(); } catch (e2) { /* best-effort */ }
      _lastError = "Session expired — sign in again in Settings → Cadence Cloud.";
    } else {
      _lastError = e.message;
    }
    console.error(`[cloud] ${reason} sync failed: ${e.message}`);
    return { ok: false, error: _lastError };
  } finally {
    _inFlight = false;
  }
}

// Debounced publish — mutation routes and the sweep cycle call this; a
// burst of edits costs one sync.
function publishSoon() {
  if (!_enabled()) return;
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    syncNow("debounced").catch(() => {});
  }, PUBLISH_DEBOUNCE_MS);
  if (_debounceTimer.unref) _debounceTimer.unref();
}

// Steady-state interval — pulls phone edits even when the Mac is idle.
// Re-checks enablement every tick, so Settings toggles apply live.
function startInterval() {
  if (_intervalTimer) return;
  _intervalTimer = setInterval(() => {
    syncNow("interval").catch(() => {});
  }, SYNC_INTERVAL_MS);
  if (_intervalTimer.unref) _intervalTimer.unref();
}

function stopInterval() {
  clearInterval(_intervalTimer);
  _intervalTimer = null;
  clearTimeout(_debounceTimer);
  _debounceTimer = null;
}

function status() {
  return {
    ...cloud.status(),
    enabled: settings.status().cloud.enabled,
    inFlight: _inFlight,
    lastSyncAt: _lastSyncAt,
    lastError: _lastError,
  };
}

module.exports = {
  syncNow,
  publishSoon,
  startInterval,
  stopInterval,
  status,
};
