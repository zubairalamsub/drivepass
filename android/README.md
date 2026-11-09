# DrivePass for Android (preview)

A read-only Android companion to the Chrome extension. It opens the same
`vault.enc` the extension keeps in your Google Drive and decrypts it on the
device. It uses the same PBKDF2-SHA256 → AES-256-GCM scheme, so nothing is
re-encrypted or converted.

## What it does

- **Open your vault from Google Drive.** Tap *Choose vault file* and select
  `vault.enc` from Drive in the system file picker. Nothing is downloaded by
  hand, and the app asks for no network permission (Drive's own app does the
  fetching). The file is remembered, so next time it's one tap, and it is
  re-read on every unlock, so changes from the extension show up.
- **Browse and search** logins, cards, secure notes and passkeys, with filters
  for each type, favourites and 2FA.
- **Copy** usernames, passwords, card details and live 2FA codes. Copies are
  marked sensitive and cleared from the clipboard after 30 seconds.
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
