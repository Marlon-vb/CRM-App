/* Cadence backend — HTTP layer (Express).
 *
 * Ported from PipeWise routes.js onto the Cadence API surface (BUILD_SPEC.md).
 * Same middleware stack — auth token, JSON parsing, Host/Origin lockdown,
 * CSP, static frontend, {"error": ...} error shape — with the deal-era
 * routes gone (no pipeline, no CoinGecko, no contacts, no cloud yet).
 *
 * Structural changes from PipeWise:
 *  - No optionalModule() dance: every backend module exists in this phase,
 *    so they're required directly. A module that throws on require surfaces
 *    that error — we want to know.
 *  - The queue endpoint is a GET: the backend owns the Telegram cache now
 *    (telegram.js sweeps on the server.js timer), so the frontend no longer
 *    ships telegramData in the body.
 *  - No auto-sync middleware, no /api/cloud/* — cloud publish is Phase 4.
 *
 * Service modules signal "unavailable" by throwing an Error with .status set
 * (503 = not configured / upstream failed, 400 = bad input, 404 = missing
 * row). The error middleware below turns any thrown error's .status into
 * the HTTP status.
 */

const express = require("express");

const db = require("./db");
const { PORT, FRONTEND_DIST } = require("./config");
const settings = require("./settings");
const auth = require("./auth");
const telegram = require("./telegram");
const drafting = require("./drafting");
const todosMod = require("./todos");
const granola = require("./granola");
const followups = require("./followups");

// ── helpers ────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wrap a (possibly async) handler so thrown/rejected errors reach the
// error middleware — Express 4 doesn't auto-forward async rejections.
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Parse a query param as a boolean, FastAPI-style.
function parseBool(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  return ["true", "1", "yes", "on"].includes(String(v).toLowerCase());
}

const idParam = (req) => Number(req.params.id);

// ── app + middleware ───────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── origin / host lockdown (no CORS) ───────────────────────────────
// The renderer is served from this same origin, so its fetches are
// same-origin and need no CORS headers at all. We deliberately send NO
// Access-Control-Allow-Origin: foreign web pages that fetch
// localhost:3456 then can't read responses. Two explicit checks on top:
//
//   Host    — must be our own host:port. Defeats DNS rebinding, where a
//             page resolves attacker.com → 127.0.0.1 and the browser
//             sends Host: attacker.com (same-origin in the browser's
//             eyes, so CORS alone wouldn't save us).
//   Origin  — when a browser sends one (cross-origin requests, and POSTs
//             from anywhere), it must be on the allowlist. Same-origin
//             GETs may omit it; that's fine — Host already passed.
//
// :5173 is the Vite dev server (CADENCE_URL dev mode); its proxy sets
// Host to :3456 (changeOrigin) but forwards the renderer's Origin.
const _ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const _ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

app.use((req, res, next) => {
  if (!_ALLOWED_HOSTS.has(req.headers.host)) {
    return res.status(403).json({ error: "Forbidden: bad Host header." });
  }
  const origin = req.headers.origin;
  if (origin && !_ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: "Forbidden: bad Origin." });
  }
  next();
});

// ── Content-Security-Policy ────────────────────────────────────────
// Defense-in-depth: the frontend has no HTML-injection sinks today, but
// if one ever slips in, this limits what injected script can do. Unlike
// PipeWise there are NO external origins at all — Tailwind is a build
// dep (no CDN) and there are no external data feeds. script/style
// 'unsafe-inline' remain: index.html's no-flash theme bootstrap is an
// inline script, and React style={{...}} attributes are inline styles.
const _CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

app.use((req, res, next) => {
  res.set("Content-Security-Policy", _CSP);
  next();
});

// ── local API auth ─────────────────────────────────────────────────
// Random per-launch token, required on every /api route. The Electron
// renderer gets it via preload (window.cadence.apiToken); see auth.js
// for the browser-dev escape hatch. Static frontend assets stay open —
// they're the app shell, not data.
app.use("/api", auth.requireToken);

// ══════════════════════════════════════════════════════════════════
// Routes
// ══════════════════════════════════════════════════════════════════

// ── Health ─────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// ── Setup / per-user configuration ─────────────────────────────────

app.get("/api/setup/status", wrap((req, res) => {
  res.json(settings.status());
}));

app.post("/api/setup/keys", wrap((req, res) => {
  const body = req.body || {};
  const updates = {};
  for (const k of [
    "anthropicKey", "granolaKey", "telegramApiId", "telegramApiHash",
    "onboarded",
    "userName", "userCompany", "userRole",
  ]) {
    if (k in body) updates[k] = body[k];
  }
  settings.set(updates);
  res.json(settings.status());
}));

app.post("/api/setup/telegram/send-code", wrap(async (req, res) => {
  const { apiId, apiHash, phone } = req.body || {};
  if (!apiId || !apiHash || !phone) {
    throw new HttpError(400, "apiId, apiHash and phone are required");
  }
  res.json(await telegram.beginTelegramLogin(apiId, apiHash, phone));
}));

app.post("/api/setup/telegram/sign-in", wrap(async (req, res) => {
  const { code, password } = req.body || {};
  if (!code) throw new HttpError(400, "code is required");
  res.json(await telegram.completeTelegramLogin(code, password || ""));
}));

app.post("/api/setup/telegram/logout", wrap(async (req, res) => {
  await telegram.telegramLogout();
  res.json(settings.status());
}));

// ── Relationships ──────────────────────────────────────────────────

// Archived rows are INCLUDED — the Clients tab renders active + archived
// (unarchive lives there). The queue engine and the sweep do their own
// archived filtering, so this is a pure display concern.
app.get("/api/relationships", wrap((req, res) => {
  res.json(db.list_relationships(true));
}));

app.post("/api/relationships", wrap((req, res) => {
  res.status(201).json(db.create_relationship(req.body || {}));
}));

app.patch("/api/relationships/:id", wrap((req, res) => {
  const relationship = db.update_relationship(idParam(req), req.body || {});
  if (relationship === null) throw new HttpError(404, "Relationship not found");
  res.json(relationship);
}));

app.delete("/api/relationships/:id", wrap((req, res) => {
  if (db.delete_relationship(idParam(req))) return res.status(204).end();
  throw new HttpError(404, "Relationship not found");
}));

app.post("/api/relationships/:id/archive", wrap((req, res) => {
  const relationship = db.archive_relationship(idParam(req));
  if (relationship === null) throw new HttpError(404, "Relationship not found");
  res.json(relationship);
}));

app.post("/api/relationships/:id/unarchive", wrap((req, res) => {
  const relationship = db.unarchive_relationship(idParam(req));
  if (relationship === null) throw new HttpError(404, "Relationship not found");
  res.json(relationship);
}));

app.post("/api/relationships/:id/draft-reply", wrap(async (req, res) => {
  const relationship = db.get_relationship(idParam(req));
  if (!relationship) throw new HttpError(404, "Relationship not found");
  if (!relationship.telegramChat) {
    throw new HttpError(400, "Relationship has no Telegram chat");
  }

  // Pull recent messages via the single-chat fetch — NOT a full sweep:
  // drafting one reply must not trigger a dialog walk + suggestion scan.
  // Tolerate failure; the draft still works with less context.
  let chatData = { matched: false, relationship_id: relationship.id, messages: [] };
  try {
    chatData = await telegram._fetch_single_chat(relationship);
  } catch (fetchErr) {
    console.log(
      `[draft] message fetch failed for ${relationship.name}: ${fetchErr.message}`
    );
  }

  const body = req.body || {};
  const tone = body.tone || "default";
  const instructions = body.instructions || "";
  const draft = await drafting.draft_reply(relationship, chatData, instructions, tone);
  res.json({
    draft,
    tone,
    messages: chatData.messages || [],
    chat_name: chatData.chat_name ?? null,
  });
}));

app.post("/api/relationships/:id/send-message", wrap(async (req, res) => {
  const text = ((req.body || {}).text || "").trim();
  if (!text) throw new HttpError(400, "Empty message");
  const relationship = db.get_relationship(idParam(req));
  if (!relationship) throw new HttpError(404, "Relationship not found");
  if (!relationship.telegramChat) {
    throw new HttpError(400, "Relationship has no Telegram chat");
  }

  const result = await telegram._send_message(relationship, text);

  // Stamp last activity so "silent for X" stays honest. _send_message
  // deliberately doesn't write this itself — the route does, mirroring
  // PipeWise (the sweep is the only other writer).
  if (result.date) {
    try {
      db.set_telegram_last_activity(relationship.id, result.date);
    } catch (e) {
      /* best-effort */
    }
  }
  res.json(result);
}));

// ── Todos ──────────────────────────────────────────────────────────

app.get("/api/todos", wrap((req, res) => {
  const includeCompleted = parseBool(req.query.includeCompleted, true);
  res.json(db.list_todos(includeCompleted));
}));

app.post("/api/todos", wrap((req, res) => {
  res.status(201).json(db.create_todo(req.body || {}));
}));

app.post("/api/todos/reorder", wrap((req, res) => {
  const ordered = (req.body || {}).order;
  if (!Array.isArray(ordered)) {
    throw new HttpError(400, "order must be a list of todo ids");
  }
  const ids = ordered.map((x) => Number(x));
  if (ids.some((n) => !Number.isInteger(n))) {
    throw new HttpError(400, "order must contain integer todo ids");
  }
  res.json(db.reorder_todos(ids));
}));

app.patch("/api/todos/:id", wrap((req, res) => {
  const todo = db.update_todo(idParam(req), req.body || {});
  if (todo === null) throw new HttpError(404, "Todo not found");
  res.json(todo);
}));

app.delete("/api/todos/:id", wrap((req, res) => {
  if (db.delete_todo(idParam(req))) return res.status(204).end();
  throw new HttpError(404, "Todo not found");
}));

app.post("/api/todos/refresh", wrap(async (req, res) => {
  const force = Boolean((req.body || {}).force);
  res.json(await todosMod.extract_todos(force));
}));

// ── Notes (Granola) ────────────────────────────────────────────────

app.get("/api/notes", wrap((req, res) => {
  const relationshipId =
    req.query.relationshipId !== undefined
      ? Number(req.query.relationshipId)
      : null;
  res.json(db.list_synced_notes(relationshipId));
}));

app.post("/api/notes/sync", wrap(async (req, res) => {
  const notes = await granola.fetch_recent_notes(30, 40);
  res.json(db.upsert_synced_notes(notes));
}));

// ── Follow-up engine (the Queue) ───────────────────────────────────
// GET, not POST like PipeWise: the backend owns the Telegram cache now.
// build_queue keeps its injected-data signature (the stubbed-db harness
// depends on it) — the route feeds it the last sweep's chats and adds
// `sweptAt` so the UI can show data age.

app.get("/api/followups/queue", wrap((req, res) => {
  const last = telegram.getLastSweep();
  const result = followups.build_queue({ telegramData: last.chats || {} });
  res.json({ ...result, sweptAt: last.sweptAt ?? null });
}));

app.post("/api/followups/snooze", wrap((req, res) => {
  const { itemKey, mode, until, lastInboundAt } = req.body || {};
  if (!itemKey) throw new HttpError(400, "itemKey required");
  res.json(db.set_fu_snooze(itemKey, mode, until, lastInboundAt));
}));

app.post("/api/followups/unsnooze", wrap((req, res) => {
  const { itemKey } = req.body || {};
  if (!itemKey) throw new HttpError(400, "itemKey required");
  res.json(db.clear_fu_snooze(itemKey));
}));

// No body — promises are extracted from the backend's own sweep cache.
app.post("/api/followups/extract-promises", wrap(async (req, res) => {
  res.json(await followups.extract_promises(telegram.getLastSweep().chats || {}));
}));

app.get("/api/followups/promises", wrap((req, res) => {
  const relationshipId =
    req.query.relationshipId !== undefined
      ? Number(req.query.relationshipId)
      : null;
  const status = req.query.status || "open";
  res.json(db.list_fu_promises(relationshipId, status));
}));

app.patch("/api/followups/promises/:id", wrap((req, res) => {
  const status = (req.body || {}).status || "kept";
  res.json(db.resolve_fu_promise(idParam(req), status));
}));

app.post("/api/followups/cadence/:relationshipId", wrap((req, res) => {
  const relationshipId = Number(req.params.relationshipId);
  const days = (req.body || {}).days;
  res.json(followups.set_cadence(relationshipId, days));
}));

app.post("/api/followups/draft-recap", wrap(async (req, res) => {
  const noteId = Number((req.body || {}).noteId);
  if (!Number.isInteger(noteId)) throw new HttpError(400, "noteId required");
  res.json(await followups.draft_recap(noteId));
}));

// ── Telegram sweep (backend-owned) ─────────────────────────────────

// Kick off a sweep. Fire-and-forget: the sweep writes its progress to the
// in-memory slot the next route reads, so this returns within milliseconds.
// 202 either way — {alreadyRunning: true} when one is in flight (sweep()'s
// own guard closes the check-then-fire race), {started: true} otherwise.
// A failed sweep records status:"error" in the progress slot; the fired
// promise's catch below just keeps the rejection from being unhandled.
app.post("/api/chats/sweep", wrap((req, res) => {
  if (!settings.status().telegram) {
    // Frontend treats a sweep 503 as "not set up yet" (no toast) — the
    // SetupBanner is the messaging surface for this state.
    return res.status(503).json({ error: "Telegram isn't connected yet — connect it in Cadence Settings." });
  }
  if (telegram.isSweeping()) {
    return res.status(202).json({ alreadyRunning: true });
  }
  telegram.sweep().catch((err) => {
    console.error(`[sweep] on-demand sweep failed: ${err.message}`);
  });
  res.status(202).json({ started: true });
}));

// Live progress for the in-flight sweep. The frontend polls this every
// ~400ms to drive the top-of-page percentage bar. In-memory +
// single-tenant — returns the last known state ({status, phase, current,
// total, ...}); 'idle' before the first sweep, 'done'/'error' after.
app.get("/api/chats/progress", wrap((req, res) => {
  res.json(telegram.getProgress());
}));

// The last completed sweep: { sweptAt, chats } — warm-started from disk at
// launch, so this has data even before the first live sweep finishes
// ({ sweptAt: null, chats: {} } on a true cold start). Reminder for
// consumers that iterate: chats is dual-keyed (relationship id + group
// name), so dedupe by chat.relationship_id.
app.get("/api/chats/last", wrap((req, res) => {
  res.json(telegram.getLastSweep());
}));

// ── New-conversation suggestions ───────────────────────────────────

app.get("/api/suggestions", wrap((req, res) => {
  const s = String(req.query.status || "pending").toLowerCase();
  if (!["pending", "accepted", "dismissed"].includes(s)) {
    throw new HttpError(400, "invalid status; use pending|accepted|dismissed");
  }
  res.json(db.list_suggestions(s));
}));

// Accept = create a tracked relationship from the suggestion (name +
// telegram binding, chat_id included so the first sweep joins exactly),
// then mark it accepted. Relationship creation lives HERE, not in the db
// module — accept is the one cross-domain suggestion action.
app.post("/api/suggestions/:id/accept", wrap((req, res) => {
  const suggestion = db.get_suggestion(idParam(req));
  if (!suggestion || suggestion.status !== "pending") {
    throw new HttpError(404, "Suggestion not found or already actioned");
  }
  const relationship = db.create_relationship({
    name: suggestion.suggestedName || suggestion.telegramGroup,
    telegramGroup: suggestion.telegramGroup,
    telegramChatId: suggestion.telegramChatId,
  });
  db.set_suggestion_status(suggestion.id, "accepted");
  res.status(201).json(relationship);
}));

app.post("/api/suggestions/:id/dismiss", wrap((req, res) => {
  const suggestion = db.get_suggestion(idParam(req));
  if (!suggestion || suggestion.status !== "pending") {
    throw new HttpError(404, "Suggestion not found or already actioned");
  }
  db.set_suggestion_status(suggestion.id, "dismissed");
  res.status(204).end();
}));

// ── Static frontend ────────────────────────────────────────────────
// Serve the built React app (app/dist) so the app is a single origin —
// the frontend's relative /api calls resolve here, with no Vite dev proxy.
app.use(express.static(FRONTEND_DIST));

// ── Error handling: rewrap to {"error": ...} ───────────────────────

// 404 for unmatched routes.
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 204 || status === 304) return res.status(status).end();
  res.status(status).json({ error: err.message || String(err) });
});

// ── endpoint list (printed at startup) ─────────────────────────────

function printEndpointList() {
  console.log("Endpoints:");
  const rows = [
    ["GET", "/api/health", "health check"],
    ["GET", "/api/setup/status", "what's configured (telegram/keys/profile)"],
    ["POST", "/api/setup/keys", "save API keys / Telegram app creds / profile"],
    ["POST", "/api/setup/telegram/send-code", "start Telegram login"],
    ["POST", "/api/setup/telegram/sign-in", "finish Telegram login (code + 2FA)"],
    ["POST", "/api/setup/telegram/logout", "disconnect Telegram"],
    ["GET", "/api/relationships", "list relationships (active + archived)"],
    ["POST", "/api/relationships", "create relationship"],
    ["PATCH", "/api/relationships/<id>", "update relationship"],
    ["DELETE", "/api/relationships/<id>", "delete relationship"],
    ["POST", "/api/relationships/<id>/archive", "archive (queue engine skips it)"],
    ["POST", "/api/relationships/<id>/unarchive", "unarchive"],
    ["POST", "/api/relationships/<id>/draft-reply", "draft a reply (Haiku)"],
    ["POST", "/api/relationships/<id>/send-message", "send a Telegram message"],
    ["GET", "/api/todos[?includeCompleted=]", "list todos"],
    ["POST", "/api/todos", "create a manual todo"],
    ["POST", "/api/todos/reorder", "reorder todos"],
    ["PATCH", "/api/todos/<id>", "update todo"],
    ["DELETE", "/api/todos/<id>", "soft-delete todo"],
    ["POST", "/api/todos/refresh", "extract todos from Telegram + Granola"],
    ["GET", "/api/notes[?relationshipId=]", "list synced notes"],
    ["POST", "/api/notes/sync", "sync Granola notes"],
    ["GET", "/api/followups/queue", "build the follow-up queue (+sweptAt)"],
    ["POST", "/api/followups/snooze", "snooze a queue item"],
    ["POST", "/api/followups/unsnooze", "clear a snooze"],
    ["POST", "/api/followups/extract-promises", "extract promises from the sweep cache"],
    ["GET", "/api/followups/promises[?relationshipId=&status=]", "list promises"],
    ["PATCH", "/api/followups/promises/<id>", "resolve a promise (kept/dropped/open)"],
    ["POST", "/api/followups/cadence/<relationshipId>", "set touch cadence (days)"],
    ["POST", "/api/followups/draft-recap", "draft a meeting recap (Haiku)"],
    ["POST", "/api/chats/sweep", "trigger a Telegram sweep (202, fire-and-forget)"],
    ["GET", "/api/chats/progress", "live progress for the in-flight sweep"],
    ["GET", "/api/chats/last", "last completed sweep ({sweptAt, chats})"],
    ["GET", "/api/suggestions[?status=]", "list new-conversation suggestions"],
    ["POST", "/api/suggestions/<id>/accept", "accept → tracked relationship"],
    ["POST", "/api/suggestions/<id>/dismiss", "dismiss suggestion"],
  ];
  for (const [method, p, desc] of rows) {
    console.log(`  ${method.padEnd(6)} ${p.padEnd(46)} — ${desc}`);
  }
  console.log();
}

module.exports = { app, printEndpointList };
