/* Cadence backend — reply drafting via Anthropic Haiku.
 *
 * Ported from PipeWise drafting.js. Generates Telegram replies in the
 * user's voice using their profile from settings + (optionally) style-guide
 * files from ~/Desktop/voice/ and ~/Desktop/about_me/ (a local power-user
 * convenience — falls back to a generic sensible voice when missing).
 *
 * The deal_block is gone with the deal model: the context block is just
 * name / company / telegram contact (no stage, no amount).
 *
 * The Anthropic SDK is an optional dependency: if it's not installed or no
 * key is configured, _anthropic_create throws an Error with .status = 503
 * (the routes error middleware → HTTP 503).
 *
 * The Anthropic call is routed through module.exports._anthropic_create so
 * the verifier can stub the LLM layer. _build_draft_system_prompt is
 * exported for followups.js's recap drafting — same voice, same rules.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const settings = require("./settings");
const { HAIKU_MODEL } = require("./config");

// Optional dep — only required for the draft-reply endpoint.
let Anthropic = null;
let _HAS_ANTHROPIC = false;
try {
  const pkg = require("@anthropic-ai/sdk");
  Anthropic = pkg.default || pkg.Anthropic || pkg;
  _HAS_ANTHROPIC = true;
} catch (e) {
  _HAS_ANTHROPIC = false;
}

// Optional per-user voice files (read from ~/Desktop/voice and
// ~/Desktop/about_me). When present they get pasted into the system prompt
// to give Haiku a richer sense of the user's voice. Absent → fall back to
// generic sensible defaults. Cached on mtime.
const STYLE_GUIDE_DIRS = [
  path.join(os.homedir(), "Desktop", "voice"),
  path.join(os.homedir(), "Desktop", "about_me"),
];
function _discover_style_guide_files() {
  const files = [];
  for (const dir of STYLE_GUIDE_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (name.toLowerCase().endsWith(".md")) {
          files.push(path.join(dir, name));
        }
      }
    } catch (e) { /* best-effort */ }
  }
  return files;
}

const _style_guide_cache = { mtime: 0, content: "" };

function _load_style_guide() {
  const files = _discover_style_guide_files();
  let latestMtime = 0;
  for (const p of files) {
    try {
      const m = fs.statSync(p).mtimeMs;
      if (m > latestMtime) latestMtime = m;
    } catch (e) {
      /* file missing — fine */
    }
  }
  if (latestMtime <= _style_guide_cache.mtime && _style_guide_cache.content) {
    return _style_guide_cache.content;
  }
  const parts = [];
  for (const p of files) {
    try {
      parts.push(`# From ${path.basename(p)}\n\n${fs.readFileSync(p, "utf8")}`);
    } catch (e) {
      console.log(`[draft] couldn't read ${p}: ${e.message}`);
    }
  }
  const content = parts.join("\n\n");
  _style_guide_cache.mtime = latestMtime;
  _style_guide_cache.content = content;
  return content;
}

function _build_draft_system_prompt() {
  const sg = _load_style_guide();
  const profile = settings.getUserProfile();
  const style_block = sg
    ? sg
    : "No external style guide found. Defaults: short, conversational, " +
      "no formal sign-offs, friendly but professional.";
  const author = profile.contextLine; // e.g. "Alex, BD lead at Acme" or "the user"
  const nameRef = profile.nameRef;    // e.g. "Alex" or "the user"
  return (
    `You are drafting a Telegram reply on behalf of ${author}. ` +
    `Match ${nameRef}'s voice using the style guide below.\n\n` +
    `${style_block}\n\n` +
    "Critical rules:\n" +
    "- Match the language of the most recent incoming message.\n" +
    "- Reference what was actually said — do not write a generic template.\n" +
    `- Keep replies concise. ${nameRef}'s typical message is 1–3 sentences ` +
    "  for routine, 3–6 for substantive replies.\n" +
    "- Never use formal sign-offs like 'Best regards', 'Sincerely', etc.\n" +
    "- Open with 'Hey @[FirstName]' if it's a 1:1 with a known contact, otherwise " +
    "  jump straight in.\n" +
    "- No periods at the end of conversational messages unless writing a longer paragraph.\n\n" +
    `Output ONLY the message text ${nameRef} will send. No quoting, no preamble, ` +
    "no explanation."
  );
}

// Tone presets the frontend can request.
const DRAFT_TONES = {
  default: "Reply naturally to what was said. Keep momentum on the relationship.",
  nudge:
    "Gently nudge — they've been quiet. Friendly, not pushy. " +
    "Reference what was last discussed without sounding annoyed.",
  urgent:
    "Be more direct — this is overdue and needs movement. Still warm " +
    "but make the next ask explicit.",
  quick_ack:
    "Short acknowledgment only. 1 sentence. Confirm receipt or thank " +
    "them for what they sent.",
  propose_meeting:
    "Suggest jumping on a call to move things forward. Offer 2 " +
    "concrete time options if possible.",
};

function _svc503(message) {
  const e = new Error(message);
  e.status = 503;
  return e;
}

// The Anthropic call — the single seam the verifier stubs.
async function _anthropic_create(params) {
  if (!_HAS_ANTHROPIC) {
    throw _svc503(
      "anthropic SDK not installed — run `npm install` in the desktop/ folder."
    );
  }
  const apiKey = settings.getAnthropicKey();
  if (!apiKey) {
    throw _svc503("Anthropic API key not set — add it in Cadence Settings.");
  }
  const client = new Anthropic({ apiKey });
  try {
    return await client.messages.create(params);
  } catch (e) {
    throw _svc503(`Anthropic API call failed: ${e.message}`);
  }
}

// Generate a Telegram reply draft via Haiku. Throws .status=503 if unavailable.
// chatData is the single-chat result from telegram._fetch_single_chat
// ({matched, messages[], …}); a bare messages array is tolerated so callers
// (and the stubbed-LLM verifier) don't have to build the full chat shape.
async function draft_reply(relationship, chatData, instructions = "", tone = "default") {
  const tone_hint = DRAFT_TONES[tone] || DRAFT_TONES.default;
  const profile = settings.getUserProfile();
  const nameRef = profile.nameRef;

  const recent_messages = Array.isArray(chatData)
    ? chatData
    : (chatData || {}).messages || [];

  // Format the conversation, oldest first for natural reading.
  const convo_lines = [];
  for (const m of recent_messages.slice(0, 8).reverse()) {
    const speaker = m.is_me ? `${nameRef} (you)` : m.sender || "Counterparty";
    convo_lines.push(`${speaker}: ${(m.text || "").trim()}`);
  }
  const convo_block = convo_lines.length
    ? convo_lines.join("\n")
    : "(no recent messages)";

  let relationship_block = `Relationship: ${relationship.name}\n`;
  if (relationship.company) {
    relationship_block += `Company: ${relationship.company}\n`;
  }
  const contact = (relationship.telegramChat || {}).contact;
  if (contact) relationship_block += `Telegram contact: ${contact}\n`;

  const extra = instructions
    ? `\nAdditional guidance from ${nameRef}: ${instructions}\n`
    : "";

  const user_prompt =
    `${relationship_block}\n` +
    `Recent Telegram conversation (chronological):\n${convo_block}\n\n` +
    `Tone: ${tone_hint}${extra}\n\n` +
    `Draft the next message ${nameRef} should send.`;

  const resp = await module.exports._anthropic_create({
    model: HAIKU_MODEL,
    max_tokens: 400,
    system: _build_draft_system_prompt(),
    messages: [{ role: "user", content: user_prompt }],
  });

  const textParts = [];
  for (const block of resp.content || []) {
    if (block.type === "text") textParts.push(block.text);
  }
  let draft = textParts.join("\n").trim();
  // Strip wrapping quotes if the model adds them.
  if (
    draft.startsWith('"') &&
    draft.endsWith('"') &&
    (draft.match(/"/g) || []).length === 2
  ) {
    draft = draft.slice(1, -1).trim();
  }
  return draft;
}

module.exports = {
  _HAS_ANTHROPIC,
  DRAFT_TONES,
  _load_style_guide,
  _build_draft_system_prompt,
  _anthropic_create,
  draft_reply,
};
