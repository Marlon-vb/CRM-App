# Cadence Cloud — one-time setup

Cadence Cloud is the bridge to the iPhone app: after every sweep the Mac
publishes the computed queue, todos, promises, and snoozes to a Supabase
project; the phone reads them and its actions (complete / snooze / resolve)
flow back on the next sync. **Your Telegram session, Anthropic key, and
Granola key never leave the Mac.**

## 1. Have a Supabase project

Cadence ships pointed at the old PipeWise project as a default — if that
project still exists in your [dashboard](https://supabase.com/dashboard),
skip to step 2. If it's gone (or you want a fresh one):

1. Dashboard → **New project** (free tier is plenty) → any name/region →
   wait ~1 min for provisioning.
2. Project **Settings → API** → copy the **Project URL** and the
   **anon public** key.
3. In Cadence: Settings → Cadence Cloud → **use a different project** →
   paste both → Save. The URL is validated live before it persists, and
   any previous session is cleared (auth accounts are per-project).

## 2. Apply the schema (once per project)

SQL Editor → New query → paste the whole of
[`cloud/supabase-schema.sql`](./supabase-schema.sql) → Run. Idempotent —
re-running after a schema update is safe. The tables are all
`cadence_`-prefixed, so they coexist with PipeWise's in a shared project.

## 3. Sign in

Settings → **Cadence Cloud** → email + password. On a fresh project use
**Create account** (accounts live inside the project — a deleted project
took its users with it). If Supabase's email confirmation is on, confirm
from your inbox, then sign in. The first publish fires seconds later; the
section shows "synced Xs ago" once it lands, or the exact error if not.

## Security model

- The **anon key** is public by design; Row Level Security
  (`user_id = auth.uid()` on every `cadence_` table) is the boundary.
- Auth tokens are stored in the encrypted settings store (macOS Keychain
  via safeStorage) — they're `_SECRET_FIELDS`, same as your API keys.
- Queue-item payloads include recent message excerpts (the same ~200-char
  snippets the local telegram cache holds) — that is the most sensitive
  data that leaves the Mac. Pause publishing anytime in Settings.

## Sync mechanics (for the curious)

One cycle = **pull then push**. Pull applies the phone's edits locally
(todo flips, snoozes with a `cleared` tombstone for unsnooze, promise
resolutions), the queue rebuilds with those edits absorbed, then the push
mirrors relationships/todos/promises, the authoritative snooze set, and
the fresh queue (stale items deleted). Rows are keyed `(user_id,
local_id)` — the Mac is the only id-minter, so there's no cross-device id
reconciliation. Conflicts fall to last-write-wins on `updated_at`; the
pull cursor only advances from pulled rows, so a phone edit can never be
skipped by racing a push. Triggers: after every sweep, ~1.5 s after any
local mutation (debounced), every 5 minutes for phone edits, and the
"Sync now" button.
