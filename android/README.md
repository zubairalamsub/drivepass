# DrivePass for Android (preview)

A read-only Android companion to the Chrome extension. It opens the same
`vault.enc` the extension keeps in your Google Drive and decrypts it on the
device. It uses the same PBKDF2-SHA256 → AES-256-GCM scheme, so nothing is
re-encrypted or converted.

## What it does

- **Open your vault from Google Drive**, either way round:
  - *Connect Google Drive* signs in with the same `drive.file` scope the
    extension uses and fetches `vault.enc` over the Drive REST API. Requires an
    **Android** OAuth client in the Cloud project, registered with the package
    name and the signing certificate's SHA-1.
  - *Choose vault file* picks `vault.enc` through the system file picker, with
    Drive's own app doing the fetching. No network call from this app at all.

  `drive.file` only exposes files an app created or that the user explicitly
  handed to it. The grant turns out to follow the **Cloud project**, not the
  individual OAuth client, so an Android client registered alongside the
  extension's client sees the `vault.enc` the extension created — verified
  against a real vault on 2026-11-10. Should a setup ever not, *Choose vault
  file* once hands the file over explicitly. The picked file is remembered, so
  next time it's one tap, and either source is re-read on every unlock, so
  changes from the extension show up.
- **Browse and search** logins, cards, secure notes and passkeys, with filters
  for each type, favourites and 2FA.
- **Authenticator** — a screen of its own, reached from the clock button in the
  vault's toolbar, listing every entry that has a 2FA secret with its live code
  and a countdown ring. Tap a row to copy the code. Codes are SHA-1, six digits,
  thirty seconds: per-entry `otpauth://` parameters are parsed for the secret
  only, which is also what the extension does, so the two agree.
- **Copy** usernames, passwords, card details and live 2FA codes. Copies are
  marked sensitive and cleared from the clipboard after 30 seconds.
- **Quick unlock** with a fingerprint or a DrivePass PIN, so reopening a vault
  does not mean retyping the master password. The derived key is wrapped by a
  hardware-backed Android Keystore key and never leaves the device; five wrong
  PINs erases it and forces the master password.
- **Auto-lock** after 5 minutes in the background. Screenshots and the Recents
  thumbnail are blocked.
- Light and dark themes that follow the system, using the extension's colours
  and icons.

It cannot add or edit entries yet, and it does not provide Android autofill.

## Building

Open the `android/` folder in Android Studio (Ladybug or newer) and run the
`app` configuration, or from the command line:

```sh
cd android
gradle :app:assembleDebug        # build
gradle :app:testDebugUnitTest    # JVM golden-vector tests
gradle :app:connectedAndroidTest # on-device interop + TOTP tests
```

The bundled demo vault's password is `correct-horse-battery-staple`.
