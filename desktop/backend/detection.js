/* Cadence backend — auto-detection rules.
 *
 * Ported from PipeWise detection.js, reduced to the single detector Cadence
 * keeps: the new-conversation signal. The four pipeline detectors
 * (post-meeting, compliance sent, contract sent, proposal PDF) existed to
 * feed deal stage auto-moves — they're gone with the pipeline itself.
 *
 * Pure function that scans recent Telegram messages and flags first-exchange
 * intent ("let's jump on a call", "kunnen we bellen", "lass uns sprechen").
 * No HTTP, no DB — telegram.js calls this per unknown dialog during the
 * sweep and turns hits into neutral `suggestions` rows (accept → tracked
 * relationship). No stage, no deal payload.
 *
 * Multi-language patterns (English / Dutch / German), unchanged from the
 * original Python→Node port: Python's re.IGNORECASE maps to the JS `i`
 * flag; \b, non-greedy {n,m}? and alternation behave the same. Only
 * truthiness of a match is tested, so `.test()` is used.
 */

const { safeSlice } = require("./strings");

// ── Trigger phrases (multi-language) ───────────────────────────────

// New-conversation qualifying language. Hits trigger a Suggestion (not a
// tracked relationship — the user accepts or dismisses from the queue rail).
const NEW_CONVERSATION_PATTERNS = [
  /\b(let'?s|happy to|would love to|i'?d love to|keen to)\s+.{0,30}?(connect|chat|jump on a call|book a meeting|schedule a call|set up a call|talk|sync|catch up|grab time)\b/i,
  /\b(can we|could we|are you free|do you have time|got time|available)\s+.{0,30}?(connect|chat|jump on|talk|sync|meet|catch up|for a call|for a chat)\b/i,
  /\b(jump on a call|book a meeting|schedule a call|hop on a call|set up a call|hop on a quick call|grab a coffee|grab coffee)\b/i,
  /\b(would love to discuss|interested in exploring|interested in market making|would love to learn more about)\b/i,
  /\b(laten we|kunnen we|zullen we)\s+.{0,30}?(bellen|afspreken|praten|skypen|videobellen)\b/i,
  /\b(graag eens|even)\s+.{0,30}?(sparren|praten|bellen|afstemmen)\b/i,
  /\b(afspraak|gesprek|call)\s+(inplannen|maken|hebben|opzetten)\b/i,
  /\b(lass uns|können wir|sollen wir)\s+.{0,30}?(sprechen|telefonieren|reden|treffen|callen)\b/i,
  /\b(termin|gespräch|call)\s+(vereinbaren|finden|aufsetzen|machen)\b/i,
  /\b(würde|möchte)\s+(gerne|gern)\s+.{0,30}?(sprechen|austauschen|kennenlernen)\b/i,
];

// Negative filter — kills false positives where "connect" means social-media.
const CONNECT_NEGATIVE =
  /\b(linkedin|twitter|on x\b|on insta|instagram|whatsapp|telegram\s+later|on social)\b/i;

// ── Detection function ─────────────────────────────────────────────

/* Return {matched, firstMessage, messageCount} if the messages contain a
   new-conversation trigger, else null.
   'First exchange' filter: only fires when the chat has <= 10 messages.
   firstMessage is the trigger message's text (200-char capped) — the
   evidence line the suggestion card shows. */
function detect_new_conversation_signal(messages) {
  if (!messages || messages.length === 0) return null;
  if (messages.length > 10) return null;

  for (const m of messages) {
    const text = m.text || "";
    if (!text || text === "[media]") continue;
    if (CONNECT_NEGATIVE.test(text)) continue;
    for (const pattern of NEW_CONVERSATION_PATTERNS) {
      if (pattern.test(text)) {
        return {
          matched: true,
          firstMessage: safeSlice(text, 200),
          messageCount: messages.length,
        };
      }
    }
  }
  return null;
}

// ── client-name detection (room-name convention + Granola) ─────────

// Shared normalizer for name comparisons — lowercase alnum only, so
// "Acme Corp." / "acme-corp" / "ACME corp" all collapse to "acmecorp".
function normalize_name(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Deal-room naming convention: "<us> <> <them>" (either order). The company
// comes from the user's Settings profile — NOT hardcoded (the PipeWise
// 'keyrock' literal was a documented trap). Exactly one side must contain
// the company, so "Acme <> Beta" (neither) and "Us <> Us" (both) don't fire.
const PAIR_TITLE_RE = /^(.*?)\s*<>\s*(.*)$/;

function parse_pair_title(title, company) {
  const compNorm = normalize_name(company);
  if (compNorm.length < 3) return null; // no/short company set — tier off
  const m = PAIR_TITLE_RE.exec(String(title || "").trim());
  if (!m) return null;
  const left = m[1].trim();
  const right = m[2].trim();
  const isUs = (side) => normalize_name(side).includes(compNorm);
  const leftUs = isUs(left);
  if (leftUs === isUs(right)) return null;
  const counterparty = leftUs ? right : left;
  return counterparty.length >= 2 ? counterparty : null;
}

// Freemail / ISP domain labels that never identify a client company.
const FREEMAIL_LABELS = new Set([
  "gmail", "googlemail", "outlook", "hotmail", "live", "msn", "yahoo",
  "ymail", "icloud", "me", "mac", "proton", "protonmail", "pm", "hey",
  "aol", "gmx", "web", "mail", "email", "fastmail", "zoho", "qq", "163",
  "126", "yandex", "t-online", "orange", "free", "wanadoo", "btinternet",
]);

// First label of an email's domain: "jane@mm.acme.com" → "mm" is wrong more
// rarely than "acme.com" → "acme" is right — company mail is overwhelmingly
// flat (name@company.tld), so the first label is the pragmatic choice.
function _domain_label(email) {
  const parts = String(email || "").toLowerCase().trim().split("@");
  if (parts.length !== 2 || !parts[1]) return null;
  return parts[1].split(".")[0] || null;
}

// Meeting-title descriptors that follow the client name ("Keyrock <> Acme
// weekly sync") — stripped word-by-word from the end so the suggestion says
// "Acme", not "Acme weekly sync". Telegram room names are NOT stripped:
// suffixes there ("Acme MM", "Acme OTC") tend to be part of the room's
// identity and the user can edit the name on accept anyway.
const MEETING_DESCRIPTORS = new Set([
  "weekly", "biweekly", "monthly", "quarterly", "daily", "sync", "call",
  "meeting", "meet", "catchup", "catch-up", "checkin", "check-in", "intro",
  "introduction", "kickoff", "kick-off", "standup", "review", "followup",
  "follow-up", "session", "chat", "update", "touchpoint", "1:1", "11",
  "debrief", "demo", "onboarding",
]);

function _strip_meeting_descriptors(name) {
  const words = String(name || "").trim().split(/\s+/);
  while (
    words.length > 1 &&
    MEETING_DESCRIPTORS.has(words[words.length - 1].toLowerCase().replace(/[^\w:-]/g, ""))
  ) {
    words.pop();
  }
  return words.join(" ");
}

/* Derive a client candidate from an unmatched Granola note.
   Two signals, in confidence order:
     1. the "<us> <> <them>" title convention (same as Telegram rooms);
     2. the most frequent external attendee email domain — external meaning
        not freemail, not the meeting owner's domain, not the user's company.
   Returns { name, company, evidence } or null. */
function derive_note_client(note, company) {
  const title = note.title || "";
  const fromTitle = _strip_meeting_descriptors(parse_pair_title(title, company));
  if (fromTitle) {
    return {
      name: fromTitle,
      company: fromTitle,
      evidence: `Meeting: ${title}`,
    };
  }

  let attendees = note.attendees;
  if (typeof attendees === "string") {
    try { attendees = JSON.parse(attendees); } catch (e) { attendees = []; }
  }
  const compNorm = normalize_name(company);
  const ownerLabel = _domain_label(note.owner);
  const counts = new Map();
  for (const a of attendees || []) {
    const label = _domain_label(a && a.email);
    if (!label || FREEMAIL_LABELS.has(label)) continue;
    if (ownerLabel && label === ownerLabel) continue;
    if (compNorm.length >= 3 && normalize_name(label).includes(compNorm)) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  if (counts.size === 0) return null;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const name = top.charAt(0).toUpperCase() + top.slice(1);
  return {
    name,
    company: name,
    evidence: `Meeting: ${title || "(untitled)"} — attendees @${top}`,
  };
}

module.exports = {
  detect_new_conversation_signal,
  normalize_name,
  parse_pair_title,
  derive_note_client,
};
