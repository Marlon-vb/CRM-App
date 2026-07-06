# Cadence

**Not a CRM — a rhythm keeper.** Cadence is a smart follow-up instrument for
Mac: it reads your Telegram conversations and Granola meeting notes and keeps
one prioritized list of what to do next — who's waiting on a reply, which
meeting still needs a recap, what you promised people, and which relationships
are going cold past their touch cadence.

Cadence is the light successor to [PipeWise](https://github.com/Marlon-vb/pipewise):
the same battle-tested follow-up engine, without the pipeline, kanban,
opportunities, or portfolio surfaces. An iPhone companion (Mac-as-hub via
Supabase sync) is planned — see `PLAN.md`.

## What it does

### Queue — the one list that matters
- **Reply owed** — they spoke last on Telegram; you owe them. Urgency grows
  with hours owed.
- **Recap due** — a Granola meeting happened in the last 72 h and you haven't
  sent anything to that chat since. One click drafts the recap from the
  meeting notes.
- **Going cold** — a relationship silent past its cadence (default 14 days,
  tunable per client 1–365). The relaunch radar.
- **Promises** — commitments you made in chats ("I'll send the deck by
  Monday"), extracted by Haiku, resurface when they go stale.
- **Todos** — overdue and due-today items ride along; a relationship's open
  todos and stale promises bundle onto its card so one send clears everything.
- **Drafts in your voice** — replies, warm re-openers, and recaps drafted by
  Haiku using your profile + optional voice files (`~/Desktop/voice/*.md`).
- **Confirm-first send** — 2-second undo window before anything goes out.
- **Smart snooze** — tonight / tomorrow / next week / **after they reply**
  (resurfaces only when a new inbound lands, 7-day failsafe).
- Keyboard-first: **D** done · **S** snooze · **→** skip.

### Todos
- My Day + full list, date buckets (Overdue / Today / Tomorrow / …), stars,
  drag-to-reorder within a bucket.
- **Auto-extracted** from Telegram threads and Granola notes by Haiku,
  two-layer deduped against everything you already have (including
  deleted items — nothing nags twice).
- Natural-language due dates when adding ("Send deck Friday").

### Clients
- A flat list of tracked relationships: Telegram binding, last-touch age,
  per-client cadence, archive/unarchive. No stages, no amounts, no funnel.
- **New-conversation detection** — the Telegram sweep spots fresh first-touch
  conversations (EN/NL/DE intent patterns) and suggests tracking them;
  one click creates the relationship.

### How data flows
The backend owns a **30-minute Telegram sweep** (plus on-demand): last 10
messages per tracked chat, who-spoke-last, last-activity timestamps, and a
regex action summary — no LLM in the hot path. Sweep results persist to disk
so the app opens warm. After each sweep, todo extraction and promise
extraction run automatically (throttled). The queue recomputes from source
data on every request — there's no server-side "done" state to corrupt.

## Stack

- **Frontend** — Vite + React 18, Tailwind (build-time, no CDN) + design
  tokens in `app/src/theme.css` (dark default, light theme).
- **Backend** — Node/Express on `127.0.0.1:3456`, `better-sqlite3`,
  GramJS (Telegram User API), `@anthropic-ai/sdk` (Haiku).
- **Shell** — Electron 33, single origin, per-launch API token, settings
  encrypted via macOS Keychain (`safeStorage`).

## Run from source

```bash
git clone git@github.com:Marlon-vb/CRM-App.git cadence && cd cadence
npm --prefix app install
npm --prefix desktop install
./dev_launch.command
```

First run lands in a 4-step onboarding: profile → Telegram login → API keys
(Anthropic required for drafting/extraction, Granola optional).

Backend-only dev (no Electron): `CADENCE_ALLOW_PLAINTEXT=1 node desktop/backend/server.js`
— the dev API token prints at startup.

## Module map

```
desktop/                Electron + Node backend
  main.js               Electron main — boots backend, token bridge, window
  preload.js            exposes window.cadence.apiToken to the renderer
  backend/
    server.js           entrypoint — sweep timer + post-sweep extractions
    routes.js           ~36 REST endpoints under /api/*
    auth.js             per-launch X-Cadence-Token
    settings.js         encrypted settings (keys, Telegram session, profile)
    telegram.js         GramJS: sweep, send, login, recent-conversations
    followups.js        the queue engine (states, urgency, snoozes, promises)
    todos.js            Haiku todo extraction (Telegram + Granola)
    granola.js          Granola API client
    drafting.js         Haiku reply drafting (profile + voice files)
    detection.js        new-conversation intent patterns (EN/NL/DE)
    db/                 SQLite schema + CRUD (relationships, todos, notes,
                        snoozes, promises, suggestions)
app/                    React frontend
  src/App.jsx           thin shell: tabs, sweep polling, toasts, setup gate
  src/components/       QueueView, Todos, Clients, Settings, Onboarding
  src/lib/api.js        authed fetch wrappers
PLAN.md                 phased roadmap (importer → cloud publish → iPhone)
BUILD_SPEC.md           the build contracts (schema, API surface, shapes)
```

## Data privacy

Local-first. Telegram session, Anthropic key, and Granola key live encrypted
in the macOS Keychain and never leave the Mac. External calls: Anthropic
(your key), Granola (your key), Telegram (your account). No telemetry.

Gitignored, never committed: `app/data/` (SQLite DB + Telegram cache),
`cadence-settings.dat`.

## License

MIT © 2026 Marlon van Bezouwen.
