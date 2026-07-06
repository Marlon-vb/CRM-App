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
| **3 — Importer** | One-time import from live `pipewise.db` (deals→relationships, todos, notes, promises; snoozes not imported — ephemeral) | Run against a **copy** of the real DB |
| **4 — Cloud publish** | Supabase schema (relationships, todos, notes, snoozes, promises, queue_items) + RLS; Mac publishes computed queue post-sweep; snoozes/completions sync back | Two-account isolation + round-trip |
| **5 — iPhone (Expo)** | Login, realtime Queue + Todos, snooze/complete, `tg://` deep links, copy-draft | TestFlight on Marlon's phone |
| **6 — Hardening** | Push notifications, Mac menu-bar/background mode, docs | Full regression |

## Known deferred items

- Send-from-phone via a Mac-executed outbox (v2 of Phase 5).
- Granola transcripts (`?include=transcript`) for richer extraction.
- Recap false-positive when the outbound reply is older than the 5-message
  cache window (carried over from PipeWise knowingly; snooze mitigates).
- Queue freshness on iPhone depends on the Mac sweeping periodically —
  Phase 6's background mode reduces that gap.
