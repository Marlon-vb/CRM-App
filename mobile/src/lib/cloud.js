/* Cadence mobile — Supabase client (direct REST, no SDK).
 *
 * The same pattern as the Mac's desktop/backend/cloud.js, which is
 * harness-tested: GoTrue password/refresh auth + PostgREST fetches with
 * apikey + bearer headers. Storage and fetch are injected so the module
 * stays pure (and the Mac's stub-testing approach carries over).
 *
 * The phone is a read/act client: it reads what the Mac publishes
 * (cadence_queue_items, cadence_todos, …) and writes ONLY the fields the
 * Mac's publisher pulls back — todo flips, snoozes, promise resolutions.
 * Everything else is the hub's business.
 */

let _storage = null; // { getItem(k), setItem(k,v), deleteItem(k) } — SecureStore on device
let _fetch = (...args) => fetch(...args);

const _KEYS = {
  config: "cadence.cloudConfig", // { url, anonKey }
  session: "cadence.session",    // { accessToken, refreshToken, expiresAt, userId, email }
};

export function init({ storage, fetchImpl } = {}) {
  if (storage) _storage = storage;
  if (fetchImpl) _fetch = fetchImpl;
}

async function _readJson(key) {
  try {
    const raw = await _storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export async function getConfig() {
  return _readJson(_KEYS.config);
}

export async function setConfig(url, anonKey) {
  const clean = String(url || "").trim().replace(/\/+$/, "");
  // Any https origin, not just *.supabase.co — self-hosted Supabase lives
  // anywhere (the audit's U4). The /auth/v1/health probe below is what
  // actually proves it's a Supabase; this only rejects http:// and garbage.
  if (!/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(clean)) {
    throw new Error("Enter the project's https:// URL (e.g. https://<ref>.supabase.co).");
  }
  const key = String(anonKey || "").trim();
  if (!key) throw new Error("The anon key is required (Supabase → Settings → API).");
  const r = await _fetch(`${clean}/auth/v1/health`, { headers: { apikey: key } });
  if (!r.ok) throw new Error(`Project responded ${r.status} — check the URL and anon key.`);
  await _storage.setItem(_KEYS.config, JSON.stringify({ url: clean, anonKey: key }));
  await _storage.deleteItem(_KEYS.session); // sessions are per-project
  return { url: clean };
}

export async function getSession() {
  return _readJson(_KEYS.session);
}

async function _persistSession(data) {
  const session = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    userId: (data.user && data.user.id) || "",
    email: (data.user && data.user.email) || "",
  };
  await _storage.setItem(_KEYS.session, JSON.stringify(session));
  return session;
}

async function _auth(pathAndQuery, body) {
  const cfg = await getConfig();
  if (!cfg) throw new Error("No project configured.");
  const r = await _fetch(`${cfg.url}/auth/v1/${pathAndQuery}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: cfg.anonKey },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data.error_description || data.msg || data.error || `auth → ${r.status}`);
  }
  return data;
}

export async function signIn(email, password) {
  const data = await _auth("token?grant_type=password", { email, password });
  if (!data.access_token) throw new Error("Sign-in did not return a session.");
  return _persistSession(data);
}

export async function signUp(email, password) {
  const data = await _auth("signup", { email, password });
  if (data.access_token) return _persistSession(data);
  return { confirmationRequired: true, email };
}

export async function signOut() {
  await _storage.deleteItem(_KEYS.session);
}

function _authError(message) {
  const e = new Error(message);
  e.code = "AUTH"; // definitive: the session is dead, re-login required
  return e;
}

// Single-flight refresh: three parallel fetches racing the same refresh
// token would brick a healthy session under GoTrue token rotation (the
// audit's C5). Everyone awaits the one in-flight refresh.
let _refreshPromise = null;

function _refresh() {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    const session = await getSession();
    if (!session) throw _authError("Not signed in.");
    let data;
    try {
      data = await _auth("token?grant_type=refresh_token", {
        refresh_token: session.refreshToken,
      });
    } catch (e) {
      // GoTrue answers 400/401 with invalid_grant for dead refresh tokens —
      // tag it so the app can route to sign-in instead of retrying forever.
      throw _authError("Session expired — sign in again.");
    }
    if (!data.access_token) throw _authError("Session expired — sign in again.");
    return _persistSession(data);
  })();
  return _refreshPromise.finally(() => { _refreshPromise = null; });
}

async function _accessToken() {
  let session = await getSession();
  if (!session) throw new Error("Not signed in.");
  if (session.expiresAt - Date.now() < 60_000) session = await _refresh();
  return session.accessToken;
}

/* PostgREST with auth + one reactive retry on token expiry. */
export async function rest(pathAndQuery, { method = "GET", body, headers = {} } = {}) {
  const cfg = await getConfig();
  if (!cfg) throw new Error("No project configured.");
  const call = async (token) =>
    _fetch(`${cfg.url}/rest/v1/${pathAndQuery}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.anonKey,
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let r = await call(await _accessToken());
  if (r.status === 401) r = await call((await _refresh()).accessToken);
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error((data && (data.message || data.msg)) || `${method} → ${r.status}`);
  }
  return data;
}

// ── Cadence-shaped helpers ──────────────────────────────────────────

export async function fetchQueue() {
  const rows = await rest(
    "cadence_queue_items?select=item_key,kind,urgency,payload,swept_at&order=urgency.desc"
  );
  return {
    items: (rows || []).map((r) => ({ ...r.payload, key: r.item_key, kind: r.kind, urgency: r.urgency })),
    sweptAt: rows && rows[0] ? rows[0].swept_at : null,
  };
}

// When did the Mac last publish ANYTHING? A genuinely empty queue has no
// queue rows to carry swept_at (the audit's false-"waiting for the Mac"),
// so we read the newest relationship row's updated_at — the publisher
// touches every relationship on every push.
export async function fetchLastPublish() {
  const rows = await rest(
    "cadence_relationships?select=updated_at&order=updated_at.desc&limit=1"
  );
  return rows && rows[0] ? rows[0].updated_at : null;
}

export async function fetchTodos() {
  return rest(
    "cadence_todos?deleted=eq.false&select=local_id,task,due_date,priority,starred,my_day,completed,relationship_local_id,sort_order&order=sort_order.asc"
  );
}

export async function fetchRelationships() {
  return rest(
    "cadence_relationships?select=local_id,name,company,cadence_days,archived_at,last_activity,telegram_chat_id"
  );
}

export async function patchTodo(localId, patch) {
  const session = await getSession();
  await rest(
    `cadence_todos?user_id=eq.${session.userId}&local_id=eq.${localId}`,
    { method: "PATCH", headers: { Prefer: "return=minimal" }, body: patch }
  );
}

export async function upsertSnooze(itemKey, mode, until, lastInboundAt) {
  const session = await getSession();
  await rest("cadence_snoozes?on_conflict=user_id,item_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: {
      user_id: session.userId,
      item_key: itemKey,
      mode,
      until: until || null,
      last_inbound_at: lastInboundAt || null,
      cleared: false,
    },
  });
}

// Phone-side unsnooze: the cleared tombstone tells the Mac to drop the
// snooze on its next pull. Powers the Undo button on snooze/handled toasts.
export async function clearSnooze(itemKey) {
  const session = await getSession();
  await rest("cadence_snoozes?on_conflict=user_id,item_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: { user_id: session.userId, item_key: itemKey, cleared: true },
  });
}

export async function resolvePromise(localId, status) {
  const session = await getSession();
  await rest(
    `cadence_promises?user_id=eq.${session.userId}&local_id=eq.${localId}`,
    { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { status } }
  );
}
