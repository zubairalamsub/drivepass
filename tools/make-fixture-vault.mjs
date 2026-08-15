// Writes a real vault.enc using the extension's OWN crypto, so other clients
// can be tested against a file this codebase actually produced rather than one
// hand-rolled to match a spec. Output is safe to commit: it contains only
// obviously-fake credentials, and the password is printed below.
//
//   node tools/make-fixture-vault.mjs [outPath]

import { writeFileSync } from "node:fs";
import { createVaultFile, sealVault, newEntry } from "../src/lib/vault.js";

const PASSWORD = "correct-horse-battery-staple";
const out = process.argv[2] || "conformance/vault.enc";

// Fixed ids/timestamps so the file is reproducible across runs (the envelope
// still differs each time — fresh salt and IV — but the payload does not).
const T = Date.UTC(2026, 0, 15, 9, 30, 0);
const mk = (i, data) =>
  newEntry({ id: `fixture-${String(i).padStart(2, "0")}`, createdAt: T, ...data });

const entries = [
  mk(1, { type: "login", name: "GitHub", url: "https://github.com", username: "octocat@example.com", password: "Xk9#mQ2vLp4nR7wZ", totp: "JBSWY3DPEHPK3PXP", favorite: true }),
  mk(2, { type: "login", name: "Google", url: "https://accounts.google.com", username: "octocat@example.com", password: "Tr0ub4dor&3-example", totp: "JBSWY3DPEHPK3PXP", favorite: true }),
  mk(3, { type: "login", name: "Atlassian", url: "https://example.atlassian.net", username: "octocat@example.com", password: "weak123" }),
  mk(4, { type: "login", name: "Unicode Test ünïcodé 🔐", url: "https://unicode.example", username: "tëst@example.com", password: "Pässwörd-🔐-Ω≈ç" }),
  mk(5, { type: "card", name: "Visa — Example", card: { holder: "OCTO CAT", number: "4111111111111111", expMonth: "09", expYear: "28", cvv: "123" } }),
  mk(6, { type: "note", name: "Recovery codes", notes: "a1b2-c3d4\ne5f6-g7h8\n(fixture data — not real)" }),
  mk(7, { type: "passkey", name: "Cloudflare", url: "https://dash.cloudflare.com", passkey: { rpId: "cloudflare.com", credentialId: "QUJDRA==", userName: "octocat" } }),
  mk(8, { type: "login", name: "Deleted Example", url: "https://gone.example", username: "old@example.com", password: "irrelevant" }),
];
entries[7].deletedAt = T + 1000; // one tombstoned entry, to exercise liveEntries

const { file, key } = await createVaultFile(PASSWORD);
const sealed = await sealVault(key, { entries, purged: ["fixture-99-purged"] }, file);

writeFileSync(out, JSON.stringify(sealed, null, 2) + "\n", "utf8");

const live = entries.filter((e) => !e.deletedAt).length;
console.log(`wrote ${out}`);
console.log(`  master password : ${PASSWORD}`);
console.log(`  format          : ${sealed.format} / ${sealed.kdf} / ${sealed.iterations} iters`);
console.log(`  entries         : ${entries.length} total, ${live} live, 1 tombstoned, 1 purged id`);
console.log(`  ciphertext      : ${sealed.ciphertext.length} b64 chars`);
console.log(`  live names      : ${entries.filter((e) => !e.deletedAt).map((e) => e.name).join(" | ")}`);
