// Encryption round-trip and generator properties. If any of these break, the
// vault is either unreadable or weaker than advertised.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveKey,
  encryptJSON,
  decryptJSON,
  exportRawKey,
  importRawKey,
  randomSalt,
  bytesToB64,
  b64ToBytes,
  generatePassword,
  activeCharSets,
  passwordEntropyBits,
  KDF_ITERATIONS,
} from "../src/lib/crypto.js";

// Keep the tests fast — the cost of the real KDF is not what's under test here.
const TEST_ITERATIONS = 1000;

test("base64 helpers round-trip arbitrary bytes", () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual([...b64ToBytes(bytesToB64(bytes))], [...bytes]);
});

test("base64 round-trips an empty buffer", () => {
  assert.deepEqual([...b64ToBytes(bytesToB64(new Uint8Array(0)))], []);
});

test("encrypt then decrypt returns the original object", async () => {
  const key = await deriveKey("correct horse", randomSalt(), TEST_ITERATIONS);
  const vault = { entries: [{ id: "1", password: "hunter2", notes: "ünïcodé 🔑" }] };
  const { iv, ciphertext } = await encryptJSON(key, vault);
  assert.deepEqual(await decryptJSON(key, iv, ciphertext), vault);
});

test("the wrong password cannot decrypt", async () => {
  const salt = randomSalt();
  const key = await deriveKey("right", salt, TEST_ITERATIONS);
  const wrong = await deriveKey("wrong", salt, TEST_ITERATIONS);
  const { iv, ciphertext } = await encryptJSON(key, { entries: [] });
  await assert.rejects(() => decryptJSON(wrong, iv, ciphertext));
});

test("a different salt yields a different key", async () => {
  const a = await deriveKey("same password", randomSalt(), TEST_ITERATIONS);
  const b = await deriveKey("same password", randomSalt(), TEST_ITERATIONS);
  assert.notEqual(await exportRawKey(a), await exportRawKey(b));
});

test("the same password and salt yield the same key", async () => {
  const salt = randomSalt();
  const a = await deriveKey("same password", salt, TEST_ITERATIONS);
  const b = await deriveKey("same password", salt, TEST_ITERATIONS);
  assert.equal(await exportRawKey(a), await exportRawKey(b));
});

test("tampering with the ciphertext is detected, not silently accepted", async () => {
  // This is the whole point of using GCM rather than CBC.
  const key = await deriveKey("pw", randomSalt(), TEST_ITERATIONS);
  const { iv, ciphertext } = await encryptJSON(key, { entries: [{ id: "1" }] });
  const bytes = b64ToBytes(ciphertext);
  bytes[0] ^= 0x01;
  await assert.rejects(() => decryptJSON(key, iv, bytesToB64(bytes)));
});

test("each encryption uses a fresh IV", async () => {
  const key = await deriveKey("pw", randomSalt(), TEST_ITERATIONS);
  const ivs = new Set();
  for (let i = 0; i < 50; i++) ivs.add((await encryptJSON(key, { n: i })).iv);
  assert.equal(ivs.size, 50, "IV reuse under one key would leak plaintext");
});

test("an exported key can be re-imported and still decrypts", async () => {
  // This is the session-storage rehydration path after a service-worker restart.
  const key = await deriveKey("pw", randomSalt(), TEST_ITERATIONS);
  const { iv, ciphertext } = await encryptJSON(key, { entries: ["x"] });
  const restored = await importRawKey(await exportRawKey(key));
  assert.deepEqual(await decryptJSON(restored, iv, ciphertext), { entries: ["x"] });
});

test("the shipped KDF cost meets current guidance", () => {
  assert.ok(KDF_ITERATIONS >= 210000, `PBKDF2-SHA256 iterations too low: ${KDF_ITERATIONS}`);
});

// ---- generator -----------------------------------------------------------

const LOWER = "abcdefghijkmnpqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{}";
const hasAny = (s, set) => [...s].some((c) => set.includes(c));

test("generated passwords have the requested length", () => {
  for (const n of [1, 2, 4, 8, 20, 64, 128]) {
    assert.equal(generatePassword(n).length, n);
  }
});

test("every selected class appears, on every run", () => {
  for (let i = 0; i < 500; i++) {
    const pw = generatePassword(12, { symbols: true });
    assert.ok(hasAny(pw, LOWER), `no lowercase in ${pw}`);
    assert.ok(hasAny(pw, UPPER), `no uppercase in ${pw}`);
    assert.ok(hasAny(pw, DIGITS), `no digit in ${pw}`);
    assert.ok(hasAny(pw, SYMBOLS), `no symbol in ${pw}`);
  }
});

test("symbols are omitted unless asked for", () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(!hasAny(generatePassword(24), SYMBOLS));
  }
});

test("disabling a class actually excludes it", () => {
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword(16, { upper: false, digits: false });
    assert.ok(!hasAny(pw, UPPER), `uppercase leaked into ${pw}`);
    assert.ok(!hasAny(pw, DIGITS), `digit leaked into ${pw}`);
  }
});

test("long-form option names are honored too", () => {
  // The Generator Studio sends uppercase/lowercase/numbers; these were once
  // silently ignored, so unchecking a box did nothing.
  for (let i = 0; i < 200; i++) {
    assert.ok(!hasAny(generatePassword(16, { uppercase: false }), UPPER));
    assert.ok(!hasAny(generatePassword(16, { numbers: false }), DIGITS));
    assert.ok(!hasAny(generatePassword(16, { lowercase: false }), LOWER));
  }
});

test("disabling every class still produces a usable password", () => {
  const pw = generatePassword(16, { lower: false, upper: false, digits: false, symbols: false });
  assert.equal(pw.length, 16);
  assert.ok(/^[A-Za-z0-9]+$/.test(pw));
});

test("ambiguous characters are never generated", () => {
  const pw = generatePassword(20000, { symbols: true });
  for (const c of "lIO01") assert.ok(!pw.includes(c), `ambiguous ${c} was generated`);
});

test("output is not predictable", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(generatePassword(16));
  assert.equal(seen.size, 500);
});

// ---- the strength claim ---------------------------------------------------
// passwordEntropyBits is what the Generator Studio's meter renders. It is only
// honest if the alphabet it counts is the alphabet the generator really draws
// from — and this generator deliberately drops the ambiguous glyphs, so any
// hardcoded 26/26/10/20 anywhere would overstate every password by several bits.

const OPTION_SETS = [
  {},
  { symbols: true },
  { upper: false, digits: false },
  { uppercase: false, numbers: false, symbols: true },
  { lower: false, upper: false, digits: false, symbols: false }, // the all-off fallback
];

test("the alphabet the meter counts is the one the generator actually draws from", () => {
  for (const opts of OPTION_SETS) {
    const claimed = new Set(activeCharSets(opts).join(""));
    // Long enough that every character of the pool is drawn with overwhelming
    // probability, so a pool the meter knows about but the generator ignores
    // (or vice versa) shows up as a set difference.
    const produced = new Set(generatePassword(20000, opts));
    assert.deepEqual(
      [...produced].sort(),
      [...claimed].sort(),
      `generator and meter disagree on the alphabet for ${JSON.stringify(opts)}`
    );
  }
});

test("entropy is the pool size raised to the length, in bits", () => {
  for (const opts of OPTION_SETS) {
    const poolSize = activeCharSets(opts).join("").length;
    assert.ok(poolSize > 1, `an unusable pool of ${poolSize} for ${JSON.stringify(opts)}`);
    for (const length of [1, 8, 20, 64]) {
      assert.equal(passwordEntropyBits(length, opts), length * Math.log2(poolSize));
    }
  }
});

test("switching every class off reports the fallback alphabet's entropy, not zero", () => {
  // activeCharSets substitutes alnum rather than returning nothing; if the
  // meter read the empty pool instead it would claim -Infinity or 0 bits for a
  // password the generator still produces at ~5.8 bits a character.
  const bits = passwordEntropyBits(16, { lower: false, upper: false, digits: false, symbols: false });
  assert.ok(Number.isFinite(bits) && bits > 0, `entropy came out as ${bits}`);
  assert.equal(bits, passwordEntropyBits(16, { symbols: false }));
});

test("adding symbols raises the claimed entropy, and dropping a class lowers it", () => {
  assert.ok(passwordEntropyBits(20, { symbols: true }) > passwordEntropyBits(20));
  assert.ok(passwordEntropyBits(20, { digits: false }) < passwordEntropyBits(20));
});

test("characters are drawn near-uniformly across the whole pool", () => {
  // The tolerance is derived from the binomial spread rather than hardcoded: at
  // N=200000 over 56 characters the natural run-to-run deviation reaches ~6%, so
  // the old flat 6% bound failed a few runs in a hundred on correct code. Six
  // sigma puts a false alarm out of reach while still catching the bugs this can
  // actually see — a character the generator never emits, an off-by-one that
  // clips the end of the pool, or a draw skewed toward one class.
  //
  // It cannot see modulo bias: randomInt's rejection sampling removes a skew of
  // about one part in 10^8, which no sample of this size could resolve. That
  // property is structural, and lives in randomInt itself.
  const pool = LOWER + UPPER + DIGITS;
  const N = 200000;
  const counts = new Map();
  for (const c of generatePassword(N)) counts.set(c, (counts.get(c) || 0) + 1);
  assert.equal(counts.size, pool.length, "some pool characters never appeared");

  const p = 1 / pool.length;
  const expected = N * p;
  const tolerance = (6 * Math.sqrt(N * p * (1 - p))) / expected;
  for (const c of pool) {
    const dev = Math.abs(counts.get(c) - expected) / expected;
    assert.ok(
      dev < tolerance,
      `'${c}' deviates ${(dev * 100).toFixed(1)}% from uniform, past the ${(tolerance * 100).toFixed(1)}% bound`
    );
  }
});
