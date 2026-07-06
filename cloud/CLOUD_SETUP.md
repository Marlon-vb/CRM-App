# Cadence Cloud — one-time setup

Cadence Cloud is the bridge to the iPhone app: after every sweep the Mac
publishes the computed queue, todos, promises, and snoozes to a Supabase
project; the phone reads them and its actions (complete / snooze / resolve)
flow back on the next sync. **Your Telegram session, Anthropic key, and
Granola key never leave the Mac.**

## 1. Apply the schema (once)

Cadence ships pointed at the same Supabase project as PipeWise — the
tables are `cadence_`-prefixed, so the two apps coexist without touching
each other's data, and your existing PipeWise account signs straight in.

1. Open your project at [supabase.com/dashboard](https://supabase.com/dashboard)
   (project `oslmpcsfqkqsmjhcylgb` unless you overrode it).
2. SQL Editor → New query → paste the whole of
   [`cloud/supabase-schema.sql`](./supabase-schema.sql) → Run.
3. It's idempotent — re-running after a schema update is safe.

## 2. Sign in

Settings → **Cadence Cloud** → your PipeWise cloud email + password (or
Create account). The first publish fires seconds later; the section shows
"synced Xs ago" once it lands, or the exact error if it didn't.

## Using a different Supabase project

Create a project, run the schema there, then set `cloudUrl` and
`cloudAnonKey` in the settings store (no UI yet — `POST /api/setup/keys`
won't take them; use the dev console or ask for the Settings field).
Overrides always win over the bundled defaults.

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
