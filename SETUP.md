# SETUP.md — From this folder to earning: the complete launch guide

Follow these phases in order. Anything marked **[YOU]** needs your personal accounts
and can't be automated.

---

## Phase 1 — Google Cloud OAuth (required for Drive sync)

There's a chicken-and-egg: the OAuth client needs your extension's **ID**, and the
stable ID comes from the Chrome Web Store. Order matters:

1. **[YOU]** Register as a Chrome Web Store developer ($5 one-time):
   https://chrome.google.com/webstore/devconsole — use the Google account you want
   to publish under.
2. Zip this folder (see "Packaging" below) and upload it as a **draft** item.
   Don't submit for review yet. Copy the **Item ID** shown in the dashboard —
   this is your permanent extension ID.
3. **[YOU]** In https://console.cloud.google.com :
   - Create a project (e.g. `drivepass`).
   - **APIs & Services → Library** → enable **Google Drive API**.
   - **APIs & Services → OAuth consent screen** → External → fill app name
     ("DrivePass"), support email, developer email.
   - **Scopes**: add only `https://www.googleapis.com/auth/drive.file`.
     ⚠️ **Never add `drive` or `drive.readonly`** — those are *restricted* scopes
     that trigger a mandatory paid CASA security audit ($540–$4,500/yr) and a
     4–12 week review. `drive.file` is non-sensitive: **no audit, no fee**.
   - **Credentials → Create credentials → OAuth client ID → Chrome Extension**,
     paste the Item ID from step 2.
4. Copy the generated client ID into `manifest.json` → `oauth2.client_id`
   (replacing `REPLACE_WITH_YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com`).
5. For **production verification** (removes the "unverified app" warning):
   - Host the landing page in `docs/` on a domain you control.
   - Verify that domain in https://search.google.com/search-console .
   - On the consent screen, set the app homepage + privacy policy URL to that site
     and submit for verification. `drive.file`-only apps get the lightweight review
     (days, free), not the restricted-scope gauntlet.

## Phase 2 — QA checklist (before submitting for review)

Load unpacked (`chrome://extensions` → Developer mode → Load unpacked) and verify:

- [ ] Create vault → add / edit / delete / search entries
- [ ] 🎲 password generator fills the password field
- [ ] Autofill: visit a login page, focus the password field, pick the saved login
- [ ] Submit a login form → "Save this login?" banner appears → saves
- [ ] 🛡️ Security Center: seed a vault with a reused pair, a weak password
      (e.g. `abc123`), and confirm all three health sections flag correctly
- [ ] Breach check: `password123` should show as breached; watch DevTools → Network
      and confirm the only request is `GET api.pwnedpasswords.com/range/XXXXX`
      (5 hash chars, nothing else)
- [ ] Connect Google Drive → `vault.enc` appears in Drive; sync from a second
      Chrome profile with the same Google account
- [ ] Auto-lock fires after the configured time; Lock button works
- [ ] Change master password → old password no longer unlocks; sync still works

## Phase 3 — Store listing (conversion matters as much as code)

- **Name**: `DrivePass — Password Manager for Google Drive`
- **Summary** (132 chars max): lead with the differentiator, e.g.
  *"Free zero-knowledge password manager. Your encrypted vault lives in YOUR
  Google Drive — no company server to breach."*
- **Description** must include (policy requirements in bold):
  - What it does, the no-server/zero-knowledge angle, "free forever, no ads"
  - **Affiliate disclosure**: "The Security Center includes clearly-marked partner
    links; DrivePass may earn a commission. This is how the free extension is funded."
  - **Permission justifications**: autofill needs access to pages (`http(s)://*/*`);
    `googleapis.com` for Drive sync of your encrypted vault only;
    `api.pwnedpasswords.com` for the opt-in breach check (anonymous hash prefix only).
- **Privacy tab**: privacy policy URL (from `docs/`), declare that authentication
  data is handled locally/encrypted, certify Limited Use compliance.
- **Assets**: 5 × 1280×800 screenshots (popup list, autofill dropdown, Security
  Center health, breach check, options page) + 440×280 small promo tile.
- Deadline note: the tightened Limited Use policy is enforced from **Aug 1, 2026** —
  the disclosures already built into the extension UI cover this, don't remove them.

## Phase 4 — Affiliate programs **[YOU]**

Apply (each takes minutes; approval days–weeks). While waiting, the Recommendations
tab ships with plain product links — swap in tracking links in
`src/security/offers.json` → `url` as approvals land, then push an extension update.

| Partner | Program | Typical commission |
|---|---|---|
| NordVPN | https://nordvpn.com/affiliate/ (via Impact) | ~30–40% + recurring |
| Surfshark | https://surfshark.com/affiliate (via Impact) | ~40% |
| Yubico | via CJ/Impact affiliate networks | ~5–10% hardware |
| DeleteMe | https://joindeleteme.com/affiliates/ | ~25% |
| Aura | via Impact | ~$30–100/signup |
| Backblaze | https://www.backblaze.com/affiliates | ~10–20% |

Compliance rules baked into the design — keep them: links open **only on click**,
disclosure banner stays above the offer grid, nothing in the credential-entry flow,
disclosure repeated in store listing + landing page.

## Phase 5 — Launch

1. Submit for review (first review of a new publisher typically takes a few days).
2. Announce: Product Hunt; Show HN ("Show HN: DrivePass – password manager that
   syncs to your own Google Drive, no server"); r/privacy, r/selfhosted,
   r/chrome_extensions (read each sub's self-promo rules first); X/LinkedIn.
3. The pitch that differentiates: **"After LastPass, why trust anyone's server?
   Your vault, your Drive, zero knowledge, free."**
4. Iterate on reviews; keep the free promise. If you later add a paid tier, add new
   Pro features — never paywall what's free today (the LastPass lesson).

## Packaging

```bash
cd /Volumes/D/ChromeExtentions/drive-password-manager
zip -r ../drivepass-v$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])").zip . \
  -x "*.git*" -x "*.DS_Store" -x "make_icons.py" -x "README.md" -x "SETUP.md" -x "docs/*"
```

## Realistic revenue expectations

Affiliate-only is a volume game. Benchmarks: ~$100–500/mo at 1–5k engaged users
within 6–12 months; VPN conversions pay $30–100 each at ~1–2% of clickers. Growth
compounds through listing SEO, reviews, and the launch posts above. Optional later:
GitHub Sponsors / Buy Me a Coffee link (KeePass model) and an eventual Pro tier
(ExtensionPay/Paddle research is in the plan folder) — both compatible with the
free-forever promise.
