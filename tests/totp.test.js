// TOTP checked against the RFC 6238 reference vectors. A generator that is
// merely plausible is worthless here — a wrong code locks the user out of the
// account the vault is supposed to get them into.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateTOTP,
  getTotpTimeRemaining,
  parseTotpSecret,
  parseOtpauthURI,
} from "../src/lib/totp.js";

// RFC 6238 Appendix B: ASCII seed "12345678901234567890", HMAC-SHA1.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_VECTORS = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
];

for (const [seconds, expected] of RFC_VECTORS) {
  test(`RFC 6238 vector at T=${seconds} produces ${expected}`, async () => {
    const code = await generateTOTP(RFC_SECRET, seconds * 1000, 30, 8);
    assert.equal(code, expected);
  });
}

test("six-digit codes are the low six digits of the reference values", async () => {
  for (const [seconds, expected] of RFC_VECTORS) {
    const code = await generateTOTP(RFC_SECRET, seconds * 1000, 30, 6);
    assert.equal(code, expected.slice(-6), `at T=${seconds}`);
  }
});

test("codes are zero-padded to the requested width", async () => {
  // T=1234567890 -> 89005924; the six-digit form starts with a zero.
  assert.equal(await generateTOTP(RFC_SECRET, 1234567890 * 1000, 30, 6), "005924");
});

test("the code is stable within a period and changes at the boundary", async () => {
  const at = (s) => generateTOTP(RFC_SECRET, s * 1000, 30, 6);
  assert.equal(await at(30), await at(59), "same 30s window");
  assert.notEqual(await at(59), await at(60), "next window");
});

test("lowercase and space-separated secrets are accepted", async () => {
  const expected = await generateTOTP(RFC_SECRET, 59000, 30, 8);
  assert.equal(await generateTOTP(RFC_SECRET.toLowerCase(), 59000, 30, 8), expected);
  assert.equal(await generateTOTP("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ", 59000, 30, 8), expected);
});

test("an otpauth URI works wherever a bare secret does", async () => {
  const uri = `otpauth://totp/GitHub:alice@example.com?secret=${RFC_SECRET}&issuer=GitHub`;
  assert.equal(await generateTOTP(uri, 59000, 30, 8), "94287082");
});

test("a non-default period is honored", async () => {
  const a = await generateTOTP(RFC_SECRET, 59000, 60, 8);
  const b = await generateTOTP(RFC_SECRET, 59000, 30, 8);
  assert.notEqual(a, b);
});

test("unusable secrets yield null rather than a bogus code", async () => {
  for (const bad of ["", null, undefined, "!!!!", "1111"]) {
    assert.equal(await generateTOTP(bad, 59000), null, `input: ${JSON.stringify(bad)}`);
  }
});

// ---- parsing --------------------------------------------------------------

test("parseTotpSecret normalizes a bare secret", () => {
  assert.equal(parseTotpSecret("  jbsw y3dp ehpk 3pxp "), "JBSWY3DPEHPK3PXP");
});

test("parseTotpSecret extracts the secret from an otpauth URI", () => {
  assert.equal(
    parseTotpSecret("otpauth://totp/Example:bob?secret=JBSWY3DPEHPK3PXP&issuer=Example"),
    "JBSWY3DPEHPK3PXP"
  );
});

test("parseTotpSecret returns empty for nothing usable", () => {
  assert.equal(parseTotpSecret(""), "");
  assert.equal(parseTotpSecret(null), "");
  assert.equal(parseTotpSecret("otpauth://totp/NoSecretHere"), "");
});

test("parseOtpauthURI splits issuer and account out of the label", () => {
  const p = parseOtpauthURI("otpauth://totp/GitHub:alice@example.com?secret=ABCD&issuer=GitHub");
  assert.equal(p.issuer, "GitHub");
  assert.equal(p.account, "alice@example.com");
  assert.equal(p.secret, "ABCD");
  assert.equal(p.period, 30);
  assert.equal(p.digits, 6);
});

test("parseOtpauthURI falls back to the label when there is no issuer param", () => {
  const p = parseOtpauthURI("otpauth://totp/Acme:carol?secret=ABCD");
  assert.equal(p.issuer, "Acme");
  assert.equal(p.account, "carol");
});

test("parseOtpauthURI reads a custom period and digit count", () => {
  const p = parseOtpauthURI("otpauth://totp/X:y?secret=ABCD&period=60&digits=8");
  assert.equal(p.period, 60);
  assert.equal(p.digits, 8);
});

test("parseOtpauthURI rejects anything that isn't a TOTP URI", () => {
  assert.equal(parseOtpauthURI("https://example.com/?secret=ABCD"), null);
  assert.equal(parseOtpauthURI("otpauth://totp/NoSecret"), null);
  assert.equal(parseOtpauthURI("not a url"), null);
  assert.equal(parseOtpauthURI(""), null);
  assert.equal(parseOtpauthURI(null), null);
});

// ---- countdown -----------------------------------------------------------

test("time remaining counts down within the period", () => {
  assert.equal(getTotpTimeRemaining(30, 0), 30);
  assert.equal(getTotpTimeRemaining(30, 1000), 29);
  assert.equal(getTotpTimeRemaining(30, 29000), 1);
  assert.equal(getTotpTimeRemaining(30, 30000), 30);
  assert.equal(getTotpTimeRemaining(60, 10000), 50);
});

test("time remaining always falls within 1..period", () => {
  for (let s = 0; s < 200; s++) {
    const left = getTotpTimeRemaining(30, s * 1000);
    assert.ok(left >= 1 && left <= 30, `t=${s} gave ${left}`);
  }
});
