# CLAUDE.md — Cadence

Working notes for Claude (and any contributor). `README.md` has the product
overview and module map; `PLAN.md` has the roadmap and the decisions locked
with Marlon; `BUILD_SPEC.md` has the binding contracts from the initial build.
This file captures conventions, traps, and the verification rhythm.

Cadence was ported from PipeWise (`Marlon-vb/pipewise`) in July 2026 —
when in doubt about engine semantics, the PipeWise source and its CLAUDE.md
traps are the ancestral reference. PipeWise itself stays untouched.

## Core operating rules — applies to every session

1. **Ask, don't assume.** Use `AskUserQuestion` for genuine decision points
   (architecture, scope). Get sign-off on a phase plan before cutting code.
2. **Simplest solution first.** No abstractions nobody asked for.
3. **Don't touch unrelated code.**
4. **Flag uncertainty explicitly.**
5. **Commit + push at session end** — descriptive multi-line message; if it's
   not pushed it doesn't exist.

## Verification commands

- **Backend syntax:** `node --check desktop/backend/<file>.js` on every
  modified file.
- **Backend live (works in Linux sandboxes!):** unlike PipeWise's checked-in
  macOS binaries, a fresh `npm --prefix desktop install --omit=dev` compiles
  better-sqlite3 for the host — so you can actually boot
  `CADENCE_ALLOW_PLAINTEXT=1 node desktop/backend/server.js` and curl
  round-trips with the token it prints. Do this for any backend change.
- **Backend test suite (run it for any engine/db/publisher change):**
  `npm --prefix desktop test` — `node --test` over `desktop/test/*.test.js`
  against a temp SQLite db (`test/_env.js` sets the env BEFORE any backend
  require; keep that ordering). Covers the queue states + snooze semantics
  (incl. the audit M1/M3/M9 regressions), promise extraction (M7 deep feed
  + M3 fallback, Anthropic stubbed at `_anthropic_create`), and the
  publisher cycle (M2 clobber guard, 401 death) against stubbed
  `cloud._fetch`. On the Mac AFTER `npm run rebuild` (Electron-ABI
  better-sqlite3), use `npm --prefix desktop run test:mac` instead —
  plain `node` will hit NODE_MODULE_VERSION errors there.
- **Queue engine harness:** `followups.build_queue({telegramData})` takes
  injected data — feed it a fake chats object (see the shape in
  `telegram.js` around `_lastSweep`) to exercise reply/recap/cold/promise
  states without Telegram (this is what the test suite does). GramJS itself
  can't run in the sandbox (no session) — Telegram-touching changes need
  the Mac smoke test.
- **Frontend build:** `cd app && npx vite build --outDir /tmp/cadence-build`
  — `rm -rf` the outDir first: vite won't empty a directory outside the
  project root, and a jsdom smoke that globs `assets/*.js` can silently
  load a STALE hashed bundle from a previous build.
- **Frontend RENDER smoke (catches what the build can't):** TDZ errors pass
  the build and blank the screen at runtime. Load the production bundle
  under jsdom (stub fetch/localStorage/observers, import the bundle with
  jsdom globals installed, assert `#root` has children) in BOTH states:
  setup `{onboarded:false}` → wizard, and ready → shell. A useCallback dep
  array is evaluated at render time — every identifier in it must already
  be initialized at that point in the component body.
- **Dev smoke on the Mac:** `./dev_launch.command` (kills :3456, rebuilds
  app/dist, relaunches Electron).

## Traps

**The backend owns the Telegram cache — don't reintroduce the PipeWise
frontend→backend POST pattern.** `telegram.sweep()` runs on a 30-min timer in
`server.js`, on demand (`POST /api/chats/sweep`), and ~3 s (debounced) after
a relationship gains a Telegram binding — `telegram.sweepSoon()`, called from
the create/patch/accept routes so a new client's insights don't wait for the
timer. Route-triggered sweeps run the FULL cycle (sweep + extraction) via
`telegram.setSweepRunner`, which `server.js` registers at startup. Results
persist to `<DATA_DIR>/telegram-cache.json` for warm starts. `GET /api/followups/queue`
reads `telegram.getLastSweep().chats` server-side. The frontend only triggers
sweeps and polls `GET /api/chats/progress` (400 ms, cap 99% until
`/api/chats/last` shows a new `sweptAt`). This inversion is what the iPhone
phase depends on.

**The sweep cache is dual-keyed.** `getLastSweep().chats` holds each bound
chat under BOTH `rel:<relationship.id>` and the raw `telegram_group` name
(same object in memory; separate copies after a JSON round-trip). The `rel:`
prefix keeps the id keyspace disjoint from group names — keep it. Lookups are
fine; anything that ITERATES the map must dedupe by `chat.relationship_id`
or it double-counts. `build_queue` binds by group name — the load-bearing key.

**Multi-chat clients aggregate at sweep time — the queue engine never
changed.** A relationship has ONE primary binding (the `telegram_*` columns)
plus any `relationship_chats` rows (DMs, side rooms; CASCADE on delete).
The sweep reads every chat, then `_aggregate_rel_chats` collapses them:
the chat with the newest message speaks for the relationship (its
messages/waiting_on), so "reply owed" = "the newest event across ALL the
client's chats is an inbound". `activeChatId/Name` ride the queue item and
target drafts + sends (`body.chatId`) — a reply owed in a DM answers into
that DM. Per-chat `last_activity` writes back to the chat's own row;
`build_queue`'s unmatched fallback still reads only the relationship-level
column. DM detection (attach-flavored suggestions,
`attach_relationship_id`) links chats to EXISTING clients on accept.

**Chat identity: chat_id first, fuzzy name second, self-healing.**
`relationships.telegram_chat_id` is TEXT (GramJS bigints via `_idNum`,
Number → String). Matchers try chat_id, fall back to name (exact lowercase →
substring both directions — the PipeWise 'keyrock'/'<>' tiers are gone), and
write the resolved chat_id back. Store new ids with the same `_idNum`
convention (marked-id sign included) or the chat_id tier silently misses.

**Queue semantics worth not breaking** (all live-verified at build time):
strict state priority recap → reply → cold with `continue` between branches
(a recap suppresses that relationship's reply card — intended); item keys
`reply:<relId>` / `recap:<noteId>` / etc. are load-bearing for snoozes;
"mark handled" = snooze until tomorrow 09:00, never a delete — the queue
recomputes from source every build; after-reply snoozes compare the chat's
last inbound against the snapshot taken at snooze time (7-day failsafe).
Known carried-over quirk: recap detection only sees the 5 cached messages,
so an outbound older than the cache window can false-positive a recap card
(snooze mitigates; documented in PLAN.md).

**Suggestions are dual-source and keyed by `dedupe_ref`.** `suggestions.source`
is 'telegram' (room-name convention + first-touch intent) or 'granola'
(unmatched meetings). The UNIQUE is `(dedupe_ref, status)` — raw group name
for telegram rows, `granola:<normalized name>` for granola rows. The
`<company> <> X` convention tier reads the company from
`settings.getUserProfile()` — NEVER hardcode it (the PipeWise 'keyrock'
trap). Cross-source repeats are suppressed via `taken_client_names()`
(relationship names+companies plus pending/dismissed suggestions) — new
scanners must consult it. Accepting (and any relationship create) calls
`rematch_unmatched_notes()` so past Granola meetings link immediately.

**No cadences table.** Per-relationship cadence lives in
`relationships.cadence_days` (default 14, CHECK 1–365). PipeWise's
stage-based defaults and `followup_cadences` table are gone. `set_cadence`
clamps; the db layer throws 400 as backstop.

**Truncate chat text with `strings.safeSlice`, never bare `.slice()`.**
A slice can cut an emoji's surrogate pair in half; the lone surrogate makes
the LLM request body invalid JSON and Anthropic 400s the whole extraction
("no low surrogate in string" — live-hit July 2026). Applies to message
text, note summaries, and snippets on their way into any LLM payload or
JSON response.

**Extraction dedupe keys must stay byte-stable.** `source_ref` formats
(`chatId:msgId:sha1tag(task)`, `granola:gid:sha1tag`) and the
`_normalize_task` text matching are what stop re-extraction from duplicating
todos — and the Phase 3 PipeWise importer depends on producing identical
refs. Same for `followup_promises` UNIQUE(user_id, relationship_id, text).

**Secrets.** `settings.js _writeToDisk` refuses to persist `_SECRET_FIELDS`
(anthropicKey, granolaKey, telegramSession, telegramApiHash) without
safeStorage; standalone node dev needs `CADENCE_ALLOW_PLAINTEXT=1` or secret
writes throw (surfaced as 500). New settings fields: add to `FIELDS`, expose
in `status()`, allowlist in `/api/setup/keys` — `settings.set` silently
ignores unallowlisted keys, so a missing entry fails silently.

**Auth + CSP.** Every `/api/*` route requires `X-Cadence-Token` (per-launch,
printed in dev). Frontend code must use `apiFetch` from `lib/api.js`, never
bare fetch. CSP has NO external origins — Tailwind is a build dep, fonts are
system, logos are initials-only. Don't add CDN/script/style origins; the one
inline script (theme bootstrap in index.html) is why `script-src` carries
'unsafe-inline'.

**Sweep endpoints are gated on Telegram being configured** — `POST
/api/chats/sweep` 503s when unconfigured and the frontend treats that
silently (SetupBanner is the messaging surface). Keep that contract.

**The pulse bridge keeps the backend Electron-free.** `notifier.js` is a
hook registry: main.js registers HOW (Notification, tray title + dock
badge, `setLoginItemSettings`), the backend decides WHAT (server.js calls
`notifier.observe(queue)` post-sweep; the queue route calls `updateBadge`).
Don't require electron from backend modules — register a hook instead.
Notification policy is deliberate: only NEW reply/recap keys fire, the
first observe after launch seeds silently, multiple fresh items collapse
to one summary. Login item applies only when `app.isPackaged` (dev would
register the bare Electron binary with launchd). `launchAtLogin` is the
second empty-string-default-TRUE settings field (after cloudSyncEnabled) —
`!== "0"`, don't "normalize" it. The tray icon is a base64 template PNG
embedded in main.js; the app icons (Mac tile, iOS full-bleed, splash
glyph) are checked in but GENERATED — edit
`desktop/scripts/generate-icons.js` and re-run it, never hand-edit the
PNGs. Release paths (unsigned vs signed+notarized `dist:signed`, EAS →
TestFlight) live in RELEASE.md.

**better-sqlite3 vs Electron.** `npm --prefix desktop install` compiles for
the system Node; Electron needs `npm run rebuild` (@electron/rebuild) after
install on the Mac. The sandbox never runs Electron so it never needs it.

**Error shape.** Routes wrap errors as `{"error": "..."}` with `.status`
mapping (400 validation, 404 missing, 503 not-configured). The frontend
reads `data?.error`. Keep it.

**Frontend structure.** App.jsx is a deliberately thin shell (~600 lines) —
tab state, sweep polling, toasts, setup gate. Don't grow it into PipeWise's
2,586-line App.jsx: new surfaces get their own component files. Design tokens
(`--font-*`, `--space-*`, `--radius-*`) over magic numbers. Todos drag rows
set `touch-action: none` (fine desktop-first; move to a drag handle when
touch matters — known PipeWise trap).

**The window is a slim todo-list column by default.** main.js opens at
480×940 (min 380×560) and persists bounds to `<DATA_DIR>/window-state.json`.
Below `COMPACT_BP` (860px, App.jsx `useCompact`) the shell swaps the sidebar
for a top icon bar and QueueView goes single-column: the rail is the whole
view, tapping an item shows the stage with a "← Queue" button
(`compactStage` state; cleared queues auto-return to the list so
suggestions + the snoozed drawer stay reachable). New surfaces must stay
usable at 380px — test with the `compact` render-smoke mode. Dragging past
the breakpoint restores the full two-pane layout; both modes share ALL
state, so nothing may exist in only one of them.

**LLM prompts are profile-aware.** `drafting.js`, `todos.js`, `followups.js`
substitute `settings.getUserProfile()` into every prompt. Hardcoding a
persona is a regression. Model id comes from `config.HAIKU_MODEL` — don't
re-declare per module.

**Cloud publish (Phase 4) — pull-then-push, hub-keyed, no SDK.**
`cloud.js` is direct-REST GoTrue/PostgREST (the PipeWise persistSession
lesson — don't reintroduce supabase-js; everything network goes through
`cloud._fetch`, the stub seam). The five `cloud*` session settings move in
lockstep — `_persistSession` is the only writer. `publisher.js` cycles
PULL (apply phone edits: todo flips, snoozes with `cleared` tombstones,
promise resolutions) → queue rebuild → PUSH (upserts on
`(user_id, local_id)` — the Mac is the only id-minter, no cloud_id
adoption dance; stale snoozes tombstoned, stale queue items deleted).
The pull cursor (`_meta.cloud_pull_cursor`) advances ONLY from pulled
rows, so our own pushes (which touch every row's `updated_at`) cause one
harmless re-pull next cycle instead of ever skipping a phone edit.
Local SQLite timestamps are UTC without a zone marker — always compare
via `_toIso` or LWW inverts on non-UTC Macs. Triggers: post-sweep,
mutation middleware (`_PUBLISH_PATH_RE` in routes.js — extend it when
adding tables the phone sees), 5-min interval, manual. `deleted` todos
sync as tombstones via a raw query — `list_todos` hides them.

## Roadmap pointers

Phases 5–6 (Expo iPhone app, hardening) are specified in `PLAN.md`. The
phone reads `cadence_queue_items.payload` (the full queue item JSON incl.
`activeChatId` for tg:// deep links) and writes only the fields the
publisher pulls: todos completed/starred/my_day, snoozes, promise status.
