/* Cadence backend — string helpers.
 *
 * safeSlice: String.prototype.slice counts UTF-16 code units, so a cut can
 * land between the halves of a surrogate pair (an emoji is one). The
 * resulting lone surrogate serializes to invalid JSON and Anthropic's API
 * rejects the entire request body ("no low surrogate in string" — live-hit
 * July 2026, killed todo extraction on every sweep). Use this instead of
 * bare .slice() anywhere chat text / note summaries get truncated on their
 * way into an LLM payload or a JSON response.
 */

function safeSlice(str, n) {
  let s = String(str ?? "").slice(0, n);
  // Node 20+ (and Electron 33's V8): replaces every lone surrogate with
  // U+FFFD — heals both our own mid-pair cuts and malformed input.
  if (typeof s.toWellFormed === "function") return s.toWellFormed();
  // Fallback: trim a trailing high surrogate left by the cut.
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  return s;
}

module.exports = { safeSlice };
