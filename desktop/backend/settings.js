/* Cadence backend — per-user settings + secrets store.
 *
 * Ported from PipeWise settings.js, trimmed to the fields Cadence uses
 * (no cloud-sync fields, no revenue target, no legacy telegram-mcp session
 * migration).
 *
 * Holds the per-install credentials so Cadence can be a self-contained app
 * with nothing hardcoded:
 *   anthropicKey, granolaKey, telegramApiId, telegramApiHash, telegramSession
 *
 * At rest these are encrypted via Electron's safeStorage (macOS Keychain) in
 * the packaged app. In dev (plain `node`, no Electron) they fall back to a
 * plaintext JSON store — clearly marked, dev-only, and gated behind
 * CADENCE_ALLOW_PLAINTEXT=1.
 *
 * On first load, empty fields are seeded once from env vars so a dev
 * environment with keys already exported keeps working without re-entering
 * anything.
 *
 * The setup endpoints (routes) write here; drafting / todos / granola /
 * telegram / followups read here instead of from env vars or hardcoded
 * config.
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");

const FIELDS = [
  "anthropicKey",
  "granolaKey",
  "telegramApiId",
  "telegramApiHash",
  "telegramSession",
  "onboarded",
  // User profile — substituted into LLM prompts so Haiku drafts, todo
  // extraction, and promise extraction speak for THIS user, not for a
  // hardcoded persona. All optional; sensible generics kick in when blank.
  "userName",
  "userCompany",
  "userRole",
  // Cloud publish (Phase 4). The five session fields move in LOCKSTEP —
  // cloud.js _persistSession is the only writer; both the proactive
  // refresh and the reactive retry depend on all five being set together
  // (the PipeWise trap). cloudUrl/cloudAnonKey override cloud-defaults.js.
  "cloudUrl",
  "cloudAnonKey",
  "cloudAccessToken",
  "cloudRefreshToken",
  "cloudExpiresAt",
  "cloudUserId",
  "cloudUserEmail",
  "cloudSyncEnabled",
];

const STORE_FILE = path.join(DATA_DIR, "cadence-settings.dat");

let _cache = null;

// Electron's safeStorage, if we're running inside Electron and it's ready.
function _safeStorage() {
  try {
    const { safeStorage } = require("electron");
    if (safeStorage && safeStorage.isEncryptionAvailable()) return safeStorage;
  } catch (e) {
    /* not running inside Electron — dev mode */
  }
  return null;
}

function _emptyStore() {
  const s = {};
  for (const f of FIELDS) s[f] = "";
  return s;
}

function _readFromDisk() {
  if (!fs.existsSync(STORE_FILE)) return _emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    let data;
    if (raw.encrypted) {
      const ss = _safeStorage();
      if (!ss) {
        // Encrypted store but no safeStorage (dev opening a packaged store) —
        // can't decrypt; treat as empty rather than crash.
        console.error("[settings] encrypted store present but not decryptable here");
        return _emptyStore();
      }
      data = JSON.parse(ss.decryptString(Buffer.from(raw.payload, "base64")));
    } else {
      data = raw.payload || {};
    }
    return { ..._emptyStore(), ...data };
  } catch (e) {
    console.error(`[settings] read failed: ${e.message}`);
    return _emptyStore();
  }
}

// Fields whose values are credential-equivalent. telegramSession alone is
// full Telegram account takeover. These must never silently hit disk
// unencrypted.
const _SECRET_FIELDS = [
  "anthropicKey",
  "granolaKey",
  "telegramApiHash",
  "telegramSession",
  "cloudAccessToken",
  "cloudRefreshToken",
];

const _hasSecrets = (data) => _SECRET_FIELDS.some((f) => data[f]);

function _writeToDisk(data) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const ss = _safeStorage();
  let raw;
  if (ss) {
    raw = {
      encrypted: true,
      payload: ss.encryptString(JSON.stringify(data)).toString("base64"),
    };
  } else {
    // No safeStorage (plain `node` run, or Keychain unavailable). Writing
    // secrets as plaintext JSON is full-credential exposure — refuse unless
    // the developer explicitly opts in for a standalone-node dev session.
    if (_hasSecrets(data) && process.env.CADENCE_ALLOW_PLAINTEXT !== "1") {
      throw new Error(
        "[settings] Refusing to write secrets unencrypted: safeStorage " +
          "(macOS Keychain) is unavailable. Run via Electron (`npm start`), " +
          "or for standalone-node dev set CADENCE_ALLOW_PLAINTEXT=1."
      );
    }
    if (_hasSecrets(data)) {
      console.warn(
        "[settings] WARNING: writing secrets as PLAINTEXT " +
          `(CADENCE_ALLOW_PLAINTEXT=1) → ${STORE_FILE}`
      );
    }
    raw = { encrypted: false, payload: data };
  }
  fs.writeFileSync(STORE_FILE, JSON.stringify(raw), "utf8");
}

// One-time seed of any empty field from env vars, so a dev environment with
// keys already exported transitions seamlessly. Returns true if anything
// was filled in.
function _migrateLegacy(data) {
  let changed = false;
  const fromEnv = {
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    granolaKey: process.env.GRANOLA_API_KEY,
    telegramApiId: process.env.TELEGRAM_API_ID,
    telegramApiHash: process.env.TELEGRAM_API_HASH,
  };
  for (const [field, val] of Object.entries(fromEnv)) {
    if (!data[field] && val) {
      data[field] = String(val);
      changed = true;
    }
  }
  return changed;
}

function _load() {
  if (_cache) return _cache;
  const data = _readFromDisk();
  if (_migrateLegacy(data)) {
    try {
      _writeToDisk(data);
    } catch (e) {
      // Plaintext write refused (or disk error) — keep the seeded values
      // in memory for this session, but persist nothing. Env vars remain
      // the source, so the next (Electron) run migrates them properly.
      console.error(`[settings] migration not persisted: ${e.message}`);
    }
  }
  _cache = data;
  return _cache;
}

// ── public API ──────────────────────────────────────────────────────

function getAll() {
  return { ..._load() };
}

function get(field) {
  return _load()[field] || "";
}

// Merge updates and persist. Unknown keys are ignored; null/undefined → "".
// Atomic vs. the plaintext guard: work on a copy so a refused/failed write
// leaves the in-memory cache untouched (no phantom values that vanish on
// restart while the route reported an error).
function set(updates) {
  const data = { ..._load() };
  for (const [k, v] of Object.entries(updates || {})) {
    if (FIELDS.includes(k)) data[k] = v == null ? "" : String(v);
  }
  _writeToDisk(data); // throws → cache unchanged
  _cache = data;
  return getAll();
}

// What's configured — drives /api/setup/status and the onboarding gate.
function status() {
  const d = _load();
  return {
    telegram: Boolean(d.telegramApiId && d.telegramApiHash && d.telegramSession),
    anthropic: Boolean(d.anthropicKey),
    granola: Boolean(d.granolaKey),
    onboarded: Boolean(d.onboarded),
    encrypted: Boolean(_safeStorage()),
    userName: d.userName || "",
    userCompany: d.userCompany || "",
    userRole: d.userRole || "",
    cloud: {
      signedIn: Boolean(d.cloudAccessToken && d.cloudRefreshToken && d.cloudUserId),
      email: d.cloudUserEmail || "",
      // Empty string defaults to ENABLED (the PipeWise trap: a legacy
      // install that signed in before this field existed must not silently
      // lose sync) — only the explicit "0" disables.
      enabled: (d.cloudSyncEnabled || "") !== "0",
    },
  };
}

const getAnthropicKey = () => get("anthropicKey");
const getGranolaKey = () => get("granolaKey");
const getTelegramApiId = () => get("telegramApiId");
const getTelegramApiHash = () => get("telegramApiHash");
const getTelegramSession = () => get("telegramSession");

// User profile, with sensible fallbacks for blank values. Used by every
// LLM prompt so the assistant addresses + impersonates THIS user.
function getUserProfile() {
  const d = _load();
  const name = (d.userName || "").trim();
  const company = (d.userCompany || "").trim();
  const role = (d.userRole || "").trim();
  // For prompt substitution:
  //   nameRef   — how to refer to the user ("Alex" or generic "the user")
  //   selfDesc  — short "{name}, {role} at {company}" or sensible fallback
  //   contextLine — full descriptor for system-prompt context
  const nameRef = name || "the user";
  const parts = [];
  if (role) parts.push(role);
  if (company) parts.push(`at ${company}`);
  const selfDesc = name
    ? `${name}${parts.length ? `, ${parts.join(" ")}` : ""}`
    : (parts.length ? `the user (${parts.join(" ")})` : "the user");
  const contextLine = name
    ? `${name}${role ? `, ${role}` : ""}${company ? ` at ${company}` : ""}`
    : (role || company)
      ? `the user${role ? ` (${role}${company ? ` at ${company}` : ""})` : ""}${company && !role ? ` at ${company}` : ""}`
      : "the user";
  return { name, company, role, nameRef, selfDesc, contextLine };
}

module.exports = {
  getAll,
  get,
  set,
  status,
  getAnthropicKey,
  getGranolaKey,
  getTelegramApiId,
  getTelegramApiHash,
  getTelegramSession,
  getUserProfile,
};
