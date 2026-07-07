# Cadence — Full Audit (2026-07-06)

Three-dimension audit (architecture/product, Mac UX/UI, mobile UX/UI) run
after Phases 0–5 shipped and the app went live on real data (43 clients,
38-item queue). Findings verified against source; file:line refs included.
Severity reflects damage to a real user's week, not code aesthetics.

> **Fix status (2026-07-07):** all four waves shipped. ✅ = fixed and
> verified (Wave 1 `793382a`, Wave 2 `2bf99d6`, Wave 3 `f1a02a7` + the
> regression suite `npm --prefix desktop test`, Wave 4 `8c8bfd5`).
> U10 ✅ covers haptics — swipe actions, plus U4 (QR handoff), U7
> (icons/signing), and U9 remain open. File:line refs below describe
> the code AS AUDITED and may have drifted.

## The three themes

**1. The app can lie.** Both clients render a celebratory "all clear" when
a fetch fails or hasn't happened; all three external dependencies
(Telegram session, Anthropic key, Supabase session) die silently while the
queue keeps looking healthy on stale data; and replies you just sent
resurrect as "reply owed" for up to ~35 minutes. For a product whose whole
pitch is "trust this one list," these are the highest-priority fixes.

**2. Triage is full of one-way doors.** Mark-handled/snooze/delete/done
have no undo anywhere; snoozed items are invisible on every surface with
no unsnooze path; "Done" silently marks promises "kept" without a send; a
wrong Telegram binding can only be fixed by deleting the client (losing
its promises). The fast keyboard/tap workflow is the product's pitch — it
is currently unsafe to use at speed.

**3. The promise has no pulse.** Nothing ever notifies the user — no push,
no macOS notifications, no badges. Sweeps stop when the Mac window closes
(no login item, no tray). Today Cadence is a *pull* rhythm keeper: it only
prevents missed follow-ups if you remember to open it, which is the
failure mode it exists to fix.

---

## Critical

| # | Finding | Where | Evidence |
|---|---|---|---|
| C1 ✅ | **False "all clear" on error/loading — both clients.** Mac: failed queue fetch leaves `queue=null` → celebratory zero state, even skipping the "waiting for first sweep" hint. Phone: "All clear 🎾" renders before first fetch, offline, and during silently-failing polls. | Mac + phone | `QueueView.jsx:136-140,561-572`; `mobile QueueScreen.js:220-266`; `mobile App.js:70-72` |
| C2 ✅ | **Sent replies resurrect as "reply owed" ≤35 min, both devices.** Send updates neither the sweep cache nor triggers sweep/publish; `_PUBLISH_PATH_RE` excludes send-message with a comment describing a sweep that nothing schedules. | backend | `telegram.js:1086-1120`; `routes.js:134-139,349-362` |
| C3 ✅ | **Nothing ever notifies the user.** No push, no macOS notifications, no app badge, anywhere. A reply owed 3 days is silent unless the user opens an app. | product | no notification code in repo |
| C4 ✅ | **Hub-down = system-down, unflagged.** No login item, no tray; Cmd+Q freezes Mac + phone indefinitely. Neither client alarms on data age (phone caption only; Mac shows nothing). | product | `main.js` (no `setLoginItemSettings`); `QueueView.jsx:489` |
| C5 ✅ | **Phone session expiry is silent + concurrent-refresh can brick a session.** Background polls swallow auth errors forever; three parallel fetches can race the same refresh token (GoTrue rotation). | phone | `mobile cloud.js:101-116`; `mobile App.js:59-72` |
| C6 ✅ | **Wrong Telegram binding is a dead end.** `PATCH /api/relationships/:id` and `addRelationshipChat` have zero frontend callers; the "not linked" tooltip instructs an action the UI can't perform; the only fix is delete (which cascades promises). | Mac | `Clients.jsx:66`; `api.js:49-62,79-88` (no callers) |
| C7 ✅ | **Snoozed items are invisible and un-unsnoozable.** Mark-handled/D parks items in a state no surface lists; `unsnooze` API has no caller; no GET for snoozes; a mis-pressed D is unrecoverable until 09:00 tomorrow. | Mac + phone | `QueueView.jsx:292-293`; `routes.js:435-445` |

## Major — correctness

| # | Finding | Where | Evidence |
|---|---|---|---|
| M1 ✅ | **Cloud sync breaks the after-reply 7-day failsafe.** Every 5-min cycle re-applies pulled snoozes; `set_snooze` resets `created_at` on conflict; the failsafe reads `createdAt` → an "after they reply" snooze on a permanently-quiet chat hides the item **forever**. | backend | `db/followups.js:65-71`; `publisher.js:101-109`; `followups.js:110-112` |
| M2 ✅ | **Pull-then-push clobber window eats phone actions.** Push upserts unconditionally; a phone action landing between PULL and PUSH is overwritten (snoozes actively tombstoned), and the touch trigger stamps the Mac's write as newest — unrecoverable. | backend | `publisher.js:139-146,210-215` |
| M3 ✅ | **DM-only clients are invisible to the queue engine.** `build_queue` binds only via primary group name; a Granola-created client with an attached DM sweeps fine but never enters reply/cold detection (the `rel:<id>` cache key exists precisely for this and isn't used). | backend | `followups.js:200-201`; `telegram.js:989` |
| M4 ✅ | **Anthropic failure silently kills Granola recaps.** Note sync happens inside the LLM extraction path — a bad key stops notes syncing → recap cards stop; failures land only in the console. | backend | `todos.js:474-517`; `server.js:80-94` |
| M5 ✅ | **Dead Telegram session degrades silently.** `status().telegram` only checks creds exist; timer sweeps console.error; no banner fires; queue serves week-old waiting_on data confidently. | backend + both UIs | `settings.js:211`; `server.js:56-58`; `App.jsx:284-299` |
| M6 ✅ | **Supabase session death stalls sync forever, Settings-only whisper.** 5-min interval re-fails identically; session never cleared; no re-auth prompt in the shell. | backend | `cloud.js:119-128`; `publisher.js:259-262` |
| M7 ✅ | **Promise capture is structurally lossy.** Extraction ≤1×/12h over the newest ~8 messages of the newest chat only — most real "I'll send X by Monday" commitments in active groups are never seen, with no signal. | backend | `config.js:49`; `followups.js:413-421` |
| M8 ✅ | **"Done"/D silently completes bundle + marks promises "kept" without a send**; success toast even on partial failure (phone swallows errors per-item). | Mac + phone | `QueueView.jsx:203-213,296`; `mobile QueueScreen.js:63-74` |
| M9 ✅ | **Never-contacted clients never go cold** (`daysSilent === null` skips cold) — a relaunch-radar blind spot for imported/unmatched rows. | backend | `followups.js:297` |

## Major — UX

| # | Finding | Where | Evidence |
|---|---|---|---|
| U1 ✅ | No "synced Xm ago" + no manual Sync button on the Mac queue (sweptAt fetched, never rendered; etaMinutes computed, never shown). | Mac | `api.js:203-205`; `followups.js:362` |
| U2 ✅ | One-tap destructive actions with no undo: todo delete (incl. Delete key), todo complete (phone), queue done/snooze — Toast supports action buttons, never used. | both | `Todos.jsx:627-638`; `Toast.jsx:31-42`; `mobile TodosScreen.js:63-66` |
| U3 ✅ | "Done" label is dishonest — it's snooze-until-tomorrow-09:00; resurfacing reads as a sync bug. | both | `mobile QueueScreen.js:68`; `QueueView.jsx:292` |
| U4 | Phone first-run = typing a ~200-char JWT; QR handoff from Mac Settings would erase the worst moment in the product. Strict URL regex also rejects self-hosted Supabase. | phone | `mobile LoginScreen.js:41-66`; `mobile cloud.js:42` |
| U5 ✅ | Toasts unreadable in light theme (`bg-gray-900` overridden to near-white surface with white text). | Mac | `Toast.jsx:21`; `theme.css:432-433` |
| U6 ✅ | Clients list: no search/sort/scroll-to with 43 rows; "open client" from queue/todos drops the id. | Mac | `App.jsx:318-321`; `Clients.jsx:279-347` |
| U7 | No app icon/splash assets at all — EAS/TestFlight would ship the Expo placeholder; `.dmg` config points at a nonexistent `build/icon.png`, unsigned (Gatekeeper lore undocumented here). | phone + Mac | `mobile app.json`; `desktop/package.json` |
| U8 ✅ | Accessibility: zero a11y props on phone; `textFaint` fails WCAG on all surfaces (3.2–3.8:1, computed); hit targets < 44pt, no hitSlop; priority is color-only. | phone | `mobile theme.js`; `mobile TodosScreen.js:121` |
| U9 | Suggested clients buried below a 38-item rail — the growth moment is invisible; no edit-before-accept. | Mac | `QueueView.jsx:495-556` |
| U10 ✅ | No haptics, no swipe actions — the two canonical one-handed triage affordances. | phone | `mobile package.json` |

## Minor (grouped)

- **Perf/rate-limit:** every draft/send walks `getDialogs(400)` — resolve by
  chat_id via `getEntity` when known; skip the Telegram fetch when the
  Anthropic preflight would fail anyway (`telegram.js:1068,1100`).
- **Data at rest / cloud hygiene:** telegram-cache.json + SQLite plaintext
  (README's "never leaves the Mac" is credentials-only — say so precisely);
  message excerpts in cloud payloads; open signup on the shared default
  project.
- **Mac polish:** sweep progress bar unlabeled + failures fade after 5s;
  cadence stepper ±1 only (14→30 = 16 PATCHes); no draft regenerate/tone UI
  (API supports both); keyboard model half-discoverable (snooze menu
  mouse-only, focus requires a click first); token drift (SetupBanner amber,
  Todos tints, `--space-3-5`).
- **Phone polish:** per-card Modals + entrance animation replays on
  virtualization scroll-back (hoist snooze sheet + expandedKey); Settings
  not refreshable; ago-labels freeze between renders; login keyboard chaining;
  `setBadgeCountAsync` as a zero-infra badge bridge; genuinely-empty queue
  reports `sweptAt: null` (derive from a meta row, not `rows[0]`).
- **Testing debt:** ✅ mostly addressed in Wave 3 — `desktop/test/` runs as
  `npm --prefix desktop test` (queue engine, promise extraction, publisher
  cycle; the M1/M3/M9 invariants are now executable). CI (GitHub Actions)
  still unwired.

---

## Recommended shipping order

**Wave 1 — stop the lying (1–2 sessions).** ✅ shipped (`793382a`)
C1 error/empty/stale states on both clients · C2 send closes the loop
(cache patch + sweepSoon + publishSoon) · M5/M4/M6 health surface: one
backend health endpoint + persistent banners (Telegram/Anthropic/cloud) on
both clients · C5 single-flight refresh + signed-out banner.

**Wave 2 — make triage safe (1 session).** ✅ shipped (`2bf99d6`)
C7 snoozed drawer + unsnooze + undo toasts everywhere (U2) · M8 honest
Done semantics + don't auto-"keep" promises without a send (U3) · C6
client editing (rebind/edit/link-chat — APIs already exist).

**Wave 3 — correctness under sync (1 session).** ✅ shipped (`f1a02a7`)
M1 preserve snooze `created_at` · M2 narrow the clobber window · M3
`rel:` fallback in build_queue · M9 null-activity cold · M7 deepen promise
extraction · commit the test harness so none of this regresses.

**Wave 4 — the pulse (Phase 6 proper).** ✅ shipped (`8c8bfd5`) — C3 Mac side, C4, U8, U10 haptics; Expo push / U4 / U7 / swipes still open
C3 notifications: Mac `new Notification()` post-sweep + Expo push later ·
C4 login item + tray + loud data-age states · U4 QR handoff · U7 icons +
signed builds · U8/U10 a11y + haptics + swipes.
