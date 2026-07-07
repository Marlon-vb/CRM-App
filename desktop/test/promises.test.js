/* Promise extraction — the deep feed (audit M7), the sweep-cache fallback
 * with the rel:<id> binding (audit M3), and re-extraction idempotence.
 * The Anthropic call is stubbed at the module.exports._anthropic_create
 * seam, so these run without keys or network.
 */
require("./_env");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const db = require("../backend/db");
db._init_db();
const followups = require("../backend/followups");

const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

let canned = [];
let captured = null;
followups._anthropic_create = async (params) => {
  captured = params;
  return {
    content: [
      { type: "tool_use", name: "record_promises", input: { promises: canned } },
    ],
  };
};

test("M7 deep feed: rel-tagged conversations extracted, untracked skipped, dedupe holds", async () => {
  const acme = db.create_relationship({ name: "Acme", telegramGroup: "acme <> keyrock" });
  const conversations = [
    {
      chat_id: "111",
      chat_name: "acme <> keyrock",
      relationship_id: acme.id,
      messages: [
        { is_me: true, sender: "me", date: iso(1 * HOUR), text: "I'll send the deck tomorrow" },
        { is_me: false, sender: "Bob", date: iso(2 * HOUR), text: "can you share the deck?" },
      ],
    },
    {
      chat_id: "222",
      chat_name: "random untracked room",
      relationship_id: null,
      messages: [
        { is_me: false, sender: "X", date: iso(1 * HOUR), text: "I'll pay you Monday" },
      ],
    },
  ];
  canned = [
    { conversation_index: 0, direction: "mine", text: "Send the deck", due_hint: "tomorrow" },
    { conversation_index: 7, direction: "mine", text: "Out of range — dropped" },
  ];

  const r = await followups.extract_promises({}, conversations);
  assert.equal(r.scanned, 1, "only the rel-tagged conversation is scanned");
  assert.equal(r.inserted, 1);

  const payload = captured.messages[0].content;
  assert.match(payload, /acme <> keyrock/, "chat name rides the payload");
  assert.ok(!payload.includes("I'll pay you Monday"), "untracked chat excluded");

  const rows = db.list_fu_promises(acme.id, "open");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "Send the deck");
  assert.equal(rows[0].dueHint, "tomorrow");

  // Re-extraction is idempotent — UNIQUE(user_id, relationship_id, text).
  const again = await followups.extract_promises({}, conversations);
  assert.equal(again.inserted, 0, "re-run inserts nothing");
});

test("M3 fallback: sweep cache binds DM-only clients via rel:<id>", async () => {
  const dana = db.create_relationship({ name: "Dana" }); // no primary binding
  const telegramData = {
    [`rel:${dana.id}`]: {
      matched: true,
      activeChatName: "Dana DM",
      messages: [
        { is_me: false, sender: "Dana", date: iso(2 * HOUR), text: "I'll intro you to our CTO" },
      ],
    },
  };
  canned = [{ conversation_index: 0, direction: "theirs", text: "Intro to the CTO" }];

  // conversations=[] → deep feed yielded nothing → sweep-cache fallback.
  const r = await followups.extract_promises(telegramData, []);
  assert.equal(r.scanned, 1);
  assert.equal(r.inserted, 1);
  assert.match(captured.messages[0].content, /Dana/);

  const rows = db.list_fu_promises(dana.id, "open");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, "theirs");
});

test("no feed at all → clean zero, no LLM call", async () => {
  captured = null;
  canned = [];
  const r = await followups.extract_promises({}, []);
  assert.deepEqual(r, { inserted: 0, scanned: 0 });
  assert.equal(captured, null, "Anthropic never called with nothing to scan");
});

test("deep-fetch failure falls back to the cache instead of throwing", async () => {
  // conversations=null → extract_promises tries the live Telegram feed;
  // in this environment connect() fails (nothing configured) and the
  // catch must route to the sweep-cache path, not blow up the cycle.
  const rel = db.create_relationship({ name: "FallbackCo", telegramGroup: "fallbackco" });
  const telegramData = {
    fallbackco: {
      matched: true,
      messages: [
        { is_me: true, sender: "me", date: iso(1 * HOUR), text: "I'll send terms tonight" },
      ],
    },
  };
  canned = [{ conversation_index: 0, direction: "mine", text: "Send terms" }];
  const r = await followups.extract_promises(telegramData, null);
  assert.equal(r.scanned, 1, "cache fallback scanned the bound chat");
  assert.equal(r.inserted, 1);
  assert.equal(db.list_fu_promises(rel.id, "open").length, 1);
});
