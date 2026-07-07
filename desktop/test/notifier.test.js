/* Pulse bridge — notification diffing policy (audit C3). Electron-free by
 * design, so it tests without any stubbing beyond the registered hooks.
 */
require("./_env");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const notifier = require("../backend/notifier");

const item = (key, kind, name) => ({ key, kind, relationshipName: name, why: "w" });
const q = (...items) => ({ items });

let sent = [];
let badges = [];
notifier.setNotifier((n) => sent.push(n));
notifier.setBadge((c) => badges.push(c));

test("first observe seeds silently, later diffs notify new reply/recap only", () => {
  sent = []; badges = [];
  const r1 = notifier.observe(q(item("reply:1", "reply", "Acme"), item("cold:2", "cold", "ColdCo")));
  assert.equal(r1.notified, 0, "launch never re-announces the existing queue");
  assert.deepEqual(badges, [2], "badge reflects the full count immediately");

  // Same queue again — nothing new, nothing fires.
  const r2 = notifier.observe(q(item("reply:1", "reply", "Acme"), item("cold:2", "cold", "ColdCo")));
  assert.equal(r2.notified, 0);

  // A new reply arrives; a new cold card also appears but must stay quiet.
  const r3 = notifier.observe(q(
    item("reply:1", "reply", "Acme"),
    item("reply:3", "reply", "Dana"),
    item("cold:4", "cold", "QuietCo")
  ));
  assert.equal(r3.notified, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /Reply owed — Dana/);
});

test("multiple fresh items collapse into one summary notification", () => {
  sent = [];
  notifier.observe(q()); // reset the seen set via an empty build
  const r = notifier.observe(q(
    item("reply:10", "reply", "A"),
    item("recap:11", "recap", "B"),
    item("reply:12", "reply", "C")
  ));
  assert.equal(r.notified, 3);
  assert.equal(sent.length, 1, "one notification, not three");
  assert.match(sent[0].title, /3 new in your queue/);
  assert.match(sent[0].body, /A, B, C/);
});

test("hooks are optional — observe never throws headless", () => {
  notifier.setNotifier(null);
  notifier.setBadge(null);
  assert.doesNotThrow(() => notifier.observe(q(item("reply:20", "reply", "X"))));
  notifier.setNotifier((n) => sent.push(n));
  notifier.setBadge((c) => badges.push(c));
});
