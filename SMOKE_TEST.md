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

## F — If something fails

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
