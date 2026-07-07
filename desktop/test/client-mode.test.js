/* Client mode — the second-Mac read/act layer. The load-bearing property:
 * a client reads what a hub published and writes ONLY the phone-safe
 * fields, and NEVER pushes (which would clobber the hub). All cloud I/O is
 * stubbed at cloud._fetch (the same seam the publisher tests use).
 */
require("./_env");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const db = require("../backend/db");
db._init_db();
const settings = require("../backend/settings");
const cloud = require("../backend/cloud");
const client = require("../backend/client");
const publisher = require("../backend/publisher");

function signIn() {
  settings.set({
    cloudAccessToken: "tok", cloudRefreshToken: "ref",
    cloudExpiresAt: String(Date.now() + 3600e3),
    cloudUserId: "uid-1", cloudUserEmail: "c@x.com", cloudSyncEnabled: "1",
  });
}
const resp = (status, data) => ({ ok: status < 400, status, json: async () => data });

test("mode flag: isClient/isHub flip on appMode, default hub", () => {
  settings.set({ appMode: "" });
  assert.equal(settings.isHub(), true);
  assert.equal(settings.isClient(), false);
  settings.set({ appMode: "client" });
  assert.equal(settings.isClient(), true);
  assert.equal(settings.status().mode, "client");
  settings.set({ appMode: "hub" });
  assert.equal(settings.isHub(), true);
});

test("client reads the hub's published todos, mapped to frontend dicts", async () => {
  signIn();
  cloud._fetch = async (url) => {
    assert.match(url, /cadence_todos/);
    return resp(200, [
      { local_id: 7, task: "Send deck", relationship_local_id: 3, source: "telegram",
        due_date: "2026-07-08", priority: "high", starred: 1, my_day: 0,
        completed: 0, completed_at: null, deleted: false, sort_order: -2 },
    ]);
  };
  const todos = await client.listTodos();
  assert.equal(todos.length, 1);
  assert.deepEqual(
    { id: todos[0].id, task: todos[0].task, relationshipId: todos[0].relationshipId,
      starred: todos[0].starred, priority: todos[0].priority, completed: todos[0].completed },
    { id: 7, task: "Send deck", relationshipId: 3, starred: true, priority: "high", completed: false }
  );
});

test("client queue: payload becomes items, summary computed, sweptAt surfaced", async () => {
  signIn();
  cloud._fetch = async () => resp(200, [
    { item_key: "reply:3", kind: "reply", urgency: 120, payload: { relationshipName: "Acme", why: "they wrote" }, swept_at: "2026-07-07T10:00:00Z", generated_at: "2026-07-07T10:01:00Z" },
    { item_key: "todo:9", kind: "todo", urgency: 60, payload: { title: "Pay invoice" }, swept_at: "2026-07-07T10:00:00Z", generated_at: "2026-07-07T10:01:00Z" },
  ]);
  const q = await client.listQueue();
  assert.equal(q.items.length, 2);
  assert.equal(q.items[0].key, "reply:3");
  assert.equal(q.items[0].relationshipName, "Acme"); // payload spread through
  assert.equal(q.summary.queueSize, 2);
  assert.equal(q.summary.reply, 1);
  assert.equal(q.summary.etaMinutes, 3 + 2); // reply 3 + todo 2
  assert.equal(q.sweptAt, "2026-07-07T10:00:00Z");
});

test("client patchTodo writes only phone-safe fields to cloud", async () => {
  signIn();
  let captured = null;
  cloud._fetch = async (url, opts) => {
    captured = { url, method: opts.method, body: JSON.parse(opts.body) };
    return resp(204, null);
  };
  await client.patchTodo(7, { completed: true });
  assert.match(captured.url, /cadence_todos\?user_id=eq\.uid-1&local_id=eq\.7/);
  assert.equal(captured.method, "PATCH");
  assert.equal(captured.body.completed, true);
  assert.ok("completed_at" in captured.body, "completed_at set for the hub's Completed section");
  // Must NOT smuggle non-phone-safe fields.
  assert.ok(!("task" in captured.body) && !("relationship_local_id" in captured.body));
});

test("client snooze/unsnooze upsert cadence_snoozes with the cleared tombstone", async () => {
  signIn();
  const calls = [];
  cloud._fetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return resp(204, null); };
  await client.snooze("reply:3", "until", "2026-07-08T09:00:00Z", null);
  await client.unsnooze("reply:3");
  assert.equal(calls[0].cleared, false);
  assert.equal(calls[0].until, "2026-07-08T09:00:00Z");
  assert.equal(calls[1].cleared, true);
});

test("SAFETY: a client never publishes, even signed in with sync enabled", async () => {
  settings.set({ appMode: "client" });
  signIn();
  // If the publisher ran it would hit cloud; make that a hard failure.
  cloud._fetch = async () => { throw new Error("client must never push to cloud"); };
  const r = await publisher.syncNow("test");
  assert.deepEqual(r, { skipped: true }, "publisher no-ops in client mode");
  settings.set({ appMode: "hub" });
});

test("client calls require a signed-in session", async () => {
  settings.set({
    cloudAccessToken: "", cloudRefreshToken: "", cloudUserId: "",
    cloudExpiresAt: "", cloudUserEmail: "",
  });
  await assert.rejects(() => client.listTodos(), /Not signed in/);
});
