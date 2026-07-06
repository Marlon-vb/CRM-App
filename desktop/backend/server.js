/* Cadence backend — server entrypoint.
 *
 * Ported from PipeWise server.js. Boots the Express app (routes.js) on
 * port 3456 — the port the Vite dev proxy and the Electron shell expect.
 *
 * The big structural change from PipeWise: the backend owns the Telegram
 * rhythm now. After startup this file
 *   1. loads the persisted sweep cache (warm start),
 *   2. fires an initial sweep if that cache is stale (> SWEEP_INTERVAL_MS),
 *   3. re-sweeps every SWEEP_INTERVAL_MS on a timer, and
 *   4. after each successful sweep, best-effort runs todo extraction (its
 *      30-min in-process cache self-throttles) and promise extraction
 *      (throttled here to once per PROMISE_EXTRACT_INTERVAL_MS per run).
 * Every background step is wrapped so failures log and never crash the
 * loop — a fresh install with no Telegram configured just idles quietly
 * until onboarding completes, and the next tick picks it up.
 *
 * Like PipeWise it does NOT hard-exit when Telegram is unavailable — the
 * server must still come up and serve the DB-backed routes.
 */

const { PORT, DB_PATH, SWEEP_INTERVAL_MS, PROMISE_EXTRACT_INTERVAL_MS } =
  require("./config");
const db = require("./db");
const settings = require("./settings");
const telegram = require("./telegram");
const todos = require("./todos");
const followups = require("./followups");
const drafting = require("./drafting");
const granola = require("./granola");
const { app, printEndpointList } = require("./routes");

// ── background sweep loop ──────────────────────────────────────────

// Promise extraction (Haiku) runs far below the sweep rhythm — at most one
// ATTEMPT per PROMISE_EXTRACT_INTERVAL_MS per server run. Stamped at attempt
// time (not success) so a missing key doesn't retry every 30 minutes.
let _lastPromiseExtractAt = 0;
let _sweepTimer = null;

// One sweep cycle: sweep, then the post-sweep extractions. Never throws —
// every step logs its own failure and the loop lives on.
async function _runSweepCycle(reason) {
  // Not configured yet (fresh install, mid-onboarding) — idle quietly.
  // The interval re-checks settings each tick, so finishing onboarding
  // is picked up without a restart.
  if (!settings.status().telegram) return;
  // Guard: the on-demand route (or a slow previous tick) may already be
  // sweeping. sweep()'s own flag closes the check-then-fire race.
  if (telegram.isSweeping()) return;

  let result;
  try {
    result = await telegram.sweep();
  } catch (e) {
    console.error(`[sweep] ${reason} sweep failed: ${e.message}`);
    return;
  }
  if (!result || result.alreadyRunning) return;

  // chats is dual-keyed (relationship id + group name) — dedupe for the log.
  const chatCount = new Set(
    Object.values(result.chats).map((c) => c.relationship_id)
  ).size;
  console.log(
    `[sweep] ${reason} sweep complete — ${chatCount} tracked chat(s), ` +
      `${result.newSuggestions.length} new suggestion(s)`
  );

  // Todo extraction — its 30-minute in-process cache means back-to-back
  // sweeps (manual + timer) don't double-bill the LLM.
  try {
    const r = await todos.extract_todos();
    if (!r.cached) {
      console.log(
        `[todos] extracted ${r.extracted} candidate(s) from ${r.scanned} chat(s)`
      );
    }
  } catch (e) {
    console.error(`[todos] post-sweep extraction failed: ${e.message}`);
  }

  // Promise extraction — throttled to once per interval per server run.
  if (Date.now() - _lastPromiseExtractAt >= PROMISE_EXTRACT_INTERVAL_MS) {
    _lastPromiseExtractAt = Date.now();
    try {
      const r = await followups.extract_promises(telegram.getLastSweep().chats);
      console.log(
        `[promises] ${r.inserted} new promise(s) across ${r.scanned} chat(s)`
      );
    } catch (e) {
      console.error(`[promises] post-sweep extraction failed: ${e.message}`);
    }
  }
}

// Warm start → initial sweep if stale → steady-state timer. The initial
// sweep is fire-and-forget so startup (and the Electron window) never
// waits on Telegram.
function _startSweepLoop() {
  // Idempotent explicit load — telegram.js also does this at module init,
  // but startup owns the decision below, so it re-reads deliberately.
  telegram.loadCachedSweep();

  const { sweptAt } = telegram.getLastSweep();
  const age = sweptAt ? Date.now() - new Date(sweptAt).getTime() : Infinity;
  if (age > SWEEP_INTERVAL_MS) {
    if (settings.status().telegram) {
      console.log(
        sweptAt
          ? `[sweep] cache is ${Math.round(age / 60000)}min old — sweeping now`
          : "[sweep] no cached sweep — sweeping now"
      );
    }
    // Fire-and-forget. The cycle catches its own errors; this catch is
    // belt-and-braces so an unexpected rejection can't kill the process.
    _runSweepCycle("initial").catch((e) =>
      console.error(`[sweep] initial cycle error: ${e.message}`)
    );
  } else {
    console.log(
      `[sweep] cache is fresh (${Math.round(age / 60000)}min old) — ` +
        `next sweep on the timer`
    );
  }

  _sweepTimer = setInterval(() => {
    _runSweepCycle("scheduled").catch((e) =>
      console.error(`[sweep] scheduled cycle error: ${e.message}`)
    );
  }, SWEEP_INTERVAL_MS);

  // Route-triggered sweeps (client added / suggestion accepted / on-demand)
  // run the same full cycle — sweep plus post-sweep extraction — instead of
  // a bare sweep, so a freshly added client gets todos and promises too.
  telegram.setSweepRunner(() =>
    _runSweepCycle("client-triggered").catch((e) =>
      console.error(`[sweep] client-triggered cycle error: ${e.message}`)
    )
  );
}

// ── startup ────────────────────────────────────────────────────────

async function startup() {
  console.log(`[DB] Opening ${DB_PATH}`);
  db._init_db(); // no seeding — Cadence boots empty by design

  // Soft dependency notes — these only affect specific endpoints.
  if (!drafting._HAS_ANTHROPIC) {
    console.log("[deps] anthropic SDK not installed — drafting/extraction return 503.");
  } else if (!settings.getAnthropicKey()) {
    console.log("[deps] no Anthropic key configured — drafting/extraction return 503 until set in Settings.");
  }
  if (!granola.hasKey()) {
    console.log("[deps] no Granola key configured — Granola sync stays off until set in Settings.");
  }

  // Telegram connect — best-effort. A failure (not configured, expired
  // session) is logged and the server still serves the DB-backed routes;
  // the sweep loop below re-checks settings on every tick.
  if (settings.status().telegram) {
    console.log("Connecting to Telegram...");
    try {
      await telegram.connect();
    } catch (e) {
      console.error(`[telegram] connect failed: ${e.message}`);
    }
  } else {
    console.log("[telegram] not configured — connect it in Settings (or onboarding).");
  }

  // The backend-owned Telegram rhythm: warm start, initial sweep if stale,
  // then the 30-minute timer. This is what makes Cadence proactive.
  _startSweepLoop();
}

// Start the backend: run startup, then listen. Resolves with the http.Server
// once it's accepting connections; rejects on failure (e.g. port in use).
// Electron's main process (main.js) calls this; so does standalone mode below.
function start() {
  return startup().then(
    () =>
      new Promise((resolve, reject) => {
        const server = app.listen(PORT, "127.0.0.1", () => {
          console.log(`Cadence API server running on http://localhost:${PORT}`);
          // Dev only: surface the per-launch API token so browser-based
          // frontend dev (Vite without Electron's preload) can paste it
          // into localStorage as `cadence-token`. Packaged builds stay
          // silent — the renderer gets it via preload.
          if (!process.env.CADENCE_PACKAGED) {
            const auth = require("./auth");
            console.log(`[auth] API token (dev): ${auth.TOKEN}`);
          }
          printEndpointList();
          resolve(server);
        });
        server.on("error", (err) => {
          if (err.code === "EADDRINUSE") {
            console.error(
              `\nPort ${PORT} is already in use — another Cadence backend ` +
                `is still running.`
            );
            console.error(`Free it with:  lsof -ti tcp:${PORT} | xargs kill`);
          }
          reject(err);
        });
      })
  );
}

// Best-effort teardown: stop the sweep timer and disconnect Telegram (the
// live client AND any half-finished login client). Does NOT exit the
// process — the caller (standalone signal handler, or Electron's
// will-quit) owns the lifecycle.
async function shutdown() {
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
  try {
    await telegram.shutdown();
  } catch (e) {
    /* best-effort */
  }
}

module.exports = { start, shutdown };

// Standalone mode: `node backend/server.js` (vs. being require()d by main.js).
if (require.main === module) {
  start().catch((err) => {
    console.error("Startup failed:", err.message || err);
    process.exit(1);
  });
  const onSignal = () => {
    console.log("\nShutting down...");
    shutdown().finally(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}
