/* Cloud publisher cycle against a stubbed cloud._fetch (the module's
 * designated stub seam — no network, no Supabase). Covers the audit-M2
 * clobber-window guard, cursor semantics, and 401 session-death handling.
 */
require("./_env");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const db = require("../backend/db");
db._init_db();
const settings = require("../backend/settings");
const cloud = require("../backend/cloud");
const publisher = require("../backend/publisher");

const DAY = 24 * 3600 * 1000;

function signIn() {
  settings.set({
    cloudAccessToken: "test-access",
    cloudRefreshToken: "test-refresh",
    cloudExpiresAt: String(Date.now() + 3600 * 1000),
    cloudUserId: "uid-test",
    cloudUserEmail: "test@example.com",
    cloudSyncEnabled: "1",
  });
}

const resp = (status, data = null) => ({
  ok: status < 400,
  status,
  json: async () => data,
});

test("M2: a phone snooze racing the push is absorbed, not tombstoned", async () => {
  signIn();
  const phoneSnooze = {
    item_key: "reply:42",
    mode: "until",
    until: new Date(Date.now() + 1 * DAY).toISOString(),
    last_inbound_at: null,
    cleared: false,
    updated_at: new Date().toISOString(),
  };

  const calls = [];
  let snoozeGets = 0;
  cloud._fetch = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    calls.push({
      url: decodeURIComponent(url),
      method,
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    if (!url.includes("/rest/v1/")) return resp(200, {});
    const table = url.split("/rest/v1/")[1].split("?")[0];
    if (method === "GET") {
      if (table === "cadence_snoozes") {
        snoozeGets += 1;
        // The phone writes reply:42 AFTER this cycle's opening PULL but
        // before PUSH reaches the destructive steps — it becomes visible
        // from the second (pre-destructive re-pull) read onward.
        return resp(200, snoozeGets >= 2 ? [phoneSnooze] : []);
      }
      return resp(200, []);
    }
    if (method === "POST") return resp(201, null); // upserts, return=minimal
    return resp(204, null); // PATCH tombstone / DELETE queue cleanup
  };

  const r = await publisher.syncNow("test");
  assert.equal(r.ok, true, `sync succeeded (${r.error || "ok"})`);

  // Absorbed locally by the re-pull that runs before the destructive steps…
  assert.ok(db.list_fu_snoozes()["reply:42"], "racing phone snooze applied locally");

  // …so the stale-snooze tombstone sweep excludes it…
  const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("cadence_snoozes"));
  assert.ok(patch, "tombstone PATCH ran");
  assert.ok(patch.url.includes('"reply:42"'), "racing snooze excluded from tombstoning");

  // …and the authoritative snooze push includes it.
  const post = calls
    .filter((c) => c.method === "POST" && c.url.includes("cadence_snoozes"))
    .pop();
  assert.ok(post && post.body.some((row) => row.item_key === "reply:42"));

  // Cursor advances only from pulled rows — exactly to the phone edit.
  assert.equal(db._meta_get("cloud_pull_cursor"), phoneSnooze.updated_at);

  db.clear_fu_snooze("reply:42");
});

test("dead session: 401 clears the session and reports a re-auth error", async () => {
  signIn();
  cloud._fetch = async (url) => {
    if (url.includes("/auth/v1/")) {
      // Refresh attempt with a dead refresh token.
      return resp(401, { error_description: "Invalid Refresh Token" });
    }
    return resp(401, { message: "JWT expired" });
  };

  const r = await publisher.syncNow("test");
  assert.equal(r.ok, false);
  assert.match(r.error, /Session expired/);
  assert.equal(cloud.isSignedIn(), false, "session cleared so Settings shows sign-in");
});

test("signed out: the cycle no-ops instead of erroring", async () => {
  cloud._fetch = async () => {
    throw new Error("network must not be touched when signed out");
  };
  const r = await publisher.syncNow("test");
  assert.deepEqual(r, { skipped: true });
});
