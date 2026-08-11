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

test("characters are drawn near-uniformly (no modulo bias)", () => {
  const pool = LOWER + UPPER + DIGITS;
  const N = 200000;
  const counts = new Map();
  for (const c of generatePassword(N)) counts.set(c, (counts.get(c) || 0) + 1);
  assert.equal(counts.size, pool.length, "some pool characters never appeared");
  const expected = N / pool.length;
  for (const c of pool) {
    const dev = Math.abs(counts.get(c) - expected) / expected;
    assert.ok(dev < 0.06, `'${c}' deviates ${(dev * 100).toFixed(1)}% from uniform`);
  }
});
