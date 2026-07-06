# Cadence — Build Spec (Phases 0–2)

The binding contracts for the initial build. Source material is the PipeWise
repo at `/home/user/pipewise` — port, don't reinvent. Where this spec and
PipeWise disagree, this spec wins. Where this spec is silent, mirror PipeWise.

## Repo layout

```
desktop/                  Electron shell + Node backend
  package.json            deps: @anthropic-ai/sdk, better-sqlite3, express, telegram; dev: electron, electron-builder
  main.js                 Electron main — boots backend, token bridge, sandbox:true, will-navigate lock
  preload.js              exposes window.cadence = { apiToken }
  backend/
    server.js             entrypoint :3456 — connect telegram, initial sweep, 30-min sweep timer
    routes.js             REST under /api/*, {error} shape, auth middleware, CSP
    auth.js               per-launch token, header X-Cadence-Token
    config.js             ports, paths, SWEEP_INTERVAL_MS, model ids
    settings.js           encrypted settings (safeStorage), CADENCE_ALLOW_PLAINTEXT=1 for standalone dev
    db.js                 facade re-exporting db/ modules
    db/core.js            schema + migrations + row helpers
    db/relationships.js   CRUD (from pipewise db/deals.js)
    db/todos.js           CRUD + upsert_extracted_todos (port near-verbatim)
    db/followups.js       snoozes + promises CRUD (cadences table is GONE — see schema)
    db/notes.js           notes CRUD + _match_note_to_relationship
    db/suggestions.js     new-conversation suggestions CRUD
    telegram.js           GramJS: lifecycle, sweep, send, login, progress, recent-conversations
    followups.js          queue engine (port with edits below)
    todos.js              Haiku extraction (port near-verbatim)
    granola.js            Granola client (port verbatim)
    drafting.js           Haiku reply drafting (port, trim deal block)
    detection.js          ONLY detect_new_conversation_signal survives
app/                      React frontend (Vite)
  package.json            react, react-dom, react-router-dom, lucide-react, @dnd-kit/*; dev: vite, tailwindcss, postcss, autoprefixer
  vite.config.js          build outDir dist; sandbox builds use --outDir /tmp/...
  index.html              NO Tailwind CDN — tailwind is a build dep here
  tailwind.config.js      content: ./index.html + ./src/**/*.{js,jsx}
  postcss.config.js
  src/
    main.jsx              HashRouter (file:// constraint)
    App.jsx               thin shell — see contract below
    theme.css             ported from pipewise (design tokens --font-*/--space-*/--radius-*) + @tailwind directives
    constants.js          NAV (queue/todos/clients/settings), no STAGES
    lib/api.js            apiFetch with X-Cadence-Token (window.cadence.apiToken || localStorage 'cadence-token')
    lib/utils.js          timeAgo etc (port what's used)
    lib/dateparse.js      port verbatim
    hooks/useTheme.js     port verbatim
    components/
      QueueView.jsx       port with edits below
      Todos.jsx           port with edits below
      Clients.jsx         NEW simple list — see below
      Settings.jsx        port trimmed (profile, keys, telegram connect; no cloud section yet)
      Onboarding.jsx      port trimmed (welcome → profile → telegram → keys)
      atoms/              only what the above import (Toast, SetupBanner, ThemeToggle, …)
dev_launch.command        kill :3456, build app/dist, launch electron
```

Naming: the product is **Cadence** (`com.montyinc.cadence`, window title "Cadence").
Env vars are `CADENCE_*`. Settings file `cadence-settings.dat`. Dev DB at
`app/data/cadence.db` (gitignored); packaged DB under
`~/Library/Application Support/Cadence/`. No demo seeding.

## SQLite schema (db/core.js)

Port pipewise `db/core.js` structure (WAL, foreign_keys ON, idempotent
migrations, `_meta` table, `users` table + `user_id INTEGER NOT NULL DEFAULT 1`
on every tenant table — keeps Phase 4 cloud sync cheap).

```sql
relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  company TEXT,                          -- nullable; used by Granola note matching
  telegram_group TEXT,                   -- dialog name binding (fallback matcher)
  telegram_contact TEXT,
  telegram_chat_id TEXT,                 -- GramJS bigint as TEXT; preferred join key
  telegram_last_activity TEXT,           -- ISO; written by sweep AND send route
  contact_emails TEXT NOT NULL DEFAULT '[]',  -- JSON array; Granola match signal 1
  cadence_days INTEGER NOT NULL DEFAULT 14 CHECK (cadence_days BETWEEN 1 AND 365),
  archived_at TEXT,                      -- replaces lost_at; engine skips archived
  created_at TEXT, updated_at TEXT
)
todos      -- port pipewise schema verbatim, deal_id → relationship_id (FK relationships ON DELETE SET NULL)
notes      -- port verbatim: granola_id UNIQUE, deal_id → relationship_id (FK SET NULL), meeting_date etc.
followup_snoozes    -- port verbatim: UNIQUE(user_id, item_key), mode 'until'|'after_reply'
followup_promises   -- port verbatim, deal_id → relationship_id (FK CASCADE), UNIQUE(user_id, relationship_id, text)
suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  telegram_group TEXT NOT NULL,
  telegram_chat_id TEXT,
  suggested_name TEXT,
  first_message TEXT,
  message_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|accepted|dismissed
  created_at TEXT, updated_at TEXT,
  UNIQUE(telegram_group, status)             -- load-bearing dedupe (ON CONFLICT DO NOTHING)
)
```

**No `followup_cadences` table** — folded into `relationships.cadence_days`.
**No** contacts / outreach_queue / client_opportunity_cache / telegram_groups.

Dict shapes (camelCase, keep PipeWise field names except deal→relationship):

- relationship: `{id, name, company, contactEmails: [], cadenceDays, archivedAt,
  telegramChat: {group, contact, chatId, lastActivity}, createdAt, updatedAt}`
- todo: exactly PipeWise `_todo_row_to_dict` with `relationshipId` replacing `dealId`.
- Snooze item keys keep their shapes: `reply:<relId>`, `cold:<relId>`,
  `promise:<relId>`, `recap:<noteId>`, `todo:<todoId>`.

## Backend behavioural contracts

**Sweep is backend-owned.** `telegram.js` exports:
- `sweep()` — walks tracked relationships' chats (last 10 msgs each, computes
  `waiting_on = lastMsgs[0].is_me ? 'them' : 'me'`, regex `action_summary`,
  writes `telegram_last_activity` back, then scans unknown dialogs via
  `detection.detect_new_conversation_signal` → `suggestions` INSERT
  ON CONFLICT DO NOTHING, storing chat_id). Guarded by a running flag;
  updates the module-level `_progress` slot (same shape as pipewise
  `_chatsProgress`, total covers both phases). Returns `{chats, newSuggestions}`.
- `getLastSweep()` → `{sweptAt, chats}` — persisted to
  `<userData>/telegram-cache.json` after each sweep, loaded at startup (warm start).
- Chat matching: prefer `telegram_chat_id` when set; else the PipeWise 4-tier
  fuzzy name match **minus the hardcoded 'keyrock'/'<>' tiers** (exact →
  substring both directions only). On a successful name match, write the
  resolved chat_id back onto the relationship (self-healing upgrade).
- `_send_message(relationship, text)` — resolve by chat_id first, else name;
  stamp `telegram_last_activity`.
- `_fetch_recent_conversations(...)` — port (feed for todo extraction),
  tagging `relationship_id` instead of `deal_id`.
- **Excise entirely:** `_apply_auto_stage_move`, STAGE_ORDER/RANK,
  `_check_single_threaded`, threading. `_fetch_single_chat(group|chatId)`
  replaces the sweep-reuse in draft-reply (no full-sweep side effect per draft).
- Port unchanged: `connect()` lazy lifecycle, `_loadGram`, `_extract_message_meta`,
  begin/complete login + 2FA + logout, `_friendlyTgError`, 503-when-unconfigured.

**server.js** after `telegram.connect()` best-effort: load cached sweep →
initial `sweep()` if stale (>30 min) → `setInterval(sweep, SWEEP_INTERVAL_MS)`.
After each successful sweep, best-effort: `todos.extract_todos()` (its 30-min
in-process cache prevents overcalls) and `followups.extract_promises(chats)`
throttled to once per 12h per server run. Errors logged, never fatal.

**followups.js** port with three edits: (1) `build_queue({telegramData})`
keeps its injected-data signature (the stubbed-db test harness depends on it) —
routes pass `telegram.getLastSweep().chats`; (2) cadence resolution =
`relationship.cadenceDays ?? 14` (no stage defaults, no cadences table);
(3) queue items drop `stage`/`amount` fields, keep everything else
(kind, urgency, bundle, chat excerpt, actionSummary, etaMinutes, key shapes).
`set_cadence(relationshipId, days)` updates `relationships.cadence_days`.

**Queue endpoint becomes GET** (`GET /api/followups/queue`) — the backend owns
the cache now. Response gains `sweptAt` so the UI can show data age.

## API surface (routes.js)

Port the middleware stack (auth, JSON, error→`{error}`, status mapping,
Host/Origin allowlist, CSP). CSP has **no external origins** (no Tailwind CDN,
no CoinGecko): `default-src 'self'; connect-src 'self'; img-src 'self' data:`.

```
GET  /api/health
GET  /api/relationships                POST /api/relationships {name, company?, telegramGroup?, telegramChatId?, contactEmails?}
PATCH /api/relationships/:id           DELETE /api/relationships/:id
POST /api/relationships/:id/archive    POST /api/relationships/:id/unarchive
POST /api/relationships/:id/draft-reply {instructions?}   POST /api/relationships/:id/send-message {text}
GET/POST /api/todos    PATCH/DELETE /api/todos/:id    POST /api/todos/reorder    POST /api/todos/refresh {force?}
GET  /api/notes?relationshipId         POST /api/notes/sync
GET  /api/followups/queue              POST /api/followups/snooze {itemKey, mode, until?, lastInboundAt?}
POST /api/followups/unsnooze {itemKey} POST /api/followups/extract-promises
GET  /api/followups/promises?relationshipId&status        PATCH /api/followups/promises/:id {status}
POST /api/followups/cadence/:relationshipId {days}        POST /api/followups/draft-recap {noteId}
POST /api/chats/sweep   (202 {alreadyRunning:true} if in flight)   GET /api/chats/progress   GET /api/chats/last
GET  /api/suggestions   POST /api/suggestions/:id/accept   POST /api/suggestions/:id/dismiss
GET  /api/setup/status  POST /api/setup/keys
POST /api/setup/telegram/send-code | /sign-in | /logout
```

`/api/suggestions/:id/accept` creates a relationship from the suggestion
(name, telegram_group, telegram_chat_id) and marks it accepted.

## Frontend contracts

**App.jsx (thin shell, target ≤600 lines).** Tabs queue/todos/clients/settings
via HashRouter (default `queue`). State: `relationships`, `todos`, `fuSummary`,
`suggestions`, sweep progress `{active, pct, phase}`, `setupState`, toasts,
theme. On mount: setup gate (`checking`→splash, `needed`→Onboarding) →
`refetchAll` (relationships, todos, suggestions) → `GET /api/chats/last`; if
stale or empty, `POST /api/chats/sweep` and poll `GET /api/chats/progress`
every 400 ms (cap 99% until a follow-up `/api/chats/last` shows a new sweptAt;
then snap 100%, fade 600 ms). Progress bar at top of the content column.
Sidebar: Cadence wordmark, nav with badges (Queue = fuSummary.needsYou count,
Todos = due today), ThemeToggle, profile mini-card → Settings.

**QueueView.jsx** port: self-fetches `GET /api/followups/queue` (no
telegramData prop), refetch after sweep completes (App bumps a `sweepStamp`
prop). Keep: rail groups (reply/recap/promise/todo/cold), one-at-a-time stage,
why-banner, last-3 messages, bundle chips, lazy draft generation, confirm-first
send (2 s undo), mark-handled = snooze-until-tomorrow-09:00, keyboard D/S/→,
local error boundary. Drop: DealPeek/peek wiring (card shows what's needed),
stage/amount display. Add: a compact "New conversations" block at the rail
bottom rendering pending suggestions with Track/Dismiss.

**Todos.jsx** port near-verbatim: `deals` prop → `relationships` (chip label +
open link → Clients tab), `dealId` → `relationshipId`. Keep buckets, My Day,
stars, within-bucket @dnd-kit reorder, natural-language due parsing, detail
pane, silent refresh-on-open.

**Clients.jsx** NEW (~250 lines, simple): list of relationships — name,
company, telegram binding status, cadence stepper (writes cadence/:id),
last-activity age, archive/unarchive, delete (confirm), inline add form
(name + telegram group). No CoinGecko, no KPIs, no news.

**Settings.jsx / Onboarding.jsx** port trimmed: profile (name/role/company),
Anthropic + Granola keys, Telegram connect/logout (keep the TelegramConnect +
KeyField components Onboarding imports). No cloud section, no revenue target.
Onboarding: Welcome → Profile → Telegram → Keys, skippable like PipeWise.

## Verification (sandbox)

1. `node --check` every backend file.
2. `cd desktop && npm install --omit=dev` (Linux better-sqlite3 works in the
   sandbox, unlike the macOS binaries in pipewise) →
   `CADENCE_ALLOW_PLAINTEXT=1 node backend/server.js` → curl round-trips with
   the printed token: relationships CRUD, todos CRUD, queue build (empty
   telegram cache → todos-only queue), snooze/unsnooze, suggestions accept.
3. Stubbed-db harness for `build_queue` with a fake telegram cache (reply-owed,
   cold, recap, promise cases) — port the pipewise Module.prototype.require
   pattern.
4. `cd app && npm install && npx vite build --outDir /tmp/cadence-build`.
5. jsdom render smoke on the production bundle: stub fetch/localStorage/
   observers, mount, assert `#root` has children (catches TDZ blank-screens).
