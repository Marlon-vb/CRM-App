/* Cadence backend — Supabase auth + authed REST client (Phase 4).
 *
 * Deliberately NOT the supabase-js SDK. PipeWise learned the hard way that
 * with persistSession:false (tokens in the encrypted settings store, not
 * the SDK's storage) the SDK's refresh path (_acquireLock → _useSession →
 * __loadSession) masks real refresh results — its cloud.js already fell
 * back to direct fetch for refresh. Cadence needs exactly three things:
 * password auth, token refresh, and PostgREST calls with the right
 * headers — ~150 lines of fetch, zero dependencies, trivially stubbable.
 *
 * Session fields (cloudAccessToken/RefreshToken/ExpiresAt/UserId/UserEmail)
 * move in LOCKSTEP: _persistSession is the only writer, _clearSession the
 * only eraser. Both the proactive refresh (60s expiry buffer) and the
 * reactive 401-retry depend on all five being set together.
 */
const settings = require("./settings");
const defaults = require("./cloud-defaults");

// Small posture: everything network goes through module.exports._fetch so
// the verification harness can stub it (same seam as _anthropic_create).
async function _fetch(url, opts) {
  return fetch(url, opts);
}

function _config() {
  const url = (settings.get("cloudUrl") || "").trim() || defaults.supabaseUrl;
  const anonKey =
    (settings.get("cloudAnonKey") || "").trim() || defaults.supabaseAnonKey;
  return { url: url ? url.replace(/\/+$/, "") : null, anonKey: anonKey || null };
}

function isConfigured() {
  const { url, anonKey } = _config();
  return Boolean(url && anonKey);
}

function isSignedIn() {
  return Boolean(
    settings.get("cloudAccessToken") &&
      settings.get("cloudRefreshToken") &&
      settings.get("cloudUserId")
  );
}

function _persistSession(session) {
  // GoTrue token response: { access_token, refresh_token, expires_in,
  // user: { id, email } } — expires_at is derived so drift never depends
  // on the server including it.
  settings.set({
    cloudAccessToken: session.access_token,
    cloudRefreshToken: session.refresh_token,
    cloudExpiresAt: String(Date.now() + (Number(session.expires_in) || 3600) * 1000),
    cloudUserId: (session.user && session.user.id) || "",
    cloudUserEmail: (session.user && session.user.email) || "",
  });
}

function _clearSession() {
  settings.set({
    cloudAccessToken: "",
    cloudRefreshToken: "",
    cloudExpiresAt: "",
    cloudUserId: "",
    cloudUserEmail: "",
  });
}

function _svc(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function _authRequest(pathAndQuery, body) {
  const { url, anonKey } = _config();
  if (!url || !anonKey) throw _svc(503, "Cloud sync isn't configured.");
  const r = await module.exports._fetch(`${url}/auth/v1/${pathAndQuery}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anonKey },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg =
      data.error_description || data.msg || data.error || `auth → ${r.status}`;
    throw _svc(r.status === 400 || r.status === 401 ? 401 : r.status, msg);
  }
  return data;
}

async function signUp(email, password) {
  const data = await _authRequest("signup", { email, password });
  // Supabase may require email confirmation (no session in the response) —
  // surface that instead of pretending the user is signed in.
  if (data.access_token) {
    _persistSession(data);
    return { signedIn: true, email: data.user ? data.user.email : email };
  }
  return {
    signedIn: false,
    confirmationRequired: true,
    email,
  };
}

async function signIn(email, password) {
  const data = await _authRequest("token?grant_type=password", { email, password });
  if (!data.access_token) throw _svc(401, "Sign-in did not return a session.");
  _persistSession(data);
  return { signedIn: true, email: data.user ? data.user.email : email };
}

async function signOut() {
  _clearSession();
  return { signedIn: false };
}

// Direct-fetch refresh — the documented Supabase headless pattern.
async function refreshSession() {
  const refreshToken = settings.get("cloudRefreshToken");
  if (!refreshToken) throw _svc(401, "Not signed in to Cadence Cloud.");
  const data = await _authRequest("token?grant_type=refresh_token", {
    refresh_token: refreshToken,
  });
  if (!data.access_token) throw _svc(401, "Token refresh failed — sign in again.");
  _persistSession(data);
  return data.access_token;
}

// Access token with a proactive refresh inside a 60s expiry buffer, so
// long-idle syncs don't pay the 401-then-retry tax on every run.
async function _accessToken() {
  if (!isSignedIn()) throw _svc(401, "Not signed in to Cadence Cloud.");
  const expiresAt = Number(settings.get("cloudExpiresAt") || 0);
  if (expiresAt && expiresAt - Date.now() < 60_000) {
    return refreshSession();
  }
  return settings.get("cloudAccessToken");
}

/* PostgREST call with auth + one reactive retry on token expiry.
   pathAndQuery e.g. "cadence_todos?user_id=eq.<uid>&select=*".
   Returns parsed JSON (or null for 204). Throws with .status on errors. */
async function rest(pathAndQuery, { method = "GET", body, headers = {} } = {}) {
  const { url, anonKey } = _config();
  if (!url || !anonKey) throw _svc(503, "Cloud sync isn't configured.");

  const doCall = async (token) => {
    return module.exports._fetch(`${url}/rest/v1/${pathAndQuery}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let token = await _accessToken();
  let r = await doCall(token);
  if (r.status === 401) {
    token = await refreshSession(); // reactive retry, once
    r = await doCall(token);
  }
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg =
      (data && (data.message || data.error_description || data.msg)) ||
      `PostgREST ${method} ${pathAndQuery.split("?")[0]} → ${r.status}`;
    throw _svc(r.status, msg);
  }
  return data;
}

function userId() {
  return settings.get("cloudUserId") || null;
}

/* Validate a project URL + anon key by hitting GoTrue's public health
   endpoint. Throws with a friendly message on any failure — this is what
   stands between the user and "sign-in mysteriously network-errors"
   after pointing at a dead or mistyped project. */
async function testConfig(url, anonKey) {
  const clean = String(url || "").trim().replace(/\/+$/, "");
  const key = String(anonKey || "").trim();
  // Any well-formed https origin — hosted Supabase AND self-hosted (audit
  // U4's second half). The /auth/v1/health probe below is the real proof.
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(clean)) {
    throw _svc(400, "That doesn't look like a Supabase URL (https://<host>, no path).");
  }
  if (!key) throw _svc(400, "The anon key is required (Supabase → Settings → API).");
  let r;
  try {
    r = await module.exports._fetch(`${clean}/auth/v1/health`, {
      headers: { apikey: key },
    });
  } catch (e) {
    throw _svc(502, `Could not reach ${clean} — deleted project, typo, or no network.`);
  }
  if (!r.ok) {
    throw _svc(r.status, `Project responded ${r.status} — check the URL and anon key.`);
  }
  return { url: clean, anonKey: key };
}

/* Persist a project override (empty strings reset to the bundled
   defaults). Any change invalidates the session — tokens are per-project. */
async function setConfig(url, anonKey) {
  if (!url && !anonKey) {
    settings.set({ cloudUrl: "", cloudAnonKey: "" });
    _clearSession();
    return status();
  }
  const valid = await testConfig(url, anonKey);
  settings.set({ cloudUrl: valid.url, cloudAnonKey: valid.anonKey });
  _clearSession();
  return status();
}

/* The iPhone-setup handoff payload (audit U4): the Mac renders this as a
   QR code so the phone never types the ~200-char anon key. Contains only
   the project URL + anon key — both public-by-design (the anon key ships
   in every Supabase client app; RLS is the actual boundary). The user
   still signs in with email/password on the phone. */
function handoff() {
  const { url, anonKey } = _config();
  if (!url || !anonKey) throw _svc(503, "Cloud sync isn't configured.");
  return { cadence: 1, url, anonKey };
}

function status() {
  const { url } = _config();
  return {
    configured: isConfigured(),
    signedIn: isSignedIn(),
    email: settings.get("cloudUserEmail") || "",
    // Which project we're pointed at (host only — enough for the UI to
    // show "where", and for the user to notice a dead default).
    projectUrl: url || null,
    usingDefaults: !(settings.get("cloudUrl") || "").trim(),
  };
}

module.exports = {
  _fetch,
  isConfigured,
  isSignedIn,
  signUp,
  signIn,
  signOut,
  refreshSession,
  rest,
  userId,
  testConfig,
  setConfig,
  handoff,
  status,
};
