# DrivePass — Password Manager

A free, zero-knowledge password manager for Chrome. Your encrypted vault lives in
**your own Google Drive** — there is no DrivePass server, so there is no company
database to breach, no account to create, and no subscription to pay.

## How it works

```
master password ──PBKDF2-SHA256 (210,000 iterations)──▶ AES-256-GCM key
vault JSON      ──AES-256-GCM (random IV per save)────▶ vault.enc
```

- The master password and derived key **never leave your device**. The key is held
  only in `chrome.storage.session` (in-memory, cleared when the browser closes).
- Google Drive stores a single ciphertext file, `vault.enc`. The extension uses the
  narrow `drive.file` OAuth scope: it can see **only the file it created**, nothing
  else in your Drive.
- Works fully offline/local before Drive is connected — connecting Drive simply
  turns on sync across your devices (last-write-wins merge per entry).
- Autofill matches saved logins by hostname and offers a "save this login?" banner
  after form submissions.
- The **Security Center** checks for reused / weak / old passwords locally, and can
  optionally check passwords against known breaches via the Have I Been Pwned
  range API — only an anonymous 5-character SHA-1 hash prefix is ever sent
  (k-anonymity; the password itself cannot be reconstructed).

## Repository layout

```
manifest.json                 MV3 manifest (oauth2 client_id must be configured — see SETUP.md)
src/background/service-worker.js  Session key holder, message router, Drive sync, auto-lock
src/lib/crypto.js             PBKDF2 + AES-GCM + password generator
src/lib/vault.js              Vault file format, CRUD, merge, host matching
src/lib/drive.js              Google Drive API client (drive.file scope)
src/lib/hibp.js               HIBP Pwned Passwords k-anonymity client
src/popup/                    Toolbar popup (create/unlock/list/edit)
src/options/                  Settings page (Drive connect, auto-lock, change master password)
src/security/                 Security Center (health, breach check, recommendations)
src/content/content.js        Autofill dropdown + save-login banner
docs/                         Landing page + privacy policy (GitHub Pages ready)
```

## Development

1. Complete the one-time Google OAuth setup in [SETUP.md](SETUP.md) (the extension
   runs local-only without it — everything except Drive sync works).
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this
   folder.

## Monetization & policy stance

DrivePass is free, has **no ads**, and collects **no data**. Revenue comes solely
from clearly-disclosed partner (affiliate) links in the Security Center's
Recommendations tab, in compliance with the Chrome Web Store affiliate-ads policy:
links are disclosed in the UI and store listing, provide genuine user benefit, and
activate only on explicit user click. See [SETUP.md](SETUP.md) for the affiliate
program list and link-swap procedure.

## Security model in one paragraph

Everything sensitive is encrypted client-side before it touches disk or network.
A stolen `vault.enc` is useless without the master password (PBKDF2 210k + AES-256-GCM
with authentication — tampering or a wrong password fails decryption). There is no
password reset: if the master password is forgotten, the vault is unrecoverable by
design — including by us, because we run no servers and hold no keys.
