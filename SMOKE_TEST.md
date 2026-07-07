# Cadence — Mac smoke test (Phase 0–2 gate)

The sandbox already verified the engine, API, and rendering. This checklist
covers the things only a real Mac with your real accounts can test: Electron,
Telegram login + sweep, Anthropic drafting, Granola sync, and send.

## A — Get it running

```bash
# 1. Get the branch
git clone git@github.com:Marlon-vb/CRM-App.git cadence && cd cadence
git checkout claude/pipewise-light-todo-2iam96

# 2. Install both packages
npm --prefix app install
npm --prefix desktop install

# 3. Rebuild the native module for Electron (better-sqlite3 ABI)
npm --prefix desktop run rebuild

# 4. Launch
./dev_launch.command
```

Step 3 matters: `npm install` compiles better-sqlite3 for your system Node,
but Electron needs its own ABI. Skipping it is the classic
`NODE_MODULE_VERSION` crash on first launch — the fix is running step 3.

If the app window opens on the onboarding wizard: Phase 0 passes. ☑

## B — Onboarding

1. **Profile** — name / role / company (feeds every LLM prompt).
2. **Connect Telegram** — phone number → login code from your Telegram app →
   2FA password if you have one. Repeated failed logins can trigger
   Telegram's FLOOD_WAIT; if you hit it, wait the stated time — don't retry.
3. **Keys** — Anthropic (required for drafts + extraction), Granola
   (optional).

Landing on the Queue tab afterwards: onboarding passes. ☑

## C — Core loop, in order

1. **First sweep** — the progress bar should appear at the top and complete
   without sticking. ☑
2. **Add a client** — Clients tab → add with the *exact* Telegram group
   name. Or check the Queue rail's **New conversations** block and click
   Track on something the sweep detected. ☑
3. **Wait ~1 min** — adding a client schedules a sweep automatically
   (~3 s later, plus up to 60 s for the UI's background watcher to pick up
   the result) → the client row shows last-touch age and its cards appear
   in the Queue. ☑
4. **Reply card** — a chat where the other side spoke last shows up as
   "reply owed" with the last 3 messages. ☑
5. **Draft** — Generate draft on that card → a Haiku draft in your voice
   (tests the Anthropic key; voice files in `~/Desktop/voice/*.md` are
   picked up if present). ☑
6. **Send — use a SAFE test group.** Create a Telegram group with just
   yourself + a second account, bind it as a client, then: Send → watch the
   2-second "click to undo" state → let it fire → confirm the message
   arrives in Telegram and the card clears. Also test clicking undo. ☑
7. **Snooze semantics** — snooze a card "After they reply", have the other
   account send a message, re-sweep → the card resurfaces. ☑
8. **Mark handled** → card gone (it returns tomorrow 09:00 — that's the
   design, not a delete). ☑
9. **Todos** — Scan/refresh → extracted items from recent chats with
   Telegram source badges, no duplicates on a second scan. Add
   "Send deck Friday" → lands in the right bucket with a due date. ☑
10. **Granola** (if key set) — after a recent meeting, sync → the meeting
    should match to its client (via attendee email or company name) and a
    "recap due" card appears if you haven't messaged that chat since.
    Generate the recap draft. ☑
11. **Warm restart** — quit and relaunch: the Queue should populate
    immediately from the cached sweep, no blank screen. ☑

## D — Import your PipeWise book (Phase 3)

Quit Cadence first (two writers on one SQLite file is asking for trouble),
then:

```bash
cp ~/path/to/pipewise/CRM/data/pipewise.db /tmp/pipewise-copy.db   # belt & braces
npm --prefix desktop run import-pipewise /tmp/pipewise-copy.db
```

The npm script runs the importer under **Electron's** Node
(`ELECTRON_RUN_AS_NODE`), matching the ABI `npm run rebuild` compiled
better-sqlite3 for — plain `node desktop/scripts/import-pipewise.js` fails
with a NODE_MODULE_VERSION mismatch after the Electron rebuild, by design.

Expected: every deal lands as a client (lost → archived, per-deal cadence
from stage defaults or your overrides, contact emails carried over), todos
with completion/tombstone state intact, Granola notes linked, open promises
alive. Relaunch — the first sweep binds the chats. Re-running without
`--force` refuses; with `--force` it matches rows instead of duplicating. ☑

## E — Multi-chat + DM detection

1. After a sweep, the Queue's **Suggested clients** block should offer DMs
   whose contact name matches a tracked client ("DM · attach to Acme") —
   accepting links the DM to that client (visible as an `@` chip on the
   Clients row; `×` unlinks). ☑
2. Have the DM person message you while the group is quiet → the client's
   queue card should flip to reply-owed with the DM's messages, and Send
   should land **in the DM**, not the group. ☑

## F — Cloud publish (Phase 4)

1. Run `cloud/supabase-schema.sql` once in your Supabase project's SQL
   editor (details: `cloud/CLOUD_SETUP.md`). ☑
2. Settings → Cadence Cloud → sign in with your PipeWise cloud account →
   within seconds the section reads "synced Xs ago". ☑
3. In the Supabase dashboard Table Editor: `cadence_queue_items` mirrors
   your Queue (one row per card, payload carries the whole item);
   `cadence_todos` has your todo count; snooze something on the Mac →
   Sync now → the row appears in `cadence_snoozes`. ☑
4. Pause / Resume toggles publishing; Sign out stops it. ☑

## G — iPhone (Expo Go)

1. iPhone: install **Expo Go** from the App Store. Mac:
   `cd mobile && npm install && npx expo start` → scan the QR with the
   camera (same Wi-Fi; `--tunnel` if blocked). ☑
2. First launch: tap **Scan setup code** and point the camera at the QR in
   Mac Settings → Cadence Cloud → **Set up iPhone** — the project fills in
   itself (fallback: paste the URL + anon key manually). Then sign in with
   the same email/password. ☑
3. Queue mirrors the Mac's; pull-to-refresh works; **Open in Telegram**
   lands in the right chat (supergroups precise, DMs best-effort). ☑
4. Snooze a card on the phone → within ~5 min the Mac's sync applies it
   and the card leaves the Mac's queue too. Complete a todo on the phone →
   same. ☑

## H — The pulse (audit Wave 4)

1. Menubar shows the Cadence dot with the queue count next to it; the dock
   icon carries the same badge. Handle a card → both counts drop after the
   app refetches. ☑
2. Click the tray icon → menu shows the count line, **Open Cadence**,
   **Sync now**, **Quit Cadence**. "Open" raises the window even after
   closing it — the backend keeps sweeping with the window closed. ☑
3. With the app running, have a tracked client send you a Telegram message,
   then wait for the next sweep (or tray → Sync now): a macOS notification
   "Reply owed — <client>" appears; clicking it focuses Cadence. Launch
   never re-announces the existing queue. ☑
4. Settings → **Start at login**: toggle it, then check System Settings →
   General → Login Items (packaged app only; dev builds skip
   registration). ☑
5. iPhone: actions buzz (success on Handled/Snooze/complete, light tap on
   expand/star), faint text is readable, high-priority todos show a "!" in
   the check circle, VoiceOver reads every button meaningfully. ☑
6. Slim window: the app opens as a narrow column (~480px). The sidebar is
   a top icon bar; the Queue is a single-column list — tapping an item
   opens the card with a "← Queue" button back. Drag the window wider than
   ~860px and the full sidebar + two-pane layout returns; the size sticks
   across relaunches. ☑

## I — Client mode (second Mac)

Set up on a Mac that is NOT your hub (your hub — the one with Telegram —
keeps running):

1. Fresh install → onboarding asks "How will you use this Mac?" → pick
   **Track my todos from here (client)**. ☑
2. Enter your project URL + anon key (from your hub's Settings → Cadence
   Cloud → Set up iPhone, the two values under the QR), then sign in with
   the same email/password. The app lands on the Queue. ☑
3. Queue + Todos mirror your hub. There's **no Clients tab**, no Telegram
   settings, no sweep bar — the header reads "hub synced Xm ago". ☑
4. Open a queue card: you get **Mark handled** + **Snooze** (no reply
   drafting/sending — "reply from your phone or hub Mac"). Handling a card
   hides it; within ~5 min your hub republishes and it's gone for real. ☑
5. Complete/star a todo here → within ~5 min it's done on the hub and the
   phone too. Task text / priority / due are read-only ("set on your hub"). ☑
6. **Safety check**: on the hub, your book is untouched — the client never
   published anything. (`backend/server.js` logs `[mode] CLIENT` at boot;
   `npm --prefix desktop test` covers "a client never pushes".) ☑

## J — If something fails

- **Backend logs**: launch from a terminal (`./dev_launch.command`) and read
  stdout — the dev API token prints as `[auth] API token (dev): …`, sweep
  and extraction activity logs live there too.
- **curl debugging**: use that token as `X-Cadence-Token` against
  `http://localhost:3456/api/*` (endpoint list prints at startup).
- **Blank window**: check the terminal for a backend crash; if it mentions
  NODE_MODULE_VERSION → run `npm --prefix desktop run rebuild`.
- **Sweep stuck at 0%**: Telegram not connected (Settings shows state) or
  FLOOD_WAIT — the progress slot self-heals on the next sweep either way.

Anything broken: note which checklist number + the terminal output, and
hand both to the next Claude session.
