/* Cadence backend — Telegram integration + Telegram-side smart logic.
 *
 * Ported from PipeWise telegram.js (GramJS — the `telegram` npm package),
 * minus every pipeline side effect: no stage auto-moves, no single-threaded
 * contact analysis. What remains is the rhythm-keeper core.
 *
 * Owns:
 *  - the GramJS client + connection management + in-app login flow
 *  - sweep(): the backend-owned chat sweep — walks tracked relationships'
 *    chats (waiting_on, last-activity write-back, regex action summaries),
 *    then scans unknown dialogs for new-conversation suggestions
 *  - the last-sweep cache (in-memory + persisted to disk for warm starts;
 *    queue builds and the iPhone phase both read from it)
 *  - single-chat fetch (draft-reply context), message send, and the
 *    recent-conversations feed for todo extraction
 *
 * Port notes (kept from PipeWise):
 *  - GramJS is lazy-require()d inside connect() — so this module loads (and
 *    its pure functions stay testable) even before `npm install` pulls GramJS.
 *  - GramJS message.date is a unix-seconds integer; message text is
 *    `.message`; ids are big-integers → converted to Number for JSON and
 *    stored as TEXT in SQLite (better-sqlite3 has no native BigInt support).
 *  - "no session / not authorized" errors carry .status = 503 so the routes
 *    error middleware returns a clean 503.
 *
 * Cadence changes (per BUILD_SPEC.md):
 *  - Chat matching prefers relationships.telegram_chat_id (exact, TEXT);
 *    the fuzzy name match (exact lowercase → substring either direction) is
 *    the fallback, and a successful name match writes the resolved chat_id
 *    back onto the relationship (self-healing upgrade). ONE matcher serves
 *    the sweep, single-chat fetch, send, and the extraction feed — PipeWise
 *    carried two diverging copies, a known wart. The PipeWise
 *    'company <> Keyrock' tiers are gone: Cadence has no persona-specific
 *    group-naming convention.
 *  - The sweep is backend-owned: no frontend groups payload. sweep() loads
 *    tracked relationships itself and the routes/server just trigger it.
 */

const fs = require("fs");
const path = require("path");

const db = require("./db");
const detection = require("./detection");
const settings = require("./settings");
const { DATA_DIR } = require("./config");

// ── sweep progress state ────────────────────────────────────────────
// In-memory only, single-tenant — same slot contract as PipeWise's
// `_chatsProgress`. sweep() updates this as it walks the two work phases
// (reading tracked conversations, then scanning dialogs for new-conversation
// suggestions) so the frontend can poll GET /api/chats/progress and draw a
// real percentage bar. A crashed/aborted sweep leaves stale data here; the
// next sweep resets it in the `running` block below, so it self-heals.
//   total   = tracked relationships + bounded scan candidates (≤60)
//   current = work units finished so far across both phases
let _progress = {
  status: "idle", // 'idle' | 'running' | 'done' | 'error'
  phase: "", // human-readable
  current: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
};

function getProgress() {
  return { ..._progress };
}

function _setProgress(patch) {
  _progress = { ..._progress, ...patch };
}

// ── last-sweep cache ────────────────────────────────────────────────
// The app's Telegram cache: { sweptAt, chats }. `chats` is keyed BOTH ways,
// with both keys pointing at the SAME per-chat object:
//   - `rel:<relationship.id>` → direct lookups (routes, phone client). The
//     prefix keeps the id keyspace disjoint from group names — a group
//     literally titled "7" must not clobber relationship 7's entry.
//   - telegram_group name     → the followups.js binding: build_queue and
//     extract_promises resolve telegramData[relationship.telegramChat.group],
//     exactly like PipeWise bound its frontend cache to deals. Remove this
//     key and the queue engine silently sees no chats.
// Consumers that ITERATE chats (rather than look up) must dedupe by
// `relationship_id` — dual keying means most chats appear twice.
//
// Persisted to <DATA_DIR>/telegram-cache.json after every successful sweep
// and loaded at module init, so a fresh launch can build a queue from the
// previous run's data while the first sweep runs (warm start). server.js
// reads getLastSweep().sweptAt to decide whether that data is stale.
const SWEEP_CACHE_PATH = path.join(DATA_DIR, "telegram-cache.json");

let _lastSweep = { sweptAt: null, chats: {} };

function getLastSweep() {
  return { ..._lastSweep };
}

// Best-effort read of the persisted sweep. A missing/corrupt cache file just
// means a cold start — never fatal. Returns true if a cache was loaded.
function loadCachedSweep() {
  try {
    if (!fs.existsSync(SWEEP_CACHE_PATH)) return false;
    const raw = JSON.parse(fs.readFileSync(SWEEP_CACHE_PATH, "utf8"));
    if (raw && typeof raw === "object" && raw.chats && typeof raw.chats === "object") {
      _lastSweep = { sweptAt: raw.sweptAt ?? null, chats: raw.chats };
      return true;
    }
  } catch (e) {
    console.error(`[telegram] sweep cache read failed: ${e.message}`);
  }
  return false;
}

// Best-effort write. JSON.stringify flattens the dual-keyed object refs into
// duplicate objects on disk — fine, the cache is read-only after load.
function _persistLastSweep() {
  try {
    fs.mkdirSync(path.dirname(SWEEP_CACHE_PATH), { recursive: true });
    fs.writeFileSync(SWEEP_CACHE_PATH, JSON.stringify(_lastSweep), "utf8");
  } catch (e) {
    console.error(`[telegram] sweep cache write failed: ${e.message}`);
  }
}

// ── action summary generator ────────────────────────────────────────

const _TOPIC_MAP = [
  [/propos(al|e)/, "proposal"],
  [/contract/, "contract"],
  [/complian(ce|t)/, "compliance"],
  [/kyc|kyb|aml/, "KYC/compliance"],
  [/list(ing|ed)/, "listing"],
  [/spread|liquidity|depth/, "liquidity terms"],
  [/market.?mak/, "market making"],
  [/treasury/, "treasury management"],
  [/otc|over.the.counter/, "OTC deal"],
  [/tge|token.gen/, "TGE"],
  [/onboard/, "onboarding"],
  [/call|meet|catch.?up|sync/, "meeting"],
  [/pricing|price|fee|cost|rate/, "pricing"],
  [/sign|signature|docusign/, "contract signing"],
  [/deck|presentation|pitch/, "pitch deck"],
  [/exchange|cex|dex/, "exchange integration"],
  [/pair|instrument|trading/, "trading pairs"],
  [/intro|introduc/, "introduction"],
  [/follow.?up/, "follow-up"],
  [/update|status/, "status update"],
  [/review/, "review"],
  [/question|clarif/, "clarification"],
];

// Generate a short action-item summary from the last few messages.
function _generate_action_summary(messages, waiting_on, chat_name) {
  if (!messages || !messages.length) return "No activity yet — initiate outreach";

  const last = messages[0]; // most recent
  const text = (last.text || "").trim();
  const sender = last.sender || "";
  const is_me = last.is_me || false;

  // Project/company name from the chat (before <>, when present).
  const project = chat_name.includes("<>")
    ? chat_name.split("<>")[0].trim()
    : chat_name;

  const has_question = text.includes("?");

  let detected_topic = null;
  for (const [pattern, label] of _TOPIC_MAP) {
    for (const m of messages.slice(0, 3)) {
      if (pattern.test((m.text || "").toLowerCase())) {
        detected_topic = label;
        break;
      }
    }
    if (detected_topic) break;
  }

  const senderFirst = (sender || "").split(/\s+/)[0] || "";

  if (waiting_on === "them") {
    if (has_question && is_me) {
      if (detected_topic) {
        return `Asked them about ${detected_topic} — awaiting response`;
      }
      return `Sent question — awaiting ${project}'s response`;
    }
    if (detected_topic) {
      if (detected_topic === "meeting") {
        return `Proposed a call — waiting for ${project} to confirm`;
      }
      if (detected_topic === "proposal") {
        return `Proposal sent — waiting for ${project}'s feedback`;
      }
      if (detected_topic === "contract signing") {
        return `Contract shared — waiting for ${project} to sign`;
      }
      return `Discussed ${detected_topic} — ball is in ${project}'s court`;
    }
    return `Sent message — waiting on ${project} to reply`;
  } else if (waiting_on === "me") {
    if (has_question && !is_me) {
      if (detected_topic) {
        return `${senderFirst} asked about ${detected_topic} — reply needed`;
      }
      return `${senderFirst} asked a question — reply needed`;
    }
    if (detected_topic) {
      if (detected_topic === "meeting") {
        return `${senderFirst} wants to schedule a call — confirm availability`;
      }
      if (detected_topic === "proposal") {
        return "They sent a proposal update — review and respond";
      }
      if (detected_topic === "pricing") {
        return `${senderFirst} shared pricing details — review needed`;
      }
      if (detected_topic === "compliance" || detected_topic === "KYC/compliance") {
        return "Compliance info received — review and action";
      }
      return `${senderFirst} messaged about ${detected_topic} — respond`;
    }
    return `${senderFirst} sent a message — reply needed`;
  }

  return "Check thread for latest activity";
}

// ── GramJS client ───────────────────────────────────────────────────

let _gram = null;
function _loadGram() {
  if (_gram) return _gram;
  try {
    _gram = {
      TelegramClient: require("telegram").TelegramClient,
      StringSession: require("telegram/sessions").StringSession,
      Api: require("telegram").Api,
      computeCheck: require("telegram/Password").computeCheck,
    };
  } catch (e) {
    const err = new Error(
      "GramJS not installed — run `npm install` in the desktop/ folder."
    );
    err.status = 503;
    throw err;
  }
  return _gram;
}

let _client = null;

async function connect() {
  if (_client && _client.connected) return _client;
  const { TelegramClient, StringSession } = _loadGram();

  const sessionStr = settings.getTelegramSession();
  const apiId = parseInt(settings.getTelegramApiId(), 10);
  const apiHash = settings.getTelegramApiHash();
  if (!sessionStr || !apiId || !apiHash) {
    const err = new Error(
      "Telegram isn't connected yet — connect it in Cadence Settings."
    );
    err.status = 503;
    throw err;
  }

  _client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 5,
  });
  try {
    _client.setLogLevel("error");
  } catch (e) {
    /* older/newer GramJS — log level API differs; harmless */
  }
  await _client.connect();
  if (!(await _client.isUserAuthorized())) {
    _client = null;
    const err = new Error(
      "Telegram session not authorized — reconnect it in Cadence Settings."
    );
    err.status = 503;
    throw err;
  }
  return _client;
}

async function disconnect() {
  if (_client) {
    try {
      await _client.disconnect();
    } catch (e) {
      /* best-effort */
    }
    _client = null;
  }
}

// Full teardown for app quit: drop the live client AND any half-finished
// login client. server.js calls this from its shutdown path (standalone
// signal handler, or Electron's will-quit).
async function shutdown() {
  clearTimeout(_sweepSoonTimer); // a pending client-add sweep must not fire mid-quit
  if (_pendingLogin) {
    try {
      await _pendingLogin.client.disconnect();
    } catch (e) {
      /* best-effort */
    }
    _pendingLogin = null;
  }
  await disconnect();
}

// ── Telegram login (drives the in-app onboarding / Settings flow) ──
//
// One login at a time (single-user app). _pendingLogin holds the GramJS
// client between the send-code request and the sign-in request. The flow is
// explicit request/response — no held callbacks — so wrong codes / 2FA are
// just normal re-submits from the frontend.

let _pendingLogin = null;

// Map GramJS RpcErrors to a friendly, user-facing message.
function _friendlyTgError(e) {
  const msg = String((e && (e.errorMessage || e.message)) || e || "");
  if (msg.includes("PHONE_CODE_INVALID")) return "That code wasn't right — check it and try again.";
  if (msg.includes("PHONE_CODE_EXPIRED")) return "That code expired — request a new one.";
  if (msg.includes("PHONE_NUMBER_INVALID")) return "That phone number doesn't look valid.";
  if (msg.includes("PHONE_NUMBER_UNOCCUPIED")) return "No Telegram account is registered to that number.";
  if (msg.includes("PHONE_NUMBER_BANNED")) return "That number is banned from Telegram.";
  if (msg.includes("PASSWORD_HASH_INVALID")) return "That 2FA password wasn't right.";
  if (msg.includes("API_ID_INVALID") || msg.includes("API_ID_PUBLISHED")) {
    return "The api_id / api_hash don't look right — double-check them at my.telegram.org.";
  }
  const flood = msg.match(/FLOOD_WAIT_(\d+)/);
  if (flood) return `Telegram is rate-limiting logins — wait ${flood[1]}s and try again.`;
  return msg || "Telegram login failed.";
}

// Step 1: send the login code to the user's phone. Holds the pending client.
async function beginTelegramLogin(apiId, apiHash, phone) {
  const { TelegramClient, StringSession } = _loadGram();
  if (_pendingLogin) {
    try { await _pendingLogin.client.disconnect(); } catch (e) { /* */ }
    _pendingLogin = null;
  }
  const id = parseInt(apiId, 10);
  const hash = String(apiHash || "").trim();
  const phoneNumber = String(phone || "").trim();
  if (!id || !hash || !phoneNumber) {
    const err = new Error("api_id, api_hash and phone number are all required.");
    err.status = 400;
    throw err;
  }
  const client = new TelegramClient(new StringSession(""), id, hash, {
    connectionRetries: 5,
  });
  try {
    await client.connect();
    const sent = await client.sendCode({ apiId: id, apiHash: hash }, phoneNumber);
    _pendingLogin = {
      client,
      apiId: id,
      apiHash: hash,
      phone: phoneNumber,
      phoneCodeHash: sent.phoneCodeHash,
      codeAccepted: false,
    };
    return { codeSent: true };
  } catch (e) {
    try { await client.disconnect(); } catch (_) { /* */ }
    const err = new Error(_friendlyTgError(e));
    err.status = 400;
    throw err;
  }
}

// Step 2: submit the code (and 2FA password if the account has one).
// Returns { ok: true } on success, { needPassword: true } if 2FA is required.
async function completeTelegramLogin(code, password) {
  if (!_pendingLogin) {
    const err = new Error("No login in progress — request a code first.");
    err.status = 400;
    throw err;
  }
  const { Api, computeCheck } = _loadGram();
  const p = _pendingLogin;

  if (!p.codeAccepted) {
    try {
      await p.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: p.phone,
          phoneCodeHash: p.phoneCodeHash,
          phoneCode: String(code || ""),
        })
      );
      p.codeAccepted = true;
      return await _finishTelegramLogin(p); // signed in, no 2FA
    } catch (e) {
      const msg = String((e && (e.errorMessage || e.message)) || "");
      if (msg.includes("SESSION_PASSWORD_NEEDED")) {
        p.codeAccepted = true; // code accepted; 2FA password still needed
      } else {
        const err = new Error(_friendlyTgError(e));
        err.status = 400;
        throw err;
      }
    }
  }

  if (!password) return { needPassword: true };
  try {
    const pwdInfo = await p.client.invoke(new Api.account.GetPassword());
    const srp = await computeCheck(pwdInfo, String(password));
    await p.client.invoke(new Api.auth.CheckPassword({ password: srp }));
    return await _finishTelegramLogin(p);
  } catch (e) {
    const err = new Error(_friendlyTgError(e));
    err.status = 400;
    throw err;
  }
}

async function _finishTelegramLogin(p) {
  const sessionStr = p.client.session.save();
  settings.set({
    telegramApiId: String(p.apiId),
    telegramApiHash: p.apiHash,
    telegramSession: sessionStr,
  });
  try { await p.client.disconnect(); } catch (e) { /* */ }
  _pendingLogin = null;
  // Force the live client to rebuild from the new session on next use.
  if (_client) {
    try { await _client.disconnect(); } catch (e) { /* */ }
    _client = null;
  }
  return { ok: true };
}

async function telegramLogout() {
  settings.set({ telegramSession: "" });
  if (_pendingLogin) {
    try { await _pendingLogin.client.disconnect(); } catch (e) { /* */ }
    _pendingLogin = null;
  }
  if (_client) {
    try { await _client.disconnect(); } catch (e) { /* */ }
    _client = null;
  }
  return { ok: true };
}

// GramJS ids are big-integers — convert to a plain Number for JSON / DB.
function _idNum(id) {
  if (id === null || id === undefined) return null;
  return Number(id.toString());
}

// ── core logic ──────────────────────────────────────────────────────

// Normalize a GramJS message object into our plain dict (async because
// GramJS resolves the sender lazily). Returns null for empty messages.
async function _extract_message_meta(m, myId) {
  if (!m || (!m.message && !m.media)) return null;

  let senderName = "Unknown";
  let isMe = false;
  if (m.senderId !== null && m.senderId !== undefined) {
    isMe = m.senderId.toString() === myId.toString();
    let sender = m.sender;
    if (!sender) {
      try {
        sender = await m.getSender();
      } catch (e) {
        sender = null;
      }
    }
    if (sender) {
      if (sender.firstName !== undefined || sender.lastName !== undefined) {
        senderName =
          [sender.firstName, sender.lastName].filter(Boolean).join(" ") ||
          "Unknown";
      } else {
        senderName = sender.title || "Unknown";
      }
    }
  }

  let hasPdf = false;
  let pdfFilename = null;
  let doc = null;
  try {
    doc = m.document;
  } catch (e) {
    doc = null;
  }
  if (doc && doc.mimeType === "application/pdf") {
    hasPdf = true;
    for (const attr of doc.attributes || []) {
      if (attr.fileName) {
        pdfFilename = attr.fileName;
        break;
      }
    }
  }

  return {
    id: m.id,
    text: (m.message || "[media]").slice(0, 200),
    sender: senderName.trim(),
    is_me: isMe,
    date: m.date ? new Date(m.date * 1000).toISOString() : null,
    has_pdf: hasPdf,
    pdf_filename: pdfFilename,
  };
}

// ── the one dialog matcher ──────────────────────────────────────────
// Every relationship→dialog resolution in this module goes through
// _index_dialogs + _match_dialog. PipeWise had two diverging copies of the
// fuzzy matcher (sweep + send); keep it ONE here.

// Index a getDialogs() result for the matcher. Both indexes keep PipeWise's
// last-wins overwrite semantics for duplicate names.
function _index_dialogs(dialogs) {
  const byId = {}; // chat id (TEXT) → dialog
  const byName = {}; // lowercased trimmed name → dialog
  for (const d of dialogs) {
    const id = _idNum(d.id);
    if (id !== null) byId[String(id)] = d;
    const name = (d.name || "").trim();
    if (name) byName[name.toLowerCase()] = d;
  }
  return { byId, byName };
}

// Resolve a relationship's dialog. Tiers:
//   0. exact chat_id (TEXT compare — GramJS ids are bigints, stored as TEXT)
//   1. exact lowercased name
//   2. substring either direction
// Returns { dialog, via: 'chat_id' | 'name' } or null. `via` tells the
// caller whether the chat_id self-heal applies.
function _match_dialog(index, chatId, groupName) {
  const idKey = chatId != null ? String(chatId).trim() : "";
  if (idKey && index.byId[idKey]) {
    return { dialog: index.byId[idKey], via: "chat_id" };
  }
  const key = (groupName || "").toLowerCase().trim();
  if (!key) return null;
  if (index.byName[key]) return { dialog: index.byName[key], via: "name" };
  for (const [dname, d] of Object.entries(index.byName)) {
    if (dname.includes(key) || key.includes(dname)) {
      return { dialog: d, via: "name" };
    }
  }
  return null;
}

// Self-healing binding upgrade: after a successful fuzzy NAME match, write
// the resolved chat_id back onto the relationship so every future join is
// exact (and so tg:// deep links work in the iPhone phase). Best-effort —
// a failed write just means the next resolution fuzzy-matches again.
function _maybe_self_heal_chat_id(rel, dialog, via) {
  if (via !== "name") return;
  const id = _idNum(dialog.id);
  if (id === null) return;
  const chatIdText = String(id);
  const stored = (rel.telegramChat && rel.telegramChat.chatId) || "";
  if (chatIdText === String(stored)) return;
  try {
    db.set_telegram_chat_id(rel.id, chatIdText);
  } catch (dbErr) {
    console.log(`[DB] chat_id self-heal failed for ${rel.name}: ${dbErr.message}`);
  }
}

// Pull the last 10 messages of a matched dialog and shape the per-chat
// result. Errors during the message pull degrade to the same shape with an
// `error` field — one flaky chat must not kill a whole sweep.
async function _read_chat(client, myId, rel, dialog) {
  try {
    const messages = await client.getMessages(dialog.entity, { limit: 10 });
    const lastMsgs = (
      await Promise.all(messages.map((m) => _extract_message_meta(m, myId)))
    ).filter(Boolean);

    let waitingOn = "unknown";
    if (lastMsgs.length) waitingOn = lastMsgs[0].is_me ? "them" : "me";

    const action = _generate_action_summary(
      lastMsgs,
      waitingOn,
      (rel.telegramChat && rel.telegramChat.group) || dialog.name || rel.name
    );

    return {
      matched: true,
      relationship_id: rel.id,
      chat_name: dialog.name,
      chat_id: _idNum(dialog.id),
      messages: lastMsgs,
      last_message: lastMsgs[0] || null,
      waiting_on: waitingOn,
      action_summary: action,
    };
  } catch (e) {
    return {
      matched: true,
      relationship_id: rel.id,
      chat_name: dialog.name,
      chat_id: _idNum(dialog.id),
      messages: [],
      last_message: null,
      waiting_on: "unknown",
      error: String(e.message || e),
    };
  }
}

// ── new-conversation scan (sweep phase 2) ───────────────────────────

// Strip leading emojis / symbols common in Telegram group titles, so the
// suggested relationship name is clean. (Ported from the PipeWise company
// derivation; the '<>'-split lived there too and is gone with the persona.)
function _clean_chat_name(name) {
  const trimmed = (name || "").trim();
  return trimmed.replace(/^[^\p{L}\p{N}_]+/u, "").trim() || trimmed;
}

// Sweep non-tracked dialogs for new-conversation triggers, write pending
// Suggestions to the DB. `known` = { names: Set, chatIds: Set } covering
// every tracked relationship (archived included — an archived
// relationship's dialog is not an "unknown" conversation) plus every dialog
// phase 1 actually resolved.
async function _scan_for_new_conversations(dialogs, known, myId, progress = null) {
  const suggestionsAdded = [];

  // Suppression: a group with a pending OR dismissed suggestion is never
  // re-suggested (the user already saw it, or said no).
  let suppressed;
  try {
    suppressed = new Set(db.list_active_groups());
  } catch (e) {
    suppressed = new Set();
  }

  const candidates = [];
  for (const d of dialogs) {
    const name = (d.name || "").trim();
    if (!name) continue;
    if (known.names.has(name) || suppressed.has(name)) continue;
    const id = _idNum(d.id);
    if (id !== null && known.chatIds.has(String(id))) continue;
    if (d.isChannel && !d.isGroup) continue; // skip broadcast channels
    candidates.push(d);
  }
  const bounded = candidates.slice(0, 60);
  // Tell the caller how many work units this phase adds so the progress bar's
  // denominator covers the whole sweep, not just the tracked-chat phase.
  if (progress && typeof progress.onTotal === "function") progress.onTotal(bounded.length);

  const client = await connect();
  for (const d of bounded) {
    // Tick first so every candidate counts even when we `continue` below.
    if (progress && typeof progress.onTick === "function") progress.onTick();
    let msgsRaw;
    try {
      msgsRaw = await client.getMessages(d.entity, { limit: 10 });
    } catch (e) {
      continue;
    }
    const msgs = (
      await Promise.all(msgsRaw.map((m) => _extract_message_meta(m, myId)))
    ).filter(Boolean);
    if (!msgs.length) continue;

    const signal = detection.detect_new_conversation_signal(msgs);
    if (!signal) continue;

    try {
      const dict = db.insert_suggestion({
        telegramGroup: d.name,
        telegramChatId: _idNum(d.id),
        suggestedName: _clean_chat_name(d.name),
        firstMessage: signal.firstMessage,
        messageCount: signal.messageCount,
      });
      // null = the UNIQUE(telegram_group, status) dedupe swallowed it.
      if (!dict) continue;
      suggestionsAdded.push(dict);
      console.log(`[suggest] new conversation candidate: ${d.name}`);
    } catch (dbErr) {
      console.log(`[suggest] write failed for ${d.name}: ${dbErr.message}`);
    }
  }
  return suggestionsAdded;
}

// ── the sweep ───────────────────────────────────────────────────────

let _sweeping = false;

function isSweeping() {
  return _sweeping;
}

// The full sweep cycle to run for scheduled sweeps. Defaults to a bare
// sweep(); server.js swaps in its cycle (sweep + post-sweep todo/promise
// extraction) at startup so routes never need to import server.js back
// (circular). The runner is expected to catch its own errors.
let _sweepRunner = () =>
  sweep().catch((e) => console.error(`[sweep] scheduled sweep failed: ${e.message}`));

function setSweepRunner(fn) {
  _sweepRunner = fn;
}

function runSweepCycle() {
  return _sweepRunner();
}

// Debounced near-term sweep — routes call this after a relationship gains a
// Telegram binding (create / rebind / suggestion accept) so the first
// insights for a new client appear in seconds, not on the next 30-minute
// tick. Debounce lets "add three clients in a row" cost one sweep.
let _sweepSoonTimer = null;

function sweepSoon(delayMs = 3000) {
  clearTimeout(_sweepSoonTimer);
  _sweepSoonTimer = setTimeout(() => {
    _sweepSoonTimer = null;
    if (_sweeping) return; // an in-flight sweep predates the new client; the timer cycle catches up
    runSweepCycle();
  }, delayMs);
  if (_sweepSoonTimer.unref) _sweepSoonTimer.unref();
}

// Walk every tracked relationship's chat (last 10 messages, waiting_on,
// action summary, telegram_last_activity write-back), then scan unknown
// dialogs for new-conversation suggestions. Backend-owned: server.js runs
// this on a 30-minute timer and POST /api/chats/sweep triggers it on demand.
// Returns { chats, newSuggestions } — or { alreadyRunning: true } without
// touching the progress slot when a sweep is in flight (the route answers
// 202 from isSweeping(); this guard closes the race).
async function sweep() {
  if (_sweeping) return { alreadyRunning: true };
  _sweeping = true;

  // Reset the progress slot for this sweep. `total` starts at the tracked
  // relationship count; the new-conversation scan adds its bounded candidate
  // count (via the onTotal callback) once it knows how many dialogs it'll
  // walk — the PipeWise trap: total must cover BOTH phases or the bar jumps
  // to 100% early and sits there.
  _setProgress({
    status: "running",
    phase: "Connecting to Telegram",
    current: 0,
    total: 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  });

  try {
    const client = await connect();
    const me = await client.getMe();
    const myId = me.id;

    const dialogs = await client.getDialogs({ limit: 400 });
    const index = _index_dialogs(dialogs);

    // Tracked = non-archived relationships with any Telegram binding.
    const tracked = db.list_relationships().filter((r) => r.telegramChat);
    _setProgress({ phase: "Reading conversations", total: tracked.length });

    // Known-set for the phase-2 scan: every relationship's stored binding
    // (archived included), grown below with each dialog phase 1 resolves —
    // so a chat_id-matched dialog whose display name drifted from the
    // stored group name still isn't re-suggested.
    const knownNames = new Set();
    const knownChatIds = new Set();
    for (const r of db.list_relationships(true)) {
      if (!r.telegramChat) continue;
      if (r.telegramChat.group) knownNames.add(r.telegramChat.group.trim());
      if (r.telegramChat.chatId) knownChatIds.add(String(r.telegramChat.chatId));
    }

    const chats = {};
    for (const rel of tracked) {
      const groupName = rel.telegramChat.group || null;
      const hit = _match_dialog(index, rel.telegramChat.chatId, groupName);

      let result;
      if (hit) {
        const { dialog, via } = hit;
        const id = _idNum(dialog.id);
        if (id !== null) knownChatIds.add(String(id));
        const dname = (dialog.name || "").trim();
        if (dname) knownNames.add(dname);

        _maybe_self_heal_chat_id(rel, dialog, via);

        result = await _read_chat(client, myId, rel, dialog);

        // Stamp the newest message time so "inactive for X" stays honest.
        // (The send route stamps too — this module's only other DB write.)
        const lastDate = result.last_message ? result.last_message.date : null;
        if (lastDate) {
          try {
            db.set_telegram_last_activity(rel.id, lastDate);
          } catch (dbErr) {
            console.log(`[DB] write-back failed for ${rel.name}: ${dbErr.message}`);
          }
        }
      } else {
        result = { matched: false, relationship_id: rel.id };
      }

      // Dual keying (see the last-sweep cache notes above): prefixed
      // relationship id for direct lookups, group name for the followups.js
      // binding. Both keys point at the same object.
      chats[`rel:${rel.id}`] = result;
      if (groupName) chats[groupName] = result;

      _setProgress({ current: _progress.current + 1 });
    }

    // onTotal lets the scan grow `total` by its bounded candidate count once
    // it has filtered the dialog list, then tick `current` per candidate —
    // so the bar reflects both phases on one continuous scale.
    const newSuggestions = await _scan_for_new_conversations(
      dialogs,
      { names: knownNames, chatIds: knownChatIds },
      myId,
      {
        onTotal: (n) =>
          _setProgress({
            phase: "Scanning for new conversations",
            total: _progress.total + n,
          }),
        onTick: () => _setProgress({ current: _progress.current + 1 }),
      }
    );

    _setProgress({
      status: "done",
      phase: "Complete",
      current: _progress.total,
      finishedAt: Date.now(),
    });

    _lastSweep = { sweptAt: new Date().toISOString(), chats };
    _persistLastSweep();

    return { chats, newSuggestions };
  } catch (err) {
    _setProgress({
      status: "error",
      phase: "Failed",
      error: String((err && err.message) || err),
      finishedAt: Date.now(),
    });
    throw err;
  } finally {
    _sweeping = false;
  }
}

// ── single-chat fetch (draft-reply context) ─────────────────────────

// Fetch ONE relationship's chat — same per-chat shape as the sweep produces,
// but none of the sweep's side effects: drafting a reply must not trigger a
// full dialog walk + suggestion scan, and it does NOT stamp
// telegram_last_activity (only the sweep and the send route write that).
async function _fetch_single_chat(relationship) {
  const rel = relationship;
  if (!rel || !rel.telegramChat) {
    return { matched: false, relationship_id: rel ? rel.id : null };
  }
  const client = await connect();
  const me = await client.getMe();
  const myId = me.id;

  const dialogs = await client.getDialogs({ limit: 400 });
  const index = _index_dialogs(dialogs);
  const hit = _match_dialog(index, rel.telegramChat.chatId, rel.telegramChat.group);
  if (!hit) return { matched: false, relationship_id: rel.id };

  _maybe_self_heal_chat_id(rel, hit.dialog, hit.via);
  return _read_chat(client, myId, rel, hit.dialog);
}

// ── send ────────────────────────────────────────────────────────────

// Send a message to a relationship's chat. Resolution is chat_id first,
// fuzzy name fallback — the same single matcher as the sweep. Returns the
// sent-message envelope; the CALLER stamps telegram_last_activity (the send
// route does it, mirroring PipeWise — beyond the chat_id self-heal this
// function has no DB side effects).
async function _send_message(relationship, text) {
  if (!text || !text.trim()) {
    const e = new Error("Empty message");
    e.status = 400;
    throw e;
  }
  const rel = relationship;
  if (!rel || !rel.telegramChat) {
    const e = new Error("Relationship has no Telegram chat");
    e.status = 400;
    throw e;
  }
  const client = await connect();
  const dialogs = await client.getDialogs({ limit: 400 });
  const index = _index_dialogs(dialogs);
  const hit = _match_dialog(index, rel.telegramChat.chatId, rel.telegramChat.group);
  if (hit === null) {
    const label = rel.telegramChat.group || rel.telegramChat.chatId || rel.name;
    const e = new Error(`Could not find a Telegram chat matching '${label}'`);
    e.status = 400;
    throw e;
  }
  _maybe_self_heal_chat_id(rel, hit.dialog, hit.via);
  const sent = await client.sendMessage(hit.dialog.entity, { message: text });
  return {
    chat_id: _idNum(hit.dialog.id),
    chat_name: hit.dialog.name,
    message_id: sent && sent.id !== undefined ? sent.id : null,
    date: sent && sent.date ? new Date(sent.date * 1000).toISOString() : null,
    text: text,
  };
}

// ── extraction feed ─────────────────────────────────────────────────

// Fetch messages for todo extraction (used by todos.js). Tracked chats are
// resolved through the same single matcher as the sweep (chat_id first,
// fuzzy name fallback) and tagged with relationship_id; untracked dialogs
// with recent activity ride along untagged.
async function _fetch_recent_conversations(days = 30, perChatLimit = 60, maxChats = 60) {
  const client = await connect();
  const me = await client.getMe();
  const myId = me.id;

  const dialogs = await client.getDialogs({ limit: 400 });
  const index = _index_dialogs(dialogs);

  // dialog id (TEXT) → relationship id, via the one matcher. First
  // relationship wins when two fuzzy-match the same dialog.
  const relByDialogId = {};
  for (const rel of db.list_relationships()) {
    if (!rel.telegramChat) continue;
    const hit = _match_dialog(index, rel.telegramChat.chatId, rel.telegramChat.group);
    if (!hit) continue;
    const id = _idNum(hit.dialog.id);
    if (id === null) continue;
    if (!(String(id) in relByDialogId)) relByDialogId[String(id)] = rel.id;
  }

  const cutoff = Date.now() / 1000 - days * 86400; // unix seconds
  const selected = [];
  for (const d of dialogs) {
    const name = (d.name || "").trim();
    if (!name) continue;
    if (d.isChannel && !d.isGroup) continue; // skip broadcast channels
    const id = _idNum(d.id);
    const relationshipId = id !== null ? relByDialogId[String(id)] ?? null : null;
    let recent = false;
    if (d.date !== null && d.date !== undefined) {
      recent = d.date >= cutoff;
    }
    if (relationshipId === null && !recent) continue;
    selected.push([d, relationshipId]);
  }

  // relationship-linked chats first (stable sort preserves recency within
  // each group)
  selected.sort(
    (a, b) => (a[1] !== null ? 0 : 1) - (b[1] !== null ? 0 : 1)
  );
  const head = selected.slice(0, maxChats);

  const conversations = [];
  for (const [d, relationshipId] of head) {
    let raw;
    try {
      raw = await client.getMessages(d.entity, { limit: perChatLimit });
    } catch (e) {
      continue;
    }
    const msgs = [];
    for (const m of raw) {
      const meta = await _extract_message_meta(m, myId);
      if (!meta) continue;
      if (meta.date) {
        const md = new Date(meta.date).getTime() / 1000;
        if (!Number.isNaN(md) && md < cutoff) continue;
      }
      msgs.push(meta);
    }
    if (!msgs.length) continue;
    conversations.push({
      chat_id: _idNum(d.id),
      chat_name: d.name,
      relationship_id: relationshipId,
      messages: msgs,
    });
  }
  return conversations;
}

// ── module init ─────────────────────────────────────────────────────
// Warm start: pick up the previous run's persisted sweep so the queue can
// build immediately after launch while the first live sweep runs.
loadCachedSweep();

module.exports = {
  // lifecycle
  connect,
  disconnect,
  shutdown,
  // in-app login flow
  beginTelegramLogin,
  completeTelegramLogin,
  telegramLogout,
  // sweep
  sweep,
  sweepSoon,
  setSweepRunner,
  runSweepCycle,
  isSweeping,
  getProgress,
  getLastSweep,
  loadCachedSweep,
  _scan_for_new_conversations,
  // single-chat / send / extraction feed
  _fetch_single_chat,
  _send_message,
  _fetch_recent_conversations,
  // pure helpers (exported for tests, like PipeWise)
  _generate_action_summary,
  _extract_message_meta,
};
