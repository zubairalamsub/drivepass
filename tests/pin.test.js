// Turning on the PIN is the one feature that writes a copy of the master key to
// disk. It is wrapped by a key derived from six digits — a million-guess
// keyspace — so the file itself is not the defence; the five-attempt lockout in
// unlockWithPin is, and after it trips the wrapped key is supposed to be gone
// for good. Nothing asserted that anywhere: service-worker.test.js only checks
// that ONE bad attempt bumps the counter, which a lockout that never fires would
// also satisfy. A regression here (a counter that resets on failure, a check
// moved after the unwrap, a removePin() that no longer deletes) leaves the
// popup as an unmetered oracle against a 6-digit secret, and every existing
// test still passes.
//
// src/lib/crypto.js's PIN functions had no direct coverage at all before this
// file, so the storage shape and the "never store the key in the clear"
// property are pinned here too.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installChrome, uninstall } from "./helpers/chrome-mock.js";
import {
  setupPin,
  unlockWithPin,
  removePin,
  deriveKey,
  encryptJSON,
  randomSalt,
  bytesToB64,
  b64ToBytes,
  exportRawKey,
  MIN_PIN_LENGTH,
  PIN_KDF_ITERATIONS,
} from "../src/lib/crypto.js";

const PIN = "135790";
const MASTER_KEY_B64 = bytesToB64(new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff));

// The real wrap costs a 600k-iteration PBKDF2 on every attempt, and the lockout
// test needs six of them. unlockWithPin honours the cost recorded in the stored
// config, so the walk-the-counter tests use a cheap config of the same shape.
// Two tests below still pay the real cost, and `the cheap fixture matches what
// setupPin writes` keeps this helper from drifting into testing a fiction.
const CHEAP_ITERATIONS = 1000;

async function seedPinConfig(pin, { iterations = CHEAP_ITERATIONS, failedAttempts = 0 } = {}) {
  const pinSalt = randomSalt();
  const pinKey = await deriveKey(pin, pinSalt, iterations);
  const wrapped = await encryptJSON(pinKey, { rawMasterKey: MASTER_KEY_B64 });
  await chrome.storage.local.set({
    pin_config: {
      salt: bytesToB64(pinSalt),
      iterations,
      wrappedIv: wrapped.iv,
      wrappedCt: wrapped.ciphertext,
      failedAttempts,
    },
  });
}

let env;
beforeEach(() => {
  env = installChrome();
});
afterEach(() => uninstall());

// ---- what setup writes -----------------------------------------------------

test("a PIN below the minimum length is refused before anything reaches disk", async () => {
  for (const pin of ["", "12345", null, undefined]) {
    await assert.rejects(
      () => setupPin(pin, MASTER_KEY_B64),
      new RegExp(`at least ${MIN_PIN_LENGTH}`),
      `setupPin(${JSON.stringify(pin)}) should be refused`
    );
  }
  assert.equal("pin_config" in env.local, false, "a rejected setup must not leave a partial config");
});

test("the stored PIN config holds the master key wrapped, never in the clear", async () => {
  await setupPin(PIN, MASTER_KEY_B64);
  const stored = JSON.stringify(env.local.pin_config);

  assert.ok(!stored.includes(MASTER_KEY_B64), "the raw master key is sitting in local storage");
  assert.ok(!stored.includes(PIN), "the PIN itself is recoverable from local storage");
  assert.equal(
    env.local.pin_config.iterations,
    PIN_KDF_ITERATIONS,
    "the wrap must record the high cost it was derived at, or unlock re-derives with the wrong one"
  );
  assert.equal(env.local.pin_config.failedAttempts, 0);
});

test("the cheap fixture matches what setupPin writes, so the lockout tests are not testing a fiction", async () => {
  await setupPin(PIN, MASTER_KEY_B64);
  const real = env.local.pin_config;
  await seedPinConfig(PIN);
  assert.deepEqual(Object.keys(env.local.pin_config).sort(), Object.keys(real).sort());
});

test("the right PIN unwraps exactly the key that was wrapped", async () => {
  // End to end at the shipped cost: setupPin and unlockWithPin have to agree on
  // salt encoding, iteration count and the payload's shape.
  await setupPin(PIN, MASTER_KEY_B64);
  assert.equal(await unlockWithPin(PIN), MASTER_KEY_B64);
});

test("a re-run of setup re-salts, so the same PIN does not produce the same wrap twice", async () => {
  await seedPinConfig(PIN);
  const first = { ...env.local.pin_config };
  await seedPinConfig(PIN);
  assert.notEqual(env.local.pin_config.salt, first.salt);
  assert.notEqual(env.local.pin_config.wrappedCt, first.wrappedCt);
});

// ---- the lockout -----------------------------------------------------------

test("a wrong PIN is refused, counted, and yields nothing", async () => {
  await seedPinConfig(PIN);
  await assert.rejects(() => unlockWithPin("999999"), /Incorrect PIN/);
  assert.equal(env.local.pin_config.failedAttempts, 1);
  // The wrap survives one mistake — the user gets to try again.
  assert.equal(await unlockWithPin(PIN), MASTER_KEY_B64);
});

test("five wrong PINs are counted down, and the sixth attempt destroys the wrapped key for good", async () => {
  // The whole security argument for storing the master key on disk. Without the
  // final removePin() the popup is an unlimited oracle against six digits.
  await seedPinConfig(PIN);

  for (let attempt = 1; attempt <= 5; attempt++) {
    await assert.rejects(
      () => unlockWithPin("999999"),
      new RegExp(`Incorrect PIN\\. ${5 - attempt} attempts remaining`),
      `attempt ${attempt} should report ${5 - attempt} left`
    );
    assert.equal(env.local.pin_config.failedAttempts, attempt);
  }

  await assert.rejects(() => unlockWithPin("999999"), /Too many failed PIN attempts/);
  assert.equal("pin_config" in env.local, false, "the wrapped master key must be deleted, not just flagged");

  // And the lockout is not a cooldown: the correct PIN is dead too, which is
  // what forces the user back to the master password.
  await assert.rejects(() => unlockWithPin(PIN), /not configured/);
});

test("a config already at the attempt limit is wiped without another guess being scored", async () => {
  // A worker restart between attempts must not hand back a fresh five.
  await seedPinConfig(PIN, { failedAttempts: 5 });
  await assert.rejects(() => unlockWithPin(PIN), /Too many failed PIN attempts/);
  assert.equal("pin_config" in env.local, false);
});

test("a successful unlock clears the attempts already spent", async () => {
  await seedPinConfig(PIN, { failedAttempts: 3 });
  assert.equal(await unlockWithPin(PIN), MASTER_KEY_B64);
  assert.equal(env.local.pin_config.failedAttempts, 0, "a correct PIN must reset the budget");
});

test("a tampered wrap is treated as a wrong PIN rather than crashing the unlock", async () => {
  // GCM rejects the modified ciphertext; the catch arm has to be what handles it.
  await seedPinConfig(PIN);
  const ct = b64ToBytes(env.local.pin_config.wrappedCt);
  ct[0] ^= 0x01;
  await chrome.storage.local.set({
    pin_config: { ...env.local.pin_config, wrappedCt: bytesToB64(ct) },
  });

  await assert.rejects(() => unlockWithPin(PIN), /Incorrect PIN/);
  assert.equal(env.local.pin_config.failedAttempts, 1);
});

// ---- teardown --------------------------------------------------------------

test("removePin deletes the on-disk copy of the master key", async () => {
  await seedPinConfig(PIN);
  await removePin();
  assert.equal("pin_config" in env.local, false);
  await assert.rejects(() => unlockWithPin(PIN), /not configured/);
});

test("the unwrapped key is the same string the vault session stores, not a re-encoding", async () => {
  // handleUnlockPin feeds this straight into importRawKey; a changed encoding
  // would fail there instead, long after the PIN looked fine.
  const key = await deriveKey("master", randomSalt(), CHEAP_ITERATIONS);
  const rawB64 = await exportRawKey(key);
  const pinSalt = randomSalt();
  const pinKey = await deriveKey(PIN, pinSalt, CHEAP_ITERATIONS);
  const wrapped = await encryptJSON(pinKey, { rawMasterKey: rawB64 });
  await chrome.storage.local.set({
    pin_config: {
      salt: bytesToB64(pinSalt),
      iterations: CHEAP_ITERATIONS,
      wrappedIv: wrapped.iv,
      wrappedCt: wrapped.ciphertext,
      failedAttempts: 0,
    },
  });

  assert.equal(await unlockWithPin(PIN), rawB64);
});
