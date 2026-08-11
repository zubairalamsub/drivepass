// hibp.js — Have I Been Pwned "Pwned Passwords" range API client.
//
// Privacy model (k-anonymity): the password is hashed with SHA-1 locally and
// ONLY the first 5 hex characters of the hash are sent to the API. The API
// returns every known-breached hash suffix in that range (several hundred),
// and the match is checked locally. The password itself never leaves the
// device, and the service cannot tell which — if any — suffix we wanted.
//
// API docs: https://haveibeenpwned.com/API/v3#PwnedPasswords
// The range endpoint is free, unauthenticated, and not rate limited.

const API = "https://api.pwnedpasswords.com/range/";

async function sha1Hex(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// Number of known breaches this password appears in (0 = none found).
export async function pwnedCount(password) {
  const hash = await sha1Hex(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const res = await fetch(API + prefix, {
    // Pads the response with fake entries so ranges can't be fingerprinted
    // by response size on the wire.
    headers: { "Add-Padding": "true" },
  });
  if (!res.ok) throw new Error("Breach service unavailable (" + res.status + ").");
  const body = await res.text();
  for (const line of body.split("\n")) {
    const [suf, count] = line.trim().split(":");
    if (suf === suffix) return parseInt(count, 10) || 1;
  }
  return 0;
}

// Check many passwords with limited concurrency. Identical passwords are
// only checked once. Returns Map<password, breachCount>.
// onProgress(done, total) fires after each network check completes.
export async function pwnedCounts(passwords, onProgress) {
  const unique = [...new Set(passwords.filter(Boolean))];
  const results = new Map();
  let done = 0;
  const CONCURRENCY = 4;

  let next = 0;
  async function worker() {
    while (next < unique.length) {
      const pw = unique[next++];
      results.set(pw, await pwnedCount(pw));
      done++;
      onProgress?.(done, unique.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  return results;
}
