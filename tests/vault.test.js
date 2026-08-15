// Vault file format, KDF migration, and sync merge behaviour. The merge rules
// are what stand between two devices and a lost entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FORMAT,
  createVaultFile,
  openVaultFile,
  sealVault,
  rekeyVault,
  mergeVaults,
  newEntry,
  liveEntries,
  trashEntries,
  restoreEntry,
  purgeEntry,
  purgeAllTrash,
  toggleFavorite,
  MIN_ACCEPTED_ITERATIONS,
  MAX_ACCEPTED_ITERATIONS,
} from "../src/lib/vault.js";
import {
  KDF_ITERATIONS,
  deriveKey,
  encryptJSON,
  randomSalt,
  bytesToB64,
} from "../src/lib/crypto.js";

// ---- file format ---------------------------------------------------------

test("a new vault file is well-formed and starts empty", async () => {
  const { file, key } = await createVaultFile("master");
  assert.equal(file.format, FORMAT);
  assert.equal(file.kdf, "PBKDF2-SHA256");
  assert.equal(file.iterations, KDF_ITERATIONS);
  assert.ok(file.salt && file.iv && file.ciphertext);
  assert.ok(key);

  const { data } = await openVaultFile(file, "master");
  assert.deepEqual(data, { entries: [] });
});

test("the file on disk contains no plaintext secret", async () => {
  const { file, key } = await createVaultFile("master");
  const sealed = await sealVault(key, {
    entries: [newEntry({ name: "Bank", username: "zubair", password: "s3cr3t-do-not-leak" })],
  }, file);
  const serialized = JSON.stringify(sealed);
  for (const secret of ["s3cr3t-do-not-leak", "zubair", "Bank", "master"]) {
    assert.ok(!serialized.includes(secret), `"${secret}" appears in the stored file`);
  }
});

test("the wrong master password is rejected with a clear error", async () => {
  const { file } = await createVaultFile("right");
  await assert.rejects(() => openVaultFile(file, "wrong"), /Wrong master password/);
});

test("an unrecognized format is rejected", async () => {
  await assert.rejects(() => openVaultFile({ format: "something-else" }, "pw"), /format/i);
  await assert.rejects(() => openVaultFile(null, "pw"), /format/i);
});

test("sealing preserves the KDF params the key was derived from", async () => {
  // Rewriting these would produce a file that nothing can open.
  const { file, key } = await createVaultFile("master");
  const sealed = await sealVault(key, { entries: [] }, file);
  assert.equal(sealed.salt, file.salt);
  assert.equal(sealed.iterations, file.iterations);
  const { data } = await openVaultFile(sealed, "master");
  assert.deepEqual(data, { entries: [] });
});

test("a round-trip through seal and open preserves entries", async () => {
  const { file, key } = await createVaultFile("master");
  const entries = [newEntry({ name: "A", password: "p1" }), newEntry({ name: "B", password: "p2" })];
  const sealed = await sealVault(key, { entries }, file);
  const { data } = await openVaultFile(sealed, "master");
  assert.deepEqual(data.entries.map((e) => e.name).sort(), ["A", "B"]);
  assert.deepEqual(data.entries.map((e) => e.password).sort(), ["p1", "p2"]);
});

// ---- KDF cost validation and migration ------------------------------------

test("a file declaring an unsafely low KDF cost is refused", async () => {
  const { file } = await createVaultFile("master");
  for (const iterations of [1, 100, MIN_ACCEPTED_ITERATIONS - 1]) {
    await assert.rejects(
      () => openVaultFile({ ...file, iterations }, "master"),
      /unsafe KDF cost/,
      `iterations=${iterations} should be refused`
    );
  }
});

test("a file declaring an absurdly high KDF cost is refused, not run", async () => {
  // Otherwise a tampered file becomes a way to hang the browser on unlock.
  const { file } = await createVaultFile("master");
  await assert.rejects(
    () => openVaultFile({ ...file, iterations: MAX_ACCEPTED_ITERATIONS + 1 }, "master"),
    /unsafe KDF cost/
  );
});

// A vault as it would have been written by a release with a lower KDF cost.
async function legacyVaultFile(masterPassword, iterations, data) {
  const salt = randomSalt();
  const key = await deriveKey(masterPassword, salt, iterations);
  const { iv, ciphertext } = await encryptJSON(key, data);
  return {
    format: FORMAT,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: bytesToB64(salt),
    iv,
    ciphertext,
  };
}

test("a vault at the current cost is not flagged for upgrade", async () => {
  const { file } = await createVaultFile("master");
  const { needsKdfUpgrade } = await openVaultFile(file, "master");
  assert.equal(needsKdfUpgrade, false);
});

test("a vault below the current cost opens and is flagged for upgrade", async () => {
  const legacy = await legacyVaultFile("master", MIN_ACCEPTED_ITERATIONS, {
    entries: [newEntry({ name: "Old", password: "keep-me" })],
  });
  const { data, needsKdfUpgrade } = await openVaultFile(legacy, "master");
  assert.equal(needsKdfUpgrade, true, "an old low-cost vault should be migrated");
  assert.equal(data.entries[0].password, "keep-me", "and must still open meanwhile");
});

test("migrating a legacy vault raises its cost without losing entries", async () => {
  const legacy = await legacyVaultFile("master", MIN_ACCEPTED_ITERATIONS, {
    entries: [newEntry({ name: "Old", password: "keep-me" })],
  });
  const opened = await openVaultFile(legacy, "master");
  const { file } = await rekeyVault("master", opened.data);

  const after = await openVaultFile(file, "master");
  assert.equal(file.iterations, KDF_ITERATIONS);
  assert.equal(after.needsKdfUpgrade, false);
  assert.equal(after.data.entries[0].password, "keep-me");
  assert.notEqual(file.salt, legacy.salt, "migration should also re-salt");
});

test("rekeyVault re-derives at the current cost and keeps the contents", async () => {
  const data = { entries: [newEntry({ name: "Kept", password: "still-here" })] };
  const { file, key } = await rekeyVault("master", data);
  assert.equal(file.iterations, KDF_ITERATIONS);
  assert.ok(key);

  const reopened = await openVaultFile(file, "master");
  assert.equal(reopened.needsKdfUpgrade, false);
  assert.equal(reopened.data.entries[0].name, "Kept");
  assert.equal(reopened.data.entries[0].password, "still-here");
});

test("rekeying produces a fresh salt", async () => {
  const a = await rekeyVault("master", { entries: [] });
  const b = await rekeyVault("master", { entries: [] });
  assert.notEqual(a.file.salt, b.file.salt);
});

// ---- merge (two-device sync) ---------------------------------------------

const at = (id, updatedAt, extra = {}) => ({ id, updatedAt, name: id, ...extra });

test("merging keeps entries unique to either side", () => {
  const merged = mergeVaults({ entries: [at("local", 1)] }, { entries: [at("remote", 1)] });
  assert.deepEqual(merged.entries.map((e) => e.id).sort(), ["local", "remote"]);
});

test("the newer edit of the same entry wins", () => {
  const local = { entries: [at("x", 200, { password: "new" })] };
  const remote = { entries: [at("x", 100, { password: "old" })] };
  assert.equal(mergeVaults(local, remote).entries[0].password, "new");
  assert.equal(mergeVaults(remote, local).entries[0].password, "new");
});

test("merging is order-independent", () => {
  const a = { entries: [at("1", 5), at("2", 9)] };
  const b = { entries: [at("2", 3), at("3", 7)] };
  const ids = (v) => v.entries.map((e) => e.id).sort();
  assert.deepEqual(ids(mergeVaults(a, b)), ids(mergeVaults(b, a)));
});

test("merging is idempotent", () => {
  const a = { entries: [at("1", 5), at("2", 9)] };
  const once = mergeVaults(a, { entries: [at("3", 1)] });
  assert.deepEqual(mergeVaults(once, once), once);
});

test("a purged entry cannot come back through a merge from another device", () => {
  const local = { entries: [], purged: ["gone"] };
  const remote = { entries: [at("gone", 999)] }; // stale copy still has it
  const merged = mergeVaults(local, remote);
  assert.deepEqual(merged.entries, []);
  assert.deepEqual(merged.purged, ["gone"]);
});

test("purge tombstones from both sides survive the merge", () => {
  const merged = mergeVaults(
    { entries: [], purged: ["a"] },
    { entries: [], purged: ["b"] }
  );
  assert.deepEqual(merged.purged.sort(), ["a", "b"]);
});

test("entries missing updatedAt do not throw or win", () => {
  const merged = mergeVaults({ entries: [at("x", undefined)] }, { entries: [at("x", 50, { name: "remote" })] });
  assert.equal(merged.entries[0].name, "remote");
});

// ---- trash lifecycle -----------------------------------------------------

test("soft delete moves an entry to trash and back", () => {
  const data = { entries: [newEntry({ id: "a", name: "A" })] };
  assert.equal(liveEntries(data).length, 1);

  data.entries[0].deletedAt = Date.now();
  assert.equal(liveEntries(data).length, 0);
  assert.equal(trashEntries(data).length, 1);

  restoreEntry(data, "a");
  assert.equal(liveEntries(data).length, 1);
  assert.equal(trashEntries(data).length, 0);
});

test("purging removes the entry and records a tombstone", () => {
  const data = { entries: [newEntry({ id: "a" }), newEntry({ id: "b" })] };
  purgeEntry(data, "a");
  assert.deepEqual(data.entries.map((e) => e.id), ["b"]);
  assert.deepEqual(data.purged, ["a"]);
});

test("purging the same id twice records one tombstone", () => {
  const data = { entries: [newEntry({ id: "a" })] };
  purgeEntry(data, "a");
  purgeEntry(data, "a");
  assert.deepEqual(data.purged, ["a"]);
});

test("emptying the trash purges only deleted entries", () => {
  const data = {
    entries: [newEntry({ id: "live" }), { ...newEntry({ id: "dead" }), deletedAt: Date.now() }],
  };
  purgeAllTrash(data);
  assert.deepEqual(data.entries.map((e) => e.id), ["live"]);
  assert.deepEqual(data.purged, ["dead"]);
});

test("live entries come back sorted by name", () => {
  const data = { entries: [newEntry({ name: "Zebra" }), newEntry({ name: "apple" }), newEntry({ name: "Mango" })] };
  assert.deepEqual(liveEntries(data).map((e) => e.name), ["apple", "Mango", "Zebra"]);
});

test("toggling a favorite flips it and bumps updatedAt", () => {
  const data = { entries: [newEntry({ id: "a" })] };
  data.entries[0].updatedAt = 0;
  toggleFavorite(data, "a");
  assert.equal(data.entries[0].favorite, true);
  assert.ok(data.entries[0].updatedAt > 0);
  toggleFavorite(data, "a");
  assert.equal(data.entries[0].favorite, false);
});

test("newEntry fills defaults and assigns an id", () => {
  const e = newEntry({ name: "X" });
  assert.ok(e.id);
  assert.equal(e.type, "login");
  assert.deepEqual(e.history, []);
  assert.deepEqual(e.tags, []);
  assert.equal(e.deletedAt, null);
  assert.ok(e.createdAt && e.updatedAt);
});

test("newEntry gives each entry a distinct id", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newEntry().id));
  assert.equal(ids.size, 200);
});
