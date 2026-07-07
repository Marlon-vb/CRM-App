/* Queue engine — the states and snooze semantics AUDIT.md says must not
 * regress. Runs against a real (temp) SQLite db + injected telegramData,
 * the same harness shape build_queue was live-verified with at build time.
 */
require("./_env");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const db = require("../backend/db");
db._init_db();
const followups = require("../backend/followups");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
// SQLite CURRENT_TIMESTAMP shape ("YYYY-MM-DD HH:MM:SS", UTC) for direct
// column writes in fixtures.
const sqliteTs = (msAgo) => iso(msAgo).replace("T", " ").slice(0, 19);

// A sweep-cache chat entry (the _lastSweep.chats value shape).
function chat(over = {}) {
  const last =
    over.last_message ||
    { date: iso(2 * HOUR), is_me: false, text: "any update?", sender: "Bob" };
  return {
    matched: true,
    waiting_on: "me",
    last_message: last,
    messages: [last],
    action_summary: null,
    chat_id: "1001",
    chat_name: "room",
    chatCount: 1,
    ...over,
  };
}

const build = (telegramData) => followups.build_queue({ telegramData });
const find = (q, key) => q.items.find((i) => i.key === key);

test("reply owed: inbound last → reply card with human-scale age", () => {
  const rel = db.create_relationship({ name: "Acme", telegramGroup: "acme <> keyrock" });
  const q = build({ "acme <> keyrock": chat() });
  const item = find(q, `reply:${rel.id}`);
  assert.ok(item, "reply card exists");
  assert.equal(item.kind, "reply");
  assert.match(item.why, /Bob wrote 2h ago/);
  assert.equal(item.activeChatId, "1001");
  assert.ok(q.summary.reply >= 1);
});

test("M3: DM-only client binds via the rel:<id> cache key", () => {
  const rel = db.create_relationship({ name: "Dana" }); // no primary binding
  const q = build({
    [`rel:${rel.id}`]: chat({
      activeChatId: "9009",
      activeChatName: "Dana DM",
      last_message: { date: iso(3 * HOUR), is_me: false, text: "hey!", sender: "Dana" },
    }),
  });
  const item = find(q, `reply:${rel.id}`);
  assert.ok(item, "DM-only client reaches reply detection");
  assert.equal(item.activeChatId, "9009");
  assert.equal(item.activeChatName, "Dana DM");
});

test("recap outranks reply for the same relationship", () => {
  const rel = db.create_relationship({ name: "MeetCo", telegramGroup: "meetco room" });
  const noteId = db
    .getDb()
    .prepare(
      `INSERT INTO notes (granola_id, title, summary, relationship_id, meeting_date)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run("g-test-recap", "MeetCo sync", "Agreed next steps.", rel.id, iso(2 * HOUR))
    .lastInsertRowid;
  // Inbound after the meeting, no outbound after it → recap due AND reply
  // owed; strict priority keeps only the recap card.
  const q = build({
    "meetco room": chat({
      last_message: { date: iso(1 * HOUR), is_me: false, text: "thanks!", sender: "Ana" },
    }),
  });
  assert.ok(find(q, `recap:${noteId}`), "recap card exists");
  assert.equal(find(q, `reply:${rel.id}`), undefined, "reply card suppressed");
  db.getDb().prepare("DELETE FROM notes WHERE id = ?").run(noteId);
});

test("cold: silence beyond cadence, even when waiting on them", () => {
  const rel = db.create_relationship({ name: "ColdCo", telegramGroup: "coldco" });
  const q = build({
    coldco: chat({
      waiting_on: "them",
      last_message: { date: iso(20 * DAY), is_me: true, text: "sent!", sender: null },
    }),
  });
  const item = find(q, `cold:${rel.id}`);
  assert.ok(item, "cold card exists");
  assert.match(item.why, /20d silent — cadence is 14d/);
});

test("M9: never-contacted client goes cold measured from created_at", () => {
  const ghost = db.create_relationship({ name: "Ghost" });
  const fresh = db.create_relationship({ name: "Fresh" });
  db.getDb()
    .prepare("UPDATE relationships SET created_at = ? WHERE id = ?")
    .run(sqliteTs(20 * DAY), ghost.id);
  const q = build({});
  const item = find(q, `cold:${ghost.id}`);
  assert.ok(item, "20d-old never-contacted client is cold");
  assert.match(item.why, /No contact recorded/);
  assert.equal(find(q, `cold:${fresh.id}`), undefined, "just-added client is not cold");
});

test("snooze 'until' hides the card until it lapses", () => {
  const rel = db.create_relationship({ name: "SnoozeCo", telegramGroup: "snoozeco" });
  const data = { snoozeco: chat() };
  const key = `reply:${rel.id}`;
  db.set_fu_snooze(key, "until", iso(-1 * DAY)); // until tomorrow
  assert.equal(find(build(data), key), undefined, "hidden while snoozed");
  db.set_fu_snooze(key, "until", iso(1 * HOUR)); // lapsed an hour ago
  assert.ok(find(build(data), key), "resurfaces after the until passes");
  db.clear_fu_snooze(key);
});

test("snooze 'after_reply': hidden while silent, resurfaces on new inbound, 7-day failsafe", () => {
  const rel = db.create_relationship({ name: "WaitCo", telegramGroup: "waitco" });
  const key = `reply:${rel.id}`;
  const oldInbound = { date: iso(5 * HOUR), is_me: false, text: "ping", sender: "Max" };
  db.set_fu_snooze(key, "after_reply", null, oldInbound.date); // snapshot = current inbound

  const silent = { waitco: chat({ last_message: oldInbound }) };
  assert.equal(find(build(silent), key), undefined, "hidden while nothing new arrived");

  const newInbound = { waitco: chat({ last_message: { date: iso(1 * HOUR), is_me: false, text: "so?", sender: "Max" } }) };
  assert.ok(find(build(newInbound), key), "resurfaces once a new inbound lands");

  // Failsafe: still silent, but the snooze is 8 days old → resurface anyway.
  db.set_fu_snooze(key, "after_reply", null, oldInbound.date);
  db.getDb()
    .prepare("UPDATE followup_snoozes SET created_at = ? WHERE item_key = ?")
    .run(sqliteTs(8 * DAY), key);
  assert.ok(find(build(silent), key), "failsafe resurfaces after 7 days of silence");
  db.clear_fu_snooze(key);
});

test("M1: re-snoozing (publisher re-apply) preserves created_at", () => {
  const key = "reply:99999";
  db.set_fu_snooze(key, "after_reply", null, iso(5 * HOUR));
  db.getDb()
    .prepare("UPDATE followup_snoozes SET created_at = '2020-01-01 00:00:00' WHERE item_key = ?")
    .run(key);
  // The cloud publisher re-applies pulled snoozes with (possibly changed)
  // values — the conflict path must keep the original failsafe anchor.
  const newSnapshot = iso(1 * HOUR);
  db.set_fu_snooze(key, "after_reply", null, newSnapshot);
  const row = db.getDb()
    .prepare("SELECT created_at, last_inbound_at FROM followup_snoozes WHERE item_key = ?")
    .get(key);
  assert.equal(row.created_at, "2020-01-01 00:00:00", "created_at untouched on conflict");
  assert.equal(row.last_inbound_at, newSnapshot, "values still update in place");
  db.clear_fu_snooze(key);
});

test("standalone todo due today surfaces as its own card", () => {
  const today = new Date().toISOString().slice(0, 10);
  const todo = db.create_todo({ task: "Pay the invoice", dueDate: today });
  const item = find(build({}), `todo:${todo.id}`);
  assert.ok(item, "due-today todo surfaces");
  assert.equal(item.kind, "todo");
  assert.match(item.why, /Due today|Overdue/);
  db.delete_todo(todo.id);
});

test("bundle: a reply card absorbs open todos and overdue promises", () => {
  const rel = db.create_relationship({ name: "BundleCo", telegramGroup: "bundleco" });
  const todo = db.create_todo({ task: "Send the deck", relationshipId: rel.id });
  db.upsert_fu_promises([
    { relationshipId: rel.id, direction: "mine", text: "Share redlines", promisedAt: iso(5 * DAY) },
  ]);
  const q = build({ bundleco: chat() });
  const item = find(q, `reply:${rel.id}`);
  assert.ok(item, "reply card exists");
  const kinds = item.bundle.map((b) => b.type).sort();
  assert.deepEqual(kinds, ["promise", "todo"], "bundle carries both");
  assert.ok(q.summary.openPromisesMine >= 1);
  db.delete_todo(todo.id);
});
