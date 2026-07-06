/* Cadence desktop — preload script.
 *
 * Runs before the renderer (the React app) loads, with access to a limited
 * Node API. It is the secure bridge for exposing native capabilities to the
 * frontend via contextBridge.
 *
 * Currently bridges exactly one thing: the per-launch local-API auth token
 * (see backend/auth.js). main.js passes it via webPreferences
 * additionalArguments — the only channel that works under `sandbox: true`,
 * where preload cannot require() backend modules. The frontend reads
 * window.cadence.apiToken and sends it as X-Cadence-Token on every
 * /api call.
 */

const { contextBridge } = require("electron");

const tokenArg = process.argv.find((a) => a.startsWith("--cadence-token="));
const apiToken = tokenArg ? tokenArg.slice("--cadence-token=".length) : "";

contextBridge.exposeInMainWorld("cadence", { apiToken });
