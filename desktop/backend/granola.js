/* Cadence backend — Granola API client.
 *
 * Ported verbatim from PipeWise granola.js. Pulls meeting notes from
 * Granola's public REST API using a personal key (Settings → Granola).
 * Built-in fetch does the HTTP.
 *
 * If the key isn't set, _request throws an Error with .status = 503 — the
 * routes error middleware turns that into a friendly HTTP 503.
 *
 * Internal HTTP (_request, list_notes, get_note) is invoked through
 * module.exports so the verifier can stub the network layer.
 */

const { GRANOLA_API_BASE } = require("./config");
const settings = require("./settings");

// True when a Granola key is configured. Per-user — checked at call time.
function hasKey() {
  return Boolean(settings.getGranolaKey());
}

// Granola allows 5 req/s sustained — stay under it with a client throttle.
const _MIN_REQUEST_INTERVAL_MS = 250;
let _lastRequestAt = 0;

function _svcError(message) {
  const e = new Error(message);
  e.status = 503;
  return e;
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP ────────────────────────────────────────────────────────────

async function _request(path, params) {
  const apiKey = settings.getGranolaKey();
  if (!apiKey) {
    throw _svcError("Granola API key not set — add it in Cadence Settings.");
  }

  const wait = _MIN_REQUEST_INTERVAL_MS - (Date.now() - _lastRequestAt);
  if (wait > 0) await _sleep(wait);

  let url = `${GRANOLA_API_BASE}${path}`;
  if (params) {
    const clean = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined) clean[k] = v;
    }
    const qs = new URLSearchParams(clean).toString();
    if (qs) url += "?" + qs;
  }

  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    _lastRequestAt = Date.now();
    throw _svcError(`Granola API request failed: ${e.message}`);
  }
  _lastRequestAt = Date.now();

  if (!resp.ok) {
    if (resp.status === 401) {
      throw _svcError("Granola rejected the API key (401) — check the Granola key in Cadence Settings.");
    }
    if (resp.status === 429) {
      throw _svcError("Granola rate limit hit (429) — try again in a moment.");
    }
    throw _svcError(`Granola API error ${resp.status}: ${resp.statusText}`);
  }
  try {
    return await resp.json();
  } catch (e) {
    throw _svcError(`Granola API request failed: ${e.message}`);
  }
}

// One page of the notes list. Returns {notes, hasMore, cursor}.
async function list_notes(createdAfter, cursor, pageSize = 30) {
  return module.exports._request("/notes", {
    created_after: createdAfter,
    cursor: cursor,
    page_size: pageSize,
  });
}

// Full note by id — summary, attendees, calendar event.
async function get_note(noteId, includeTranscript = false) {
  return module.exports._request(
    `/notes/${noteId}`,
    includeTranscript ? { include: "transcript" } : null
  );
}

// ── normalization ───────────────────────────────────────────────────

function _normalize_note(raw) {
  const cal = raw.calendar_event || {};
  const attendees = (raw.attendees || [])
    .filter((a) => a && typeof a === "object")
    .map((a) => ({ name: a.name || "", email: a.email || "" }));
  return {
    granolaId: raw.id ?? null,
    title: raw.title || cal.event_title || "Untitled meeting",
    summary: raw.summary_markdown || raw.summary_text || "",
    attendees: attendees,
    owner: (raw.owner || {}).email ?? null,
    meetingDate: cal.scheduled_start_time || raw.created_at || null,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
  };
}

async function fetch_recent_notes(days = 30, maxNotes = 60) {
  // YYYY-MM-DD, `days` ago, UTC.
  const createdAfter = new Date(Date.now() - days * 86400 * 1000)
    .toISOString()
    .slice(0, 10);

  const listed = [];
  let cursor = null;
  while (listed.length < maxNotes) {
    const page = await module.exports.list_notes(createdAfter, cursor, 30);
    for (const n of page.notes || []) listed.push(n);
    cursor = page.cursor;
    if (!page.hasMore || !cursor) break;
  }
  const head = listed.slice(0, maxNotes);

  const detailed = [];
  for (const entry of head) {
    const noteId = entry.id;
    if (!noteId) continue;
    try {
      detailed.push(_normalize_note(await module.exports.get_note(noteId)));
    } catch (e) {
      continue; // skip a failing note; don't abort the whole sync
    }
  }
  detailed.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return detailed;
}

module.exports = {
  hasKey,
  _request,
  list_notes,
  get_note,
  _normalize_note,
  fetch_recent_notes,
};
