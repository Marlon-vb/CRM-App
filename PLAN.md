# Cadence — Plan & Decisions

Cadence is the light successor to PipeWise: **not a CRM — a rhythm keeper.**
A super-smart todo list for Mac (and iPhone, next phase) that aggregates
Telegram + Granola and always answers: *what do I do next, who do I follow
up with, who is going cold or is pending a relaunch.*

Decided with Marlon on 2026-07-06:

| Question | Decision |
|---|---|
| Home | New app in this repo (`Marlon-vb/CRM-App`); full PipeWise stays untouched |
| iPhone architecture | **Mac as hub**: the Mac keeps the Telegram session, sweeps + computes the queue, publishes to Supabase; the phone is a read/act client |
| iPhone tech | React Native (Expo), iOS-only v1 |
| Name | **Cadence** (from the pipewise `design/prototype-b-cadence-standalone.html` exploration) |
| Sources | Telegram + Granola only. Slack explicitly out of scope. |
| Phone replies (v1) | Telegram deep links (`tg://`) + copy-draft-to-clipboard — the session never leaves the Mac |

## What Cadence keeps from PipeWise (verified by code audit, Jul 2026)

- `followups.js` — the queue engine: reply-owed / recap-due / going-cold /
  promises / todos state machine, urgency scoring, bundling, snooze
  semantics ("after they reply" incl.), recap drafting.
- `todos.js` + `granola.js` — Haiku todo extraction from Telegram threads +
  Granola meeting notes, two-layer dedupe, notes sync + note→client matching.
- `telegram.js` — GramJS lifecycle, chat sweep (`waiting_on`, last activity,
  regex action summaries), send path, in-app login. **Minus** all pipeline
  side effects (stage auto-moves, multi-threading checks).
- The todos UI, Queue UI, Settings/Onboarding — ported onto a fresh thin shell.

## What changes structurally

1. **`deals` → `relationships`.** The 20-column deal model reduces to
   `{name, company, telegram binding, contact_emails, cadence_days,
   archived_at}` — the only columns the smart features actually read.
   Stage is gone; its single functional use (cadence defaults) becomes a
   per-relationship `cadence_days` (default 14).
2. **The backend owns the Telegram cache.** PipeWise's frontend swept
   Telegram and POSTed the cache into queue builds. Cadence sweeps
   server-side on a 30-minute timer (plus on demand), caches to disk for
   warm start, and runs todo + promise extraction after each sweep. This is
   what makes the app proactive — and what the iPhone phase requires.
3. **`telegram_chat_id` is stored** on relationships (PipeWise captured it
   but joined by fuzzy name). Name-matching remains the fallback; chat_id
   enables reliable sends and `tg://` deep links on the phone.
4. **New-conversation detection survives** as a neutral "new conversation"
   suggestion (accept → tracked relationship), no deal/stage payload.

## Phases

| Phase | Scope | Gate |
|---|---|---|
| **0 — Scaffold** ✅ this session | Repo layout, Electron shell, build tooling, SQLite schema, settings/auth | Boots empty; `node --check` + vite build |
| **1 — Engine port** ✅ this session | followups/todos/granola/telegram/drafting/detection + routes + scheduled sweep | Sandbox: live server + curl round-trips, stubbed-queue harness; then Mac smoke test |
| **2 — Mac frontend** ✅ this session | Thin shell + Queue, Todos, Clients, Settings, Onboarding | vite build + jsdom render smoke; then Mac smoke test |
| **3 — Importer** ✅ shipped | `desktop/scripts/import-pipewise.js`: deals→relationships (stage→cadence, contacts→emails, lost→archived), todos incl. tombstones (byte-stable source_refs), notes, promises; guarded + idempotent re-runs | Run against a **copy** of the real DB on the Mac |
| **4 — Cloud publish** ✅ shipped | `cadence_*` Supabase schema + RLS (coexists with PipeWise's project); direct-REST auth (no SDK); pull-then-push publisher (phone edits absorbed before the queue rebuild, tombstoned snoozes, stale queue items deleted); Settings → Cadence Cloud UI | Marlon: run `cloud/supabase-schema.sql` once, sign in, verify "synced Xs ago" |
| **5 — iPhone (Expo)** ✅ scaffold shipped | `mobile/`: login (project + account, SecureStore), Queue with done/snooze(incl. after-reply)/bundle-clear, Todos complete/star, Telegram deep links (`t.me/c` for supergroups, `tg://openmessage` for DMs), copy-conversation, 45s polling. Direct-REST client (no SDK). Metro export + link-resolver tests pass. | Expo Go run on Marlon's phone (mobile/README.md); EAS→TestFlight when ready |
| **6 — Hardening** | Push notifications, Mac menu-bar/background mode, docs | Full regression |

## Known deferred items

- ~~Contact/DM detection tier~~ ✅ shipped 2026-07-06: `relationship_chats`
  (multi-chat per client), sweep-time aggregation (newest chat speaks for
  the relationship), DM suggestions that attach to existing clients, and
  chat-targeted drafts/sends. Manual "link a chat" UI is API-only for now
  (`POST /api/relationships/:id/chats`) — the suggestion flow is the
  primary path.
- Send-from-phone via a Mac-executed outbox (v2 of Phase 5).
- Granola transcripts (`?include=transcript`) for richer extraction.
- Recap false-positive when the outbound reply is older than the 5-message
  cache window (carried over from PipeWise knowingly; snooze mitigates).
- Queue freshness on iPhone depends on the Mac sweeping periodically —
  Phase 6's background mode reduces that gap.
