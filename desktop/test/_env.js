/* Shared test bootstrap — MUST be the first require in every test file.
 *
 * Points the whole backend at a throwaway data dir (config.js reads these
 * env vars at load time) so tests never touch a real Cadence database or
 * settings file, and allows plaintext settings writes — there's no
 * Electron safeStorage under `node --test`.
 *
 * Each test file runs in its own process (node --test), so each gets its
 * own temp dir + fresh SQLite db. Cleanup is left to the OS temp reaper —
 * deleting a live better-sqlite3 file on teardown is flakier than leaving it.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadence-test-"));
process.env.CADENCE_DATA_DIR = dir;
process.env.CADENCE_DB_PATH = path.join(dir, "cadence-test.db");
process.env.CADENCE_ALLOW_PLAINTEXT = "1";

module.exports = { dir };
