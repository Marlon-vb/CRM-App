/* safeSlice — the surrogate-pair regression (July 2026): truncating chat
 * text with bare .slice() split an emoji in half, the lone surrogate made
 * the request body invalid JSON, and Anthropic 400'd every todo extraction.
 */
require("./_env");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { safeSlice } = require("../backend/strings");
const followups = require("../backend/followups");
const db = require("../backend/db");
db._init_db();

test("a cut landing mid-emoji leaves a well-formed string", () => {
  // "💰" is U+1F4B0 — two UTF-16 units. Slicing at 400 lands between them.
  const text = "x".repeat(399) + "💰 and more text";
  const out = safeSlice(text, 400);
  assert.ok(out.isWellFormed(), "no lone surrogate survives");
  assert.equal(out.length <= 400, true);
  // Round-trips as real JSON — the property the Anthropic API enforces.
  assert.equal(JSON.parse(JSON.stringify(out)), out);
});

test("clean cuts and short strings pass through untouched", () => {
  assert.equal(safeSlice("hello 💰 world", 100), "hello 💰 world");
  assert.equal(safeSlice("abcdef", 3), "abc");
  assert.equal(safeSlice(null, 10), "");
  assert.equal(safeSlice(undefined, 10), "");
});

test("promise-extraction payload stays well-formed with emoji at the cut", async () => {
  const rel = db.create_relationship({ name: "EmojiCo", telegramGroup: "emojico" });
  let captured = null;
  followups._anthropic_create = async (params) => {
    captured = params;
    return { content: [{ type: "tool_use", name: "record_promises", input: { promises: [] } }] };
  };
  const conversations = [{
    chat_id: "9",
    chat_name: "emojico",
    relationship_id: rel.id,
    messages: [{
      is_me: true, sender: "me", date: new Date().toISOString(),
      text: "y".repeat(399) + "🔥 I'll send the deck",
    }],
  }];
  await followups.extract_promises({}, conversations);
  assert.ok(captured, "extraction ran");
  assert.ok(captured.messages[0].content.isWellFormed(), "payload is valid Unicode end to end");
});
