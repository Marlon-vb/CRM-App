/* Cadence backend — local API auth token.
 *
 * The Express server on 127.0.0.1:3456 holds every tracked relationship
 * plus a live Telegram session, so "local-only" is not enough: any process
 * running as the same user — or any webpage doing a drive-by fetch to
 * localhost — could otherwise read relationship data and trigger Telegram
 * sends.
 *
 * Defense: a random per-launch bearer token. Generated once when this
 * module loads (backend + Electron main share the process, so main.js and
 * routes.js see the same value). main.js hands it to the renderer via
 * `additionalArguments` → preload → `window.cadence.apiToken`; the
 * frontend sends it back on every /api call as `X-Cadence-Token`.
 *
 * Browser-based dev (Vite on :5173 without Electron) has no preload, so in
 * dev mode the token is printed to the backend console — paste it into
 * localStorage as `cadence-token` once per backend launch.
 */

const crypto = require("crypto");

const TOKEN = crypto.randomBytes(32).toString("hex");

const HEADER = "x-cadence-token";

// Constant-time compare — avoids leaking token prefix via timing.
function isValid(candidate) {
  if (typeof candidate !== "string" || candidate.length !== TOKEN.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(TOKEN));
}

// Express middleware: require the token on every request this is mounted on.
function requireToken(req, res, next) {
  if (isValid(req.get(HEADER))) return next();
  res.status(401).json({ error: "Missing or invalid API token." });
}

module.exports = { TOKEN, HEADER, isValid, requireToken };
