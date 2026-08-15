// hibp.js is the only module in the project that sends anything derived from a
// user's password to a third party, so k-anonymity is the whole safety story:
// five hex characters of a SHA-1 leave the device and nothing else does. A
// refactor that widened the prefix, appended the suffix as a query parameter,
// or dropped the Add-Padding header would still return the right breach count
// and still pass a "does it work" test while quietly deanonymising every
// lookup — hence the hard leak assertions below.
//
// Parsing is the second risk: the range body is untrusted text arriving over
// the network, and a throw from the parser surfaces to the user as a health
// check that is simply broken, with no indication that their password may be
// breached.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { installFetch, uninstall } from "./helpers/chrome-mock.js";
import { pwnedCount, pwnedCounts } from "../src/lib/hibp.js";

const API = "https://api.pwnedpasswords.com/range/";

// Computed here rather than hardcoded so the assertions cannot drift away from
// what the module actually hashes (and so a UTF-8 encoding bug is visible).
const sha1 = (text) => createHash("sha1").update(text, "utf8").digest("hex").toUpperCase();
const prefixOf = (text) => sha1(text).slice(0, 5);
const suffixOf = (text) => sha1(text).slice(5);

// A range response never contains only the caller's suffix; it is a few hundred
// unrelated ones. Decoys keep the tests honest about the local match step.
const DECOYS = [
  "0018A45C4D1DEF81644B54AB7F969B88D65:1",
  "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2",
];

const rangeBody = (lines, eol = "\r\n") => lines.join(eol);

let net;

beforeEach(() => {
  net = installFetch();
});

afterEach(() => {
  uninstall();
});

// ---- k-anonymity ----------------------------------------------------------

test("only the first five hex characters of the SHA-1 ever leave the device", async () => {
  // The single most important assertion in this file. If it fails, every
  // password the user checks is being handed to a third party in a form that
  // identifies it.
  const password = "correct horse battery staple";
  const hash = sha1(password);
  net.on(API, { text: rangeBody(DECOYS) });

  await pwnedCount(password);

  assert.equal(net.requests.length, 1);
  const req = net.requests[0];

  assert.equal(req.url, API + hash.slice(0, 5), "the URL must be the range endpoint plus exactly 5 hex chars");
  const url = new URL(req.url);
  assert.equal(url.pathname, "/range/" + hash.slice(0, 5));
  assert.equal(url.search, "", "no part of the hash may be smuggled in a query string");
  assert.equal(req.method, "GET");
  assert.equal(req.body, null, "a range lookup must not carry a request body");

  // Everything the request could possibly carry, in one haystack. Lowercased so
  // a re-encoding of the hash in the other case is still caught.
  const haystack = [req.url, JSON.stringify(req.headers), String(req.body ?? "")].join(" ").toLowerCase();
  const mustNotLeak = {
    "the full SHA-1": hash,
    "the hash suffix": hash.slice(5),
    "the plaintext password": password,
    "the URL-encoded password": encodeURIComponent(password),
  };
  for (const [what, secret] of Object.entries(mustNotLeak)) {
    assert.ok(!haystack.includes(secret.toLowerCase()), `${what} leaked into the request`);
  }
});

test("the request carries no header other than Add-Padding", async () => {
  // Any extra header (an API key, a user agent naming the user's install) would
  // re-identify a request that k-anonymity just anonymised.
  net.on(API, { text: rangeBody(DECOYS) });
  await pwnedCount("hunter2");

  assert.deepEqual(Object.keys(net.lastRequest.headers), ["add-padding"]);
  assert.equal(net.lastRequest.headers["add-padding"], "true");
});

test("a non-ASCII password is hashed as UTF-8, matching the prefix the API expects", async () => {
  // TextEncoder is UTF-8; a swap to latin1 or UTF-16 would query the wrong
  // range and silently report every such password as safe.
  const password = "pässwörd🔑";
  net.on(API, { text: rangeBody(DECOYS) });
  await pwnedCount(password);

  assert.equal(net.lastRequest.url, API + prefixOf(password));
});

test("the plaintext of no password in a batch appears in any request", async () => {
  const passwords = ["tr0ub4dor&3", "letmein", "s3cr3t-do-not-leak"];
  net.on(API, { text: rangeBody(DECOYS) });

  await pwnedCounts(passwords);

  const wire = net.requests.map((r) => r.url + JSON.stringify(r.headers)).join(" ");
  for (const pw of passwords) {
    assert.ok(!wire.includes(pw), `"${pw}" leaked onto the wire`);
  }
});

// ---- matching -------------------------------------------------------------

test("a suffix present in the range comes back with its breach count", async () => {
  const password = "hunter2";
  net.on(API, { text: rangeBody([DECOYS[0], `${suffixOf(password)}:1234`, DECOYS[1]]) });

  assert.equal(await pwnedCount(password), 1234);
});

test("a range that does not contain the suffix reports zero breaches", async () => {
  net.on(API, { text: rangeBody(DECOYS) });
  assert.equal(await pwnedCount("a-password-nobody-has-breached"), 0);
});

test("an empty range body reports zero breaches rather than throwing", async () => {
  net.on(API, { text: "" });
  assert.equal(await pwnedCount("hunter2"), 0);
});

test("the uppercase suffixes the API really returns match the locally computed hash", async () => {
  // The local hash is uppercased before comparison, which is the direction that
  // matters: the live API answers in uppercase.
  const password = "hunter2";
  const suffix = suffixOf(password);
  assert.equal(suffix, suffix.toUpperCase(), "the fixture itself must be uppercase for this test to mean anything");
  net.on(API, { text: rangeBody([`${suffix}:7`]) });

  assert.equal(await pwnedCount(password), 7);
});

test("a lowercase suffix in the response is NOT matched (comparison is case-sensitive)", async () => {
  // CURRENT BEHAVIOUR, and a latent false negative: the parser compares with
  // `===` against an uppercased local hash, so a range served in lowercase
  // would report every breached password as clean. Reported, not fixed.
  const password = "hunter2";
  net.on(API, { text: rangeBody([`${suffixOf(password).toLowerCase()}:7`]) });

  assert.equal(await pwnedCount(password), 0);
});

// ---- parsing robustness ---------------------------------------------------

test("CRLF line endings, blank lines and malformed lines do not break parsing", async () => {
  const password = "hunter2";
  const body = rangeBody([
    DECOYS[0],
    "", // stray blank line mid-body
    "   ", // whitespace-only line
    "NO-COLON-ON-THIS-LINE",
    ":", // colon with nothing either side
    ":42", // count with no suffix
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:12:extra", // more fields than expected
    `${suffixOf(password)}:99`,
    "", // trailing blank line, as the real API sends
  ]);
  net.on(API, { text: body });

  assert.equal(await pwnedCount(password), 99, "the real match must still be found among the noise");
});

test("a body with no trailing newline still matches its last line", async () => {
  const password = "hunter2";
  net.on(API, { text: `${DECOYS[0]}\r\n${suffixOf(password)}:3` });
  assert.equal(await pwnedCount(password), 3);
});

test("a matching line with an unparseable count is reported as one breach", async () => {
  // parseInt(...) || 1 — better to over-report a known-breached password than
  // to drop it, but worth pinning so the fallback is not lost in a refactor.
  const password = "hunter2";
  net.on(API, { text: rangeBody([`${suffixOf(password)}:not-a-number`]) });
  assert.equal(await pwnedCount(password), 1);
});

test("a matching line with a zero count is reported as one breach", async () => {
  // CURRENT BEHAVIOUR. With Add-Padding enabled the API mixes in fake entries
  // whose count is 0 and which the client is supposed to discard; `|| 1` turns
  // such a line into "breached once" instead. Reported, not fixed.
  const password = "hunter2";
  net.on(API, { text: rangeBody([`${suffixOf(password)}:0`]) });
  assert.equal(await pwnedCount(password), 1);
});

// ---- transport failures ---------------------------------------------------

test("a non-ok response throws an error naming the status", async () => {
  for (const status of [400, 429, 500, 503]) {
    net.reset();
    net.on(API, { status });
    await assert.rejects(
      () => pwnedCount("hunter2"),
      (err) => {
        assert.match(err.message, /breach service unavailable/i);
        assert.match(err.message, new RegExp(String(status)), `status ${status} should be in the message`);
        return true;
      }
    );
  }
});

test("a network-level failure propagates instead of being reported as zero breaches", async () => {
  // Reporting 0 on a failed request would tell the user a breached password is
  // safe, which is worse than showing an error.
  net.on(API, { throws: new TypeError("Failed to fetch") });
  await assert.rejects(() => pwnedCount("hunter2"), /Failed to fetch/);
});

// ---- pwnedCounts: batching ------------------------------------------------

// Serve each password's own range, so a batch's values can be told apart.
function serveCounts(pairs) {
  const byPrefix = new Map();
  for (const [password, count] of pairs) {
    const hash = sha1(password);
    byPrefix.set(hash.slice(0, 5), `${hash.slice(5)}:${count}`);
  }
  net.on(API, (req) => {
    const line = byPrefix.get(req.url.slice(-5));
    return { text: rangeBody(line ? [DECOYS[0], line] : DECOYS) };
  });
}

test("each unique password's count comes back keyed by the password", async () => {
  serveCounts([["alpha", 5], ["beta", 12]]);
  const results = await pwnedCounts(["alpha", "beta", "gamma"]);

  assert.equal(results.get("alpha"), 5);
  assert.equal(results.get("beta"), 12);
  assert.equal(results.get("gamma"), 0);
});

test("a password repeated in the list costs exactly one request", async () => {
  net.on(API, { text: rangeBody(DECOYS) });
  const results = await pwnedCounts(["reused", "other", "reused", "reused"]);

  assert.equal(net.requests.length, 2, "the same password must not be hashed and queried twice");
  assert.deepEqual([...results.keys()], ["reused", "other"]);
});

test("falsy entries are dropped instead of being hashed and sent", async () => {
  net.on(API, { text: rangeBody(DECOYS) });
  const results = await pwnedCounts(["", null, undefined, false, 0, "real"]);

  assert.deepEqual([...results.keys()], ["real"]);
  assert.equal(net.requests.length, 1);
});

test("an empty list makes no requests and reports no progress", async () => {
  const calls = [];
  const results = await pwnedCounts([], (done, total) => calls.push([done, total]));

  assert.equal(results.size, 0);
  assert.equal(net.requests.length, 0);
  assert.deepEqual(calls, []);
});

test("onProgress fires once per unique password with a strictly increasing count", async () => {
  // The security page renders this straight into "Checked N of M" text, so a
  // duplicate or skipped tick is a visible bug.
  net.on(API, { text: rangeBody(DECOYS) });
  const calls = [];
  await pwnedCounts(["a", "b", "c", "d", "e", "f", "a"], (done, total) => calls.push([done, total]));

  assert.deepEqual(calls, [[1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6]]);
});

test("no more than four range requests are ever in flight at once", async () => {
  // The API is unauthenticated and unmetered but not free to hammer; the cap is
  // also what keeps a large vault from opening 300 sockets at once.
  let inFlight = 0;
  let peak = 0;
  net.on(API, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight--;
    return { text: rangeBody(DECOYS) };
  });

  const passwords = Array.from({ length: 20 }, (_, i) => `password-${i}`);
  const results = await pwnedCounts(passwords);

  assert.equal(results.size, 20);
  assert.equal(net.requests.length, 20);
  assert.equal(peak, 4, "the pool should saturate at exactly four, no more and no fewer");
});

test("one failing range request rejects the whole batch", async () => {
  // CURRENT BEHAVIOUR: there is no per-password isolation, so a single 503
  // discards the results for every other password that already succeeded.
  const bad = prefixOf("boom");
  net.on(API, (req) => (req.url.endsWith(bad) ? { status: 503 } : { text: rangeBody(DECOYS) }));

  await assert.rejects(() => pwnedCounts(["fine", "boom"]), /503/);
});
