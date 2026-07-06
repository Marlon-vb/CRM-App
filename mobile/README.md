# Cadence mobile — the iPhone companion

A read/act client of what the Mac publishes to Supabase (Phase 4): your
follow-up queue and todos, with done/snooze/complete/resolve flowing back
to the Mac on its next sync (≤5 min). Replies happen in the Telegram app
via deep links — the Telegram session never leaves the Mac.

## Try it TODAY — Expo Go (no build, ~3 minutes)

1. Install **Expo Go** from the App Store on your iPhone.
2. On the Mac:
   ```bash
   cd mobile
   npm install
   npx expo start
   ```
3. Scan the QR code with the iPhone camera (same Wi-Fi). If your network
   blocks device-to-Mac traffic, use `npx expo start --tunnel`.
4. First launch: paste your Supabase **project URL + anon key** (same
   values as the Mac's Settings → Cadence Cloud), then sign in with the
   same email/password.

If `npm install` complains about version alignment, run
`npx expo install --fix` — Expo pins exact versions per SDK.

## Real install — EAS Build → TestFlight (when you're ready)

Needs a free [expo.dev](https://expo.dev) account and an Apple Developer
membership ($99/yr) for TestFlight:

```bash
npx eas-cli login
npx eas-cli build --platform ios --profile production
npx eas-cli submit --platform ios
```

EAS walks you through Apple credentials on first run. The bundle id is
`com.montyinc.cadence` (app.json).

## v1 scope (deliberate)

- **Polling, not websockets** — 45 s while foregrounded + pull-to-refresh.
- **No AI drafts on the phone** — drafting needs the Mac's Anthropic key;
  the phone gives you context (copy conversation) + jumps into Telegram.
- **Todos are act-only** — complete/star sync back; creation stays on the
  Mac (it's the only id-minter for the synced tables).
- **Deep links are best-effort**: supergroups open precisely
  (`t.me/c/<id>/<msg>`); user DMs try `tg://openmessage`; basic groups
  fall back to opening Telegram. Tune on-device if a chat type misses.
