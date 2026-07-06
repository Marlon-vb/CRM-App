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
          firstMessage: text.slice(0, 200),
          messageCount: messages.length,
        };
      }
    }
  }
  return null;
}

module.exports = {
  detect_new_conversation_signal,
};
