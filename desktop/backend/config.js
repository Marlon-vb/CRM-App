/* Cadence backend — configuration constants.
 *
 * Ported from PipeWise config.js, trimmed to what Cadence actually reads
 * (no CoinGecko, no pre-TGE, no seed files — Cadence never seeds).
 *
 * Paths default to the repo's app/ layout for dev; the packaged app
 * overrides them via CADENCE_DATA_DIR / CADENCE_DB_PATH /
 * CADENCE_FRONTEND_DIST, set in desktop/main.js BEFORE the backend loads.
 * Telegram API credentials are NOT here — they're per-user, supplied via
 * in-app onboarding and kept in settings.js.
 */

const path = require("path");

// ── HTTP server port (Vite proxies /api → here) ────────────────────
const PORT = parseInt(process.env.CADENCE_PORT || "3456", 10);

// ── Persistence paths ──────────────────────────────────────────────
// Dev: <repo>/app/data (gitignored). Packaged: Electron userData
// (~/Library/Application Support/Cadence) via the env overrides above.
const DATA_DIR = process.env.CADENCE_DATA_DIR
  ? path.resolve(process.env.CADENCE_DATA_DIR)
  : path.join(__dirname, "..", "..", "app", "data");
const DB_PATH = process.env.CADENCE_DB_PATH
  ? path.resolve(process.env.CADENCE_DB_PATH)
  : path.join(DATA_DIR, "cadence.db");

// ── Built frontend (app/dist) — Express serves it so the app is one origin ──
const FRONTEND_DIST = process.env.CADENCE_FRONTEND_DIST
  ? path.resolve(process.env.CADENCE_FRONTEND_DIST)
  : path.join(__dirname, "..", "..", "app", "dist");

// ── Granola API (meeting notes) ────────────────────────────────────
const GRANOLA_API_BASE =
  process.env.GRANOLA_API_BASE || "https://public-api.granola.ai/v1";

// ── LLM model ──────────────────────────────────────────────────────
// One Haiku model everywhere (reply drafting, todo extraction, promise
// extraction, recap drafting) — import from here, don't re-declare per
// module like PipeWise did.
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// ── Background rhythm ──────────────────────────────────────────────
// The backend owns the Telegram sweep (server.js timer) — this is what
// makes Cadence proactive, and what the iPhone phase requires.
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
// Promise extraction (Haiku) is throttled far below the sweep rhythm —
// at most once per 12h per server run (server.js enforces the throttle).
const PROMISE_EXTRACT_INTERVAL_MS = 12 * 60 * 60 * 1000;

module.exports = {
  PORT,
  DATA_DIR,
  DB_PATH,
  FRONTEND_DIST,
  GRANOLA_API_BASE,
  HAIKU_MODEL,
  SWEEP_INTERVAL_MS,
  PROMISE_EXTRACT_INTERVAL_MS,
};
