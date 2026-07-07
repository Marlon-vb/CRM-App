# Releasing Cadence

Two artifacts: the Mac `.dmg` (the hub — required) and the iPhone app
(TestFlight via EAS — optional until you want it off Expo Go). Icons for
both are generated from code: `node desktop/scripts/generate-icons.js`
rewrites `desktop/build/icon.png`, `mobile/assets/icon.png`, and
`mobile/assets/splash-icon.png` — re-run it only if you change the design,
the outputs are checked in.

## Mac `.dmg`

### Unsigned (works today, Gatekeeper friction)

```bash
npm --prefix desktop run dist            # arm64 only
npm --prefix desktop run dist:universal  # Intel + Apple Silicon
```

Output lands in `desktop/release/`. Without a signing certificate in the
keychain, electron-builder prints a "skipped macOS code signing" warning and
produces an unsigned app — expected. On another Mac, first launch will claim
the app "is damaged or can't be opened" (it isn't — it's quarantined).
The reliable fix, same as PipeWise:

```bash
xattr -dr com.apple.quarantine /Applications/Cadence.app
```

The right-click → Open trick is unreliable on Sonoma and later.

### Signed + notarized (no Gatekeeper friction)

One-time setup:

1. Join the [Apple Developer Program](https://developer.apple.com/programs/)
   ($99/year, the same membership TestFlight needs).
2. In Xcode (Settings → Accounts → Manage Certificates) or at
   developer.apple.com, create a **Developer ID Application** certificate
   and make sure it's in your login keychain (`security find-identity -v`
   should list it).
3. Create an app-specific password for your Apple ID at
   [appleid.apple.com](https://appleid.apple.com) (Sign-In & Security →
   App-Specific Passwords).

Then:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"   # developer.apple.com → Membership
npm --prefix desktop run dist:signed
```

electron-builder auto-discovers the Developer ID certificate, signs with the
hardened runtime (`desktop/build/entitlements.mac.plist` grants only the two
JIT entitlements Electron needs), and submits to Apple's notary service —
expect notarization to take a few minutes. The resulting `.dmg` opens
anywhere with no xattr dance.

Don't reintroduce `"identity": null` in `desktop/package.json` — its absence
is what lets signing switch on automatically once the certificate exists,
while cert-less machines still build unsigned with a warning.

## iPhone (TestFlight via EAS)

Expo Go is fine for personal use. To put Cadence on TestFlight:

```bash
npm install -g eas-cli
cd mobile
eas login                      # Expo account (free tier is enough to start)
eas build:configure            # writes eas.json, accept iOS defaults
eas build --platform ios       # needs the same Apple Developer membership
eas submit --platform ios      # uploads the build to App Store Connect
```

EAS handles certificates/provisioning interactively on first run. The
bundle id is already set (`com.montyinc.cadence` in `mobile/app.json`),
and the icon + splash land automatically from `mobile/assets/`. After
`eas submit`, add yourself as an internal tester in App Store Connect →
TestFlight.

Note: a TestFlight build no longer runs inside Expo Go, so `npx expo start`
dev sessions and the installed app coexist independently.
