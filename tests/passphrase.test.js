// Passphrase generation. The point of these tests is to keep the advertised
// strength honest: entropy must be derived from the real wordlist size, not a
// flattering constant.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generatePassphrase,
  passphraseEntropyBits,
  wordsNeededFor,
  WORDLIST_SIZE,
  WEAK_ENTROPY_BITS,
} from "../src/lib/passphrase.js";

test("produces the requested number of words plus a number", () => {
  const parts = generatePassphrase(6, "-", true).split("-");
  assert.equal(parts.length, 7);
  assert.match(parts[6], /^\d{2}$/);
});

test("omits the number when not asked for", () => {
  const parts = generatePassphrase(5, "-", false).split("-");
  assert.equal(parts.length, 5);
  for (const p of parts) assert.match(p, /^[a-z]+$/);
});

test("honors the separator", () => {
  for (const sep of ["-", "_", "."]) {
    const phrase = generatePassphrase(4, sep, false);
    assert.equal(phrase.split(sep).length, 4);
  }
});

test("entropy is computed from the actual wordlist size", () => {
  const expected = 4 * Math.log2(WORDLIST_SIZE) + Math.log2(100);
  assert.ok(Math.abs(passphraseEntropyBits(4, true) - expected) < 1e-9);
});

test("entropy scales with word count and excludes the number when omitted", () => {
  assert.ok(passphraseEntropyBits(8) > passphraseEntropyBits(4));
  assert.ok(passphraseEntropyBits(4, true) > passphraseEntropyBits(4, false));
});

test("the documented weakness of a short passphrase is real", () => {
  // Guards against someone raising the strength claim without growing the list.
  assert.ok(
    passphraseEntropyBits(4, true) < WEAK_ENTROPY_BITS,
    "4 words from this list is not strong; the UI must not imply otherwise"
  );
});

test("wordsNeededFor reaches the target strength", () => {
  for (const target of [40, 60, 80, 128]) {
    const n = wordsNeededFor(target, true);
    assert.ok(passphraseEntropyBits(n, true) >= target, `${n} words fell short of ${target} bits`);
    assert.ok(
      passphraseEntropyBits(n - 1, true) < target,
      `${n} words is more than needed for ${target} bits`
    );
  }
});

test("the default word count clears the weak threshold", () => {
  // generatePassphrase's default must not itself be in the weak band.
  const defaultWords = generatePassphrase().split("-").length - 1;
  assert.ok(
    passphraseEntropyBits(defaultWords, true) >= WEAK_ENTROPY_BITS,
    `default of ${defaultWords} words is only ${passphraseEntropyBits(defaultWords, true).toFixed(1)} bits`
  );
});

test("output varies between calls", () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(generatePassphrase(6));
  assert.ok(seen.size > 295, `only ${seen.size}/300 distinct`);
});

test("the wordlist has no duplicates", () => {
  // A duplicate would silently reduce entropy below the advertised figure.
  const words = new Set();
  for (let i = 0; i < 20000; i++) {
    for (const w of generatePassphrase(1, "-", false).split("-")) words.add(w);
  }
  assert.equal(words.size, WORDLIST_SIZE, "generated words do not cover a distinct list");
});

test("words are drawn near-uniformly (no modulo bias)", () => {
  const counts = new Map();
  const draws = WORDLIST_SIZE * 400;
  for (const w of generatePassphrase(draws, "-", false).split("-")) {
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  assert.equal(counts.size, WORDLIST_SIZE, "some words never appeared");
  const expected = draws / WORDLIST_SIZE;
  for (const [w, n] of counts) {
    const dev = Math.abs(n - expected) / expected;
    assert.ok(dev < 0.2, `'${w}' deviates ${(dev * 100).toFixed(1)}% from uniform`);
  }
});
