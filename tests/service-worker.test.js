// The background worker is where every trust decision in DrivePass actually
// happens: it holds the only copy of the decryption key, it decides which page
// may see which secret, and it is the one component a compromised content
// script can talk to directly. Three things make it easy to break silently:
//
//   1. Its state lives in module variables that a service-worker restart wipes.
//      Everything therefore has to be rebuildable from chrome.storage, and a
//      hydrate() that fails open would leave the vault readable with a key that
//      no longer matches the file.
//   2. Its handlers are reached through one untyped message switch. A route can
//      stop answering — or start answering the wrong caller — without any
//      caller changing.
//   3. The secret-bearing routes distinguish "who the browser says is asking"
//      from "who the message claims is asking". Collapsing those two is a
//      credential leak, and nothing about the code's shape makes it obvious.
//
// So these tests drive the real chrome.runtime.onMessage listener rather than
// calling handlers directly: the routing table, the promise-to-sendResponse
// plumbing, and the sender the handler sees are all part of what is under test.

import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { loadServiceWorker, reset, uninstall, flush } from "./helpers/chrome-mock.js";
import { createVaultFile, openVaultFile, sealVault, newEntry } from "../src/lib/vault.js";
import { exportRawKey, decryptJSON } from "../src/lib/crypto.js";

const AUTO_LOCK_ALARM = "drivepass-autolock";
const CLIPBOARD_ALARM = "drivepass-clear-clipboard";
const MASTER = "correct horse battery staple";

// One vault key for the whole suite. Deriving a key costs a 210k-iteration
// PBKDF2, and the handlers under test do not care how the key was derived —
// only that hydrate() can rebuild the session from storage. Tests that are
// specifically about a password (UNLOCK, CHANGE_MASTER) pay the real cost.
const BASE = await createVaultFile(MASTER);
const BASE_RAW_KEY = await exportRawKey(BASE.key);
const OTHER = await createVaultFile("a different master password");
const OTHER_RAW_KEY = await exportRawKey(OTHER.key);

// A worker whose vault is already open, in exactly the shape a restart leaves
// behind: sealed file in local storage, raw key in session storage, nothing in
// module state until the first message makes hydrate() put them back together.
async function unlockedWorker(entries = [], extra = {}) {
  const cache_file = await sealVault(BASE.key, { entries }, BASE.file);
  return loadServiceWorker({
    local: { cache_file, ...(extra.local || {}) },
    session: { sess_rawKey: BASE_RAW_KEY, ...(extra.session || {}) },
  });
}

// A worker with a vault on disk but no session key.
async function lockedWorker(entries = []) {
  const cache_file = await sealVault(BASE.key, { entries }, BASE.file);
  return loadServiceWorker({ local: { cache_file } });
}

const login = (over = {}) =>
  newEntry({ name: "Example", url: "example.com", username: "alice", password: "pw", ...over });

// What actually reached local storage, decrypted — proves persistVault ran
// rather than the handler only mutating the in-memory copy.
const persisted = (env, key = BASE.key) =>
  decryptJSON(key, env.local.cache_file.iv, env.local.cache_file.ciphertext);

// Handlers that start work without awaiting it (touchActivity, the alarm
// listener) need a macrotask to land before the next test replaces the mock.
afterEach(async () => {
  await flush();
  reset();
});
after(() => uninstall());

// ---- message routing -------------------------------------------------------

test("an unknown message type is answered with an error rather than dropped", async () => {
  // A dropped reply is worse than a rejection: the popup awaits sendMessage and
  // would sit on a spinner forever.
  const env = await loadServiceWorker();
  assert.deepEqual(await env.send({ type: "NO_SUCH_ROUTE" }), {
    ok: false,
    error: "Unknown message type: NO_SUCH_ROUTE",
  });
});

test("a message with no type at all is answered, not treated as a crash", async () => {
  const env = await loadServiceWorker();
  const res = await env.send({});
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown message type/);
});

test("a handler that rejects reports the reason instead of leaving the caller hanging", async () => {
  // The listener returns true and answers later; if the catch arm were missing
  // the port would close with no response and the harness would time out here.
  const env = await lockedWorker();
  assert.deepEqual(await env.send({ type: "GET_ENTRIES" }), { ok: false, error: "Vault is locked." });
});

// ---- lifecycle: create, status, lock, hydrate ------------------------------

test("CREATE_VAULT leaves the vault unlocked and empty", async () => {
  const env = await loadServiceWorker();
  assert.deepEqual(await env.send({ type: "CREATE_VAULT", password: MASTER }), { ok: true });

  const status = await env.send({ type: "STATUS" });
  assert.equal(status.locked, false);
  assert.equal(status.hasVault, true);
  assert.equal(status.count, 0);
  assert.equal(status.hasPin, false);
  assert.equal(status.connected, false);
  assert.equal(status.autoLockMinutes, 15);
});

test("CREATE_VAULT writes the sealed file to local storage and the key to session storage", async () => {
  const env = await loadServiceWorker();
  await env.send({ type: "CREATE_VAULT", password: MASTER });

  assert.equal(env.local.cache_file.format, "drivepass-v1");
  assert.ok(env.session.sess_rawKey, "the key must be recoverable after a worker restart");
  assert.equal("cache_file" in env.session, false, "the vault file belongs in local storage");
  const { data } = await openVaultFile(env.local.cache_file, MASTER);
  assert.deepEqual(data, { entries: [] });
});

test("STATUS counts only the live entries", async () => {
  const env = await unlockedWorker([
    login({ name: "Live" }),
    login({ name: "Trashed", deletedAt: Date.now() }),
  ]);
  assert.equal((await env.send({ type: "STATUS" })).count, 1);
});

test("STATUS on a worker that has never held a vault reports no vault and locked", async () => {
  const env = await loadServiceWorker();
  const status = await env.send({ type: "STATUS" });
  assert.equal(status.hasVault, false);
  assert.equal(status.locked, true);
  assert.equal(status.count, 0);
});

test("LOCK drops the session key so the vault cannot be reopened without a password", async () => {
  const env = await unlockedWorker([login()]);
  assert.equal((await env.send({ type: "STATUS" })).locked, false);

  assert.deepEqual(await env.send({ type: "LOCK" }), { ok: true });
  assert.equal(env.session.sess_rawKey, undefined, "a key left in session storage would re-hydrate");

  const status = await env.send({ type: "STATUS" });
  assert.equal(status.locked, true);
  assert.equal(status.count, 0);
  assert.equal(status.hasVault, true, "locking must not look like losing the vault");
  assert.equal((await env.send({ type: "GET_ENTRIES" })).ok, false);
});

test("LOCK also cancels the pending auto-lock alarm", async () => {
  const env = await unlockedWorker();
  await env.send({ type: "SET_AUTOLOCK", minutes: 10 });
  assert.ok(env.mock.alarms.has(AUTO_LOCK_ALARM));
  await env.send({ type: "LOCK" });
  assert.equal(env.mock.alarms.has(AUTO_LOCK_ALARM), false);
});

test("a restarted worker rebuilds the unlocked session from storage", async () => {
  // chrome.storage survives a service-worker restart; the module's variables do
  // not. If hydrate() stopped working the user would be asked for the master
  // password every few minutes with no visible reason.
  const first = await loadServiceWorker();
  await first.send({ type: "CREATE_VAULT", password: MASTER });
  await first.send({ type: "SAVE_ENTRY", entry: { name: "Kept", url: "kept.com", password: "p" } });
  const local = { ...first.local };
  const session = { ...first.session };
  assert.ok(session.sess_rawKey);

  // Fresh module state (no sessionKey, no vaultData), same storage behind it.
  const restarted = await loadServiceWorker({ local, session });
  const status = await restarted.send({ type: "STATUS" });
  assert.equal(status.locked, false, "hydrate() should reopen the vault with no master password");
  assert.equal(status.count, 1);
  assert.equal((await restarted.send({ type: "GET_ENTRIES" })).entries[0].name, "Kept");
});

test("hydrate fails closed when the cached session key does not open the cached file", async () => {
  // Happens when the vault was re-keyed elsewhere and re-downloaded while a
  // stale key was still cached. Anything other than "locked" here would be a
  // handler operating on a vault it cannot actually re-seal.
  const env = await loadServiceWorker({
    local: { cache_file: await sealVault(BASE.key, { entries: [login()] }, BASE.file) },
    session: { sess_rawKey: OTHER_RAW_KEY },
  });

  const status = await env.send({ type: "STATUS" });
  assert.equal(status.locked, true);
  assert.equal(status.hasVault, true);
  assert.equal(status.count, 0);
  assert.equal(env.session.sess_rawKey, undefined, "the unusable key should be dropped, not retried forever");
  assert.equal((await env.send({ type: "GET_ENTRIES" })).ok, false);
});

test("a session key with no cached vault file leaves the worker locked", async () => {
  const env = await loadServiceWorker({ session: { sess_rawKey: BASE_RAW_KEY } });
  const status = await env.send({ type: "STATUS" });
  assert.equal(status.locked, true);
  assert.equal(status.hasVault, false);
});

// ---- unlock ----------------------------------------------------------------

test("UNLOCK with the right master password opens the vault", async () => {
  const env = await lockedWorker([login({ name: "Bank" })]);
  assert.deepEqual(await env.send({ type: "UNLOCK", password: MASTER }), { ok: true });

  const status = await env.send({ type: "STATUS" });
  assert.equal(status.locked, false);
  assert.equal(status.count, 1);
  assert.ok(env.session.sess_rawKey, "unlock must cache the key for the next worker restart");
});

test("UNLOCK with the wrong master password is refused and changes nothing", async () => {
  const env = await lockedWorker([login()]);
  const res = await env.send({ type: "UNLOCK", password: "not the master password" });
  assert.equal(res.ok, false);
  assert.match(res.error, /Wrong master password/);
  assert.equal(env.session.sess_rawKey, undefined, "a failed unlock must not cache a key");
  assert.equal((await env.send({ type: "STATUS" })).locked, true);
});

test("UNLOCK before any vault exists says so rather than failing obscurely", async () => {
  const env = await loadServiceWorker();
  const res = await env.send({ type: "UNLOCK", password: MASTER });
  assert.equal(res.ok, false);
  assert.match(res.error, /No vault found/);
});

test("UNLOCK starts the auto-lock countdown", async () => {
  const env = await lockedWorker();
  await env.send({ type: "UNLOCK", password: MASTER });
  assert.deepEqual(env.mock.alarms.get(AUTO_LOCK_ALARM), { delayInMinutes: 15 });
});

// ---- PIN quick unlock ------------------------------------------------------

test("SETUP_PIN refuses to run while the vault is locked", async () => {
  // The PIN wraps the master key, so there has to be one in memory to wrap.
  const env = await lockedWorker([login()]);
  assert.deepEqual(await env.send({ type: "SETUP_PIN", pin: "123456" }), {
    ok: false,
    error: "Vault is locked.",
  });
  assert.equal(env.local.pin_config, undefined);
});

test("SETUP_PIN refuses a PIN shorter than six digits", async () => {
  const env = await unlockedWorker();
  const res = await env.send({ type: "SETUP_PIN", pin: "12345" });
  assert.equal(res.ok, false);
  assert.match(res.error, /at least 6/);
  assert.equal(env.local.pin_config, undefined);
});

test("a PIN configured while unlocked reopens the vault after a lock", async () => {
  const env = await unlockedWorker([login()]);
  assert.deepEqual(await env.send({ type: "SETUP_PIN", pin: "135790" }), { ok: true });
  assert.equal((await env.send({ type: "STATUS" })).hasPin, true);

  await env.send({ type: "LOCK" });
  assert.equal((await env.send({ type: "STATUS" })).locked, true);

  assert.deepEqual(await env.send({ type: "UNLOCK_PIN", pin: "135790" }), { ok: true });
  const status = await env.send({ type: "STATUS" });
  assert.equal(status.locked, false);
  assert.equal(status.count, 1);
  assert.ok(env.session.sess_rawKey);
});

test("UNLOCK_PIN with the wrong PIN is refused and the attempt is counted", async () => {
  // The attempt counter is what eventually disables the PIN; a wrong PIN that
  // did not increment it would make the lockout unreachable.
  const env = await unlockedWorker([login()]);
  await env.send({ type: "SETUP_PIN", pin: "135790" });
  await env.send({ type: "LOCK" });

  const res = await env.send({ type: "UNLOCK_PIN", pin: "000000" });
  assert.equal(res.ok, false);
  assert.match(res.error, /Incorrect PIN/);
  assert.equal(env.local.pin_config.failedAttempts, 1);
  assert.equal((await env.send({ type: "STATUS" })).locked, true);
});

test("UNLOCK_PIN when no PIN was ever configured is refused", async () => {
  const env = await lockedWorker([login()]);
  const res = await env.send({ type: "UNLOCK_PIN", pin: "135790" });
  assert.equal(res.ok, false);
  assert.match(res.error, /not configured/);
});

test("REMOVE_PIN clears the wrapped key so STATUS stops offering PIN unlock", async () => {
  const env = await unlockedWorker([login()]);
  await env.send({ type: "SETUP_PIN", pin: "135790" });
  assert.deepEqual(await env.send({ type: "REMOVE_PIN" }), { ok: true });
  assert.equal(env.local.pin_config, undefined);
  assert.equal((await env.send({ type: "STATUS" })).hasPin, false);
});

// ---- changing the master password ------------------------------------------

test("CHANGE_MASTER re-keys the vault so only the new password opens it", async () => {
  const env = await loadServiceWorker();
  await env.send({ type: "CREATE_VAULT", password: "old-master" });
  await env.send({
    type: "SAVE_ENTRY",
    entry: { name: "Bank", url: "bank.com", username: "alice", password: "s3cret" },
  });

  const res = await env.send({ type: "CHANGE_MASTER", current: "old-master", next: "new-master" });
  assert.equal(res.ok, true);

  const file = env.local.cache_file;
  await assert.rejects(() => openVaultFile(file, "old-master"), /Wrong master password/);
  const { data } = await openVaultFile(file, "new-master");
  assert.deepEqual(data.entries.map((e) => e.name), ["Bank"]);
  assert.equal(data.entries[0].password, "s3cret", "re-keying must not lose the contents");
});

test("CHANGE_MASTER leaves the vault open under the new key", async () => {
  const env = await loadServiceWorker();
  await env.send({ type: "CREATE_VAULT", password: "old-master" });
  await env.send({ type: "SAVE_ENTRY", entry: { name: "Kept", url: "kept.com", password: "p" } });
  await env.send({ type: "CHANGE_MASTER", current: "old-master", next: "new-master" });

  const status = await env.send({ type: "STATUS" });
  assert.equal(status.locked, false);
  assert.equal(status.count, 1);
  // The cached key must be the new one, or the next restart hydrates into a
  // vault it cannot decrypt.
  const restarted = await loadServiceWorker({ local: { ...env.local }, session: { ...env.session } });
  assert.equal((await restarted.send({ type: "STATUS" })).locked, false);
});

test("CHANGE_MASTER with the wrong current password changes nothing", async () => {
  const env = await loadServiceWorker();
  await env.send({ type: "CREATE_VAULT", password: "old-master" });

  const res = await env.send({ type: "CHANGE_MASTER", current: "guess", next: "new-master" });
  assert.equal(res.ok, false);
  assert.match(res.error, /Wrong master password/);
  await openVaultFile(env.local.cache_file, "old-master"); // still the old key; throws if not
});

test("CHANGE_MASTER clears a configured PIN and says that it did", async () => {
  // The PIN wraps the OLD master key. Left in place, a correct PIN would fail
  // at unlock with a raw WebCrypto error and look like data loss.
  const env = await loadServiceWorker();
  await env.send({ type: "CREATE_VAULT", password: "old-master" });
  await env.send({ type: "SETUP_PIN", pin: "135790" });

  const res = await env.send({ type: "CHANGE_MASTER", current: "old-master", next: "new-master" });
  assert.equal(res.pinCleared, true);
  assert.equal(env.local.pin_config, undefined);
  assert.equal((await env.send({ type: "STATUS" })).hasPin, false);
});

test("CHANGE_MASTER reports pinCleared false when there was no PIN to clear", async () => {
  const env = await loadServiceWorker();
  await env.send({ type: "CREATE_VAULT", password: "old-master" });
  const res = await env.send({ type: "CHANGE_MASTER", current: "old-master", next: "new-master" });
  assert.equal(res.pinCleared, false);
});

test("CHANGE_MASTER refuses while the vault is locked", async () => {
  const env = await lockedWorker([login()]);
  const res = await env.send({ type: "CHANGE_MASTER", current: MASTER, next: "new" });
  assert.equal(res.ok, false);
  assert.match(res.error, /Unlock the vault first/);
});

// ---- entry CRUD ------------------------------------------------------------

test("SAVE_ENTRY without an id creates a new entry and persists it", async () => {
  const env = await unlockedWorker();
  const res = await env.send({
    type: "SAVE_ENTRY",
    entry: { name: "New", url: "new.com", username: "u", password: "p" },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.sync, { synced: false }, "no Drive connected, so nothing to sync");

  const { entries } = await env.send({ type: "GET_ENTRIES" });
  assert.equal(entries.length, 1);
  assert.ok(entries[0].id, "a created entry needs an id for later edits to target");
  assert.equal((await persisted(env)).entries.length, 1, "the change must reach storage, not just memory");
});

test("SAVE_ENTRY with a known id updates in place instead of adding a second copy", async () => {
  const entry = login({ name: "Before" });
  const env = await unlockedWorker([entry]);
  await env.send({ type: "SAVE_ENTRY", entry: { id: entry.id, name: "After", username: "bob" } });

  const { entries } = await env.send({ type: "GET_ENTRIES" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, entry.id);
  assert.equal(entries[0].name, "After");
  assert.equal(entries[0].username, "bob");
  assert.equal(entries[0].url, "example.com", "untouched fields should survive a partial save");
});

test("SAVE_ENTRY with an id that is not in the vault appends rather than dropping the save", async () => {
  const env = await unlockedWorker([login()]);
  await env.send({ type: "SAVE_ENTRY", entry: { id: "not-in-this-vault", name: "Z", url: "z.com" } });
  assert.equal((await env.send({ type: "GET_ENTRIES" })).entries.length, 2);
});

test("saving an entry that is in the trash pulls it back out (current behaviour)", async () => {
  // The update path hardcodes deletedAt: null, so an edit is also an undelete.
  // Reachable from the popup's edit form if it is opened on a trashed entry.
  const entry = login({ deletedAt: Date.now() });
  const env = await unlockedWorker([entry]);
  await env.send({ type: "SAVE_ENTRY", entry: { id: entry.id, name: "Edited" } });

  assert.deepEqual((await env.send({ type: "GET_TRASH" })).entries, []);
  assert.equal((await env.send({ type: "GET_ENTRIES" })).entries[0].name, "Edited");
});

test("changing a password files the previous one in history", async () => {
  const entry = login({ password: "old-password" });
  const env = await unlockedWorker([entry]);
  await env.send({ type: "SAVE_ENTRY", entry: { id: entry.id, password: "new-password" } });

  const [saved] = (await env.send({ type: "GET_ENTRIES" })).entries;
  assert.equal(saved.password, "new-password");
  assert.equal(saved.history.length, 1);
  assert.equal(saved.history[0].password, "old-password");
});

test("saving an entry without changing its password adds no history record", async () => {
  const entry = login({ password: "same" });
  const env = await unlockedWorker([entry]);
  await env.send({ type: "SAVE_ENTRY", entry: { id: entry.id, password: "same", name: "Renamed" } });

  const [saved] = (await env.send({ type: "GET_ENTRIES" })).entries;
  assert.equal(saved.name, "Renamed");
  assert.deepEqual(saved.history, []);
});

test("password history keeps the ten most recent passwords and drops the oldest", async () => {
  // Unbounded history would grow the encrypted file without limit and keep
  // long-dead passwords around forever.
  const entry = login({ password: "pw-0" });
  const env = await unlockedWorker([entry]);
  for (let i = 1; i <= 12; i++) {
    await env.send({ type: "SAVE_ENTRY", entry: { id: entry.id, password: `pw-${i}` } });
  }

  const [saved] = (await env.send({ type: "GET_ENTRIES" })).entries;
  assert.equal(saved.password, "pw-12");
  assert.equal(saved.history.length, 10);
  assert.deepEqual(
    saved.history.map((h) => h.password),
    ["pw-11", "pw-10", "pw-9", "pw-8", "pw-7", "pw-6", "pw-5", "pw-4", "pw-3", "pw-2"]
  );
});

test("DELETE_ENTRY moves the entry to the trash instead of destroying it", async () => {
  const entry = login();
  const env = await unlockedWorker([entry]);
  assert.equal((await env.send({ type: "DELETE_ENTRY", id: entry.id })).ok, true);

  assert.deepEqual((await env.send({ type: "GET_ENTRIES" })).entries, []);
  const trash = (await env.send({ type: "GET_TRASH" })).entries;
  assert.equal(trash.length, 1);
  assert.equal(trash[0].id, entry.id);
  assert.ok(trash[0].deletedAt, "the tombstone timestamp is what makes the delete sync");

  const stored = await persisted(env);
  assert.equal(stored.entries.length, 1, "a soft delete must keep the row so other devices see it");
});

test("RESTORE_ENTRY brings a trashed entry back to the live list", async () => {
  const entry = login({ deletedAt: Date.now() });
  const env = await unlockedWorker([entry]);
  assert.equal((await env.send({ type: "GET_ENTRIES" })).entries.length, 0);

  assert.equal((await env.send({ type: "RESTORE_ENTRY", id: entry.id })).ok, true);
  assert.equal((await env.send({ type: "GET_ENTRIES" })).entries.length, 1);
  assert.deepEqual((await env.send({ type: "GET_TRASH" })).entries, []);
});

test("PURGE_ENTRY removes the entry and records a tombstone in the stored file", async () => {
  // Without the tombstone the next sync from a stale device resurrects it.
  const gone = login({ name: "Gone", deletedAt: Date.now() });
  const kept = login({ name: "Kept" });
  const env = await unlockedWorker([gone, kept]);

  assert.equal((await env.send({ type: "PURGE_ENTRY", id: gone.id })).ok, true);
  const stored = await persisted(env);
  assert.deepEqual(stored.entries.map((e) => e.id), [kept.id]);
  assert.deepEqual(stored.purged, [gone.id]);
});

test("PURGE_ALL_TRASH empties the trash and leaves live entries alone", async () => {
  const dead1 = login({ name: "D1", deletedAt: Date.now() });
  const dead2 = login({ name: "D2", deletedAt: Date.now() });
  const alive = login({ name: "A" });
  const env = await unlockedWorker([dead1, dead2, alive]);

  assert.equal((await env.send({ type: "PURGE_ALL_TRASH" })).ok, true);
  assert.deepEqual((await env.send({ type: "GET_TRASH" })).entries, []);
  assert.deepEqual((await env.send({ type: "GET_ENTRIES" })).entries.map((e) => e.id), [alive.id]);
  assert.deepEqual((await persisted(env)).purged.sort(), [dead1.id, dead2.id].sort());
});

test("TOGGLE_FAVORITE flips the flag and persists both ways", async () => {
  const entry = login();
  const env = await unlockedWorker([entry]);

  await env.send({ type: "TOGGLE_FAVORITE", id: entry.id });
  assert.equal((await persisted(env)).entries[0].favorite, true);

  await env.send({ type: "TOGGLE_FAVORITE", id: entry.id });
  assert.equal((await persisted(env)).entries[0].favorite, false);
});

test("every entry route refuses to run while the vault is locked", async () => {
  const env = await lockedWorker([login()]);
  const before = env.local.cache_file.ciphertext;
  const routes = [
    "GET_ENTRIES", "GET_TRASH", "SAVE_ENTRY", "DELETE_ENTRY", "RESTORE_ENTRY",
    "PURGE_ENTRY", "PURGE_ALL_TRASH", "TOGGLE_FAVORITE", "IMPORT_ENTRIES",
  ];
  for (const type of routes) {
    const res = await env.send({ type, id: "x", entry: { name: "x" }, entries: [{ name: "x" }] });
    assert.deepEqual(res, { ok: false, error: "Vault is locked." }, `${type} should refuse`);
  }
  assert.equal(env.local.cache_file.ciphertext, before, "a refused write must not re-seal the file");
});

// ---- import ----------------------------------------------------------------

test("IMPORT_ENTRIES skips a row that duplicates a stored url and username", async () => {
  const env = await unlockedWorker([login({ url: "example.com", username: "alice" })]);
  const res = await env.send({
    type: "IMPORT_ENTRIES",
    entries: [
      { url: "example.com", username: "alice", password: "from-the-csv" },
      { url: "other.com", username: "bob", password: "p" },
    ],
  });

  assert.equal(res.count, 1);
  assert.equal(res.skipped, 1);
  const { entries } = await env.send({ type: "GET_ENTRIES" });
  assert.equal(entries.length, 2);
  const original = entries.find((e) => e.url === "example.com");
  assert.equal(original.password, "pw", "skipping means leaving the stored password alone");
});

test("duplicate detection ignores the case of the url", async () => {
  const env = await unlockedWorker([login({ url: "example.com", username: "alice" })]);
  const res = await env.send({
    type: "IMPORT_ENTRIES",
    entries: [{ url: "EXAMPLE.COM", username: "alice", password: "p" }],
  });
  assert.equal(res.count, 0);
  assert.equal(res.skipped, 1);
});

test("an id supplied by an import file is never trusted", async () => {
  // Two entries with one id would make delete, save and merge all ambiguous —
  // and an import file is attacker-supplied data as far as the vault knows.
  const existing = login({ id: "shared-id", url: "a.com", username: "alice" });
  const env = await unlockedWorker([existing]);
  await env.send({
    type: "IMPORT_ENTRIES",
    entries: [{ id: "shared-id", url: "b.com", username: "bob", password: "p" }],
  });

  const { entries } = await env.send({ type: "GET_ENTRIES" });
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((e) => e.id)).size, 2, "the imported id must have been replaced");
  const imported = entries.find((e) => e.url === "b.com");
  assert.notEqual(imported.id, "shared-id");
});

test("re-importing the same file a second time adds nothing", async () => {
  const env = await unlockedWorker();
  const rows = [{ url: "a.com", username: "alice", password: "p" }];
  assert.equal((await env.send({ type: "IMPORT_ENTRIES", entries: rows })).count, 1);

  const again = await env.send({ type: "IMPORT_ENTRIES", entries: rows });
  assert.equal(again.count, 0);
  assert.equal(again.skipped, 1);
  assert.equal((await env.send({ type: "GET_ENTRIES" })).entries.length, 1);
});

test("two identical rows inside ONE import file are both kept (current behaviour)", async () => {
  // The duplicate check runs against a snapshot taken before the loop, so rows
  // are only ever compared with what was already in the vault, never with each
  // other. Documented as it stands; reported as a defect.
  const env = await unlockedWorker();
  const row = { url: "dup.com", username: "alice", password: "p" };
  const res = await env.send({ type: "IMPORT_ENTRIES", entries: [row, { ...row }] });
  assert.equal(res.count, 2);
  assert.equal(res.skipped, 0);
});

test("IMPORT_ENTRIES with nothing to import is refused", async () => {
  const env = await unlockedWorker();
  for (const entries of [[], null, undefined]) {
    const res = await env.send({ type: "IMPORT_ENTRIES", entries });
    assert.equal(res.ok, false);
    assert.match(res.error, /No entries to import/);
  }
});

// ---- what a page is allowed to see -----------------------------------------

test("GET_MATCHES hands the page a list with no password and no TOTP secret in it", async () => {
  // The content script runs on every site the user visits. Shipping it
  // plaintext secrets on page load puts them in reach of any bug in it, for no
  // benefit — it only needs enough to draw the dropdown.
  const env = await unlockedWorker([
    login({ name: "With TOTP", password: "never-leaves-the-worker", totp: "JBSWY3DPEHPK3PXP" }),
    login({ name: "Without TOTP", username: "bob", password: "also-secret" }),
  ]);

  const res = await env.send(
    { type: "GET_MATCHES", url: "https://example.com/login" },
    env.mock.tabSender("https://example.com/login")
  );

  assert.equal(res.locked, false);
  assert.equal(res.matches.length, 2);
  for (const m of res.matches) {
    assert.deepEqual(Object.keys(m).sort(), ["hasTotp", "id", "name", "username"]);
    assert.equal("password" in m, false, "a password must never be pushed to a page");
    assert.equal("totp" in m, false, "the TOTP seed is a long-lived secret, not a code");
  }
  assert.equal(res.matches.find((m) => m.name === "With TOTP").hasTotp, true);
  assert.equal(res.matches.find((m) => m.name === "Without TOTP").hasTotp, false);
  // Catches a future field addition that reintroduces a secret under a new name.
  assert.equal(JSON.stringify(res).includes("never-leaves-the-worker"), false);
  assert.equal(JSON.stringify(res).includes("JBSWY3DPEHPK3PXP"), false);
});

test("GET_MATCHES believes the browser about who is asking, not the message body", async () => {
  const env = await unlockedWorker([login({ url: "example.com" })]);
  const res = await env.send(
    { type: "GET_MATCHES", url: "https://example.com/login" }, // the page's own claim
    env.mock.tabSender("https://evil.example/steal")
  );
  assert.deepEqual(res.matches, [], "a page must not be able to name someone else's site");
});

test("GET_MATCHES falls back to the message url when the sender has no origin", async () => {
  // The popup asks on behalf of a tab, so there is no content-script origin.
  const env = await unlockedWorker([login({ url: "example.com" })]);
  const res = await env.send({ type: "GET_MATCHES", url: "https://example.com/login" });
  assert.equal(res.matches.length, 1);
});

test("GET_MATCHES on a locked vault reports locked instead of throwing", async () => {
  // The content script asks on every page load; a rejection here would log an
  // error on every site the user visits while the vault is locked.
  const env = await lockedWorker([login()]);
  const res = await env.send(
    { type: "GET_MATCHES", url: "https://example.com/" },
    env.mock.tabSender("https://example.com/")
  );
  assert.deepEqual(res, { locked: true, matches: [] });
});

test("GET_CREDENTIAL releases the secret to the site the entry belongs to", async () => {
  const entry = login({ url: "example.com", username: "alice", password: "the-secret", totp: "SEED" });
  const env = await unlockedWorker([entry]);

  const res = await env.send(
    { type: "GET_CREDENTIAL", id: entry.id },
    env.mock.tabSender("https://example.com/login")
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.credential, { username: "alice", password: "the-secret", totp: "SEED" });
});

test("GET_CREDENTIAL fills on a subdomain of the site the entry was saved for", async () => {
  const entry = login({ url: "example.com", password: "the-secret" });
  const env = await unlockedWorker([entry]);
  const res = await env.send(
    { type: "GET_CREDENTIAL", id: entry.id },
    env.mock.tabSender("https://login.example.com/")
  );
  assert.equal(res.credential.password, "the-secret");
});

test("GET_CREDENTIAL refuses an entry that does not belong to the requesting page", async () => {
  // A compromised content script knows entry ids from GET_MATCHES on its own
  // site; asking for someone else's by id must not work.
  const entry = login({ url: "bank.com", password: "the-secret" });
  const env = await unlockedWorker([entry]);

  const res = await env.send(
    { type: "GET_CREDENTIAL", id: entry.id },
    env.mock.tabSender("https://evil.example/")
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /No credential for this site/);
  assert.equal(res.credential, undefined);
});

test("GET_CREDENTIAL ignores an origin the message claims for itself", async () => {
  const entry = login({ url: "bank.com", password: "the-secret" });
  const env = await unlockedWorker([entry]);

  const res = await env.send(
    { type: "GET_CREDENTIAL", id: entry.id, url: "https://bank.com/login", origin: "https://bank.com" },
    env.mock.tabSender("https://evil.example/")
  );
  assert.equal(res.ok, false);
  assert.equal(res.credential, undefined);
  assert.equal(JSON.stringify(res).includes("the-secret"), false);
});

test("GET_CREDENTIAL refuses when the requesting page cannot be identified", async () => {
  const entry = login();
  const env = await unlockedWorker([entry]);
  const res = await env.send({ type: "GET_CREDENTIAL", id: entry.id }); // extension-page sender
  assert.equal(res.ok, false);
  assert.match(res.error, /Could not determine the requesting page/);
});

test("GET_CREDENTIAL on a locked vault reports locked and no credential", async () => {
  const env = await lockedWorker([login()]);
  const res = await env.send(
    { type: "GET_CREDENTIAL", id: "anything" },
    env.mock.tabSender("https://example.com/")
  );
  assert.deepEqual(res, { ok: false, locked: true });
});

test("GET_ENTRIES answers a content script with every password in plaintext (current behaviour)", async () => {
  // GET_MATCHES is careful to withhold secrets from a page, but the popup-facing
  // routes check nothing about the sender and a content script can send any
  // message type. Documented as it stands; reported as a defect.
  const env = await unlockedWorker([login({ password: "plaintext-to-any-page" })]);
  const res = await env.send({ type: "GET_ENTRIES" }, env.mock.tabSender("https://unrelated.example/"));
  assert.equal(res.entries[0].password, "plaintext-to-any-page");
});

// ---- the pending-save stash ------------------------------------------------

test("STASH_PENDING then GET_PENDING names the account without returning the password", async () => {
  const env = await unlockedWorker();
  await env.send({
    type: "STASH_PENDING",
    url: "https://example.com/login",
    username: "alice",
    password: "typed-into-the-page",
  });

  const res = await env.send({ type: "GET_PENDING" });
  assert.deepEqual(res.pending, { url: "https://example.com/login", username: "alice" });
  assert.equal(JSON.stringify(res).includes("typed-into-the-page"), false);
});

test("GET_PENDING drops the prompt when the vault already holds that exact credential", async () => {
  const env = await unlockedWorker([login({ url: "example.com", username: "alice", password: "known" })]);
  await env.send({
    type: "STASH_PENDING",
    url: "https://example.com/login",
    username: "alice",
    password: "known",
  });

  assert.deepEqual(await env.send({ type: "GET_PENDING" }), { pending: null });
  assert.equal(env.session.pending_save, undefined, "the stash should be consumed, not re-offered");
});

test("CLEAR_PENDING discards the stashed credential", async () => {
  const env = await unlockedWorker();
  await env.send({ type: "STASH_PENDING", url: "https://a.com/", username: "u", password: "p" });
  assert.deepEqual(await env.send({ type: "CLEAR_PENDING" }), { ok: true });
  assert.equal(env.session.pending_save, undefined);
  assert.deepEqual(await env.send({ type: "GET_PENDING" }), { pending: null });
});

test("SAVE_FROM_PAGE creates an entry from the stash, named after the host", async () => {
  const env = await unlockedWorker();
  await env.send({
    type: "STASH_PENDING",
    url: "https://www.example.com/login",
    username: "alice",
    password: "typed-into-the-page",
  });

  const res = await env.send({ type: "SAVE_FROM_PAGE" }, env.mock.tabSender("https://www.example.com/login"));
  assert.equal(res.created, true);
  const [saved] = (await env.send({ type: "GET_ENTRIES" })).entries;
  assert.equal(saved.name, "example.com", "the leading www should be dropped from the display name");
  assert.equal(saved.username, "alice");
  assert.equal(saved.password, "typed-into-the-page");
});

test("SAVE_FROM_PAGE with nothing stashed is a no-op, not a blank entry", async () => {
  const env = await unlockedWorker();
  const res = await env.send({ type: "SAVE_FROM_PAGE" }, env.mock.tabSender("https://example.com/"));
  assert.equal(res.ok, false);
  assert.match(res.error, /Nothing to save/);
  assert.deepEqual((await env.send({ type: "GET_ENTRIES" })).entries, []);
});

test("the pending-save stash trusts the url in the message, so any page can overwrite any stored password (current behaviour)", async () => {
  // STASH_PENDING and SAVE_FROM_PAGE both ignore `sender` and key off the url in
  // the message body, and neither needs the user to have accepted anything — a
  // content script can send both itself. A page on evil.example can therefore
  // replace the stored bank.com password with one it chose. Documented as it
  // stands; reported as a defect.
  const bank = login({ url: "bank.com", username: "victim", password: "the-real-password" });
  const env = await unlockedWorker([bank]);
  const evil = env.mock.tabSender("https://evil.example/");

  await env.send(
    { type: "STASH_PENDING", url: "https://bank.com/login", username: "victim", password: "attacker-chosen" },
    evil
  );
  const res = await env.send({ type: "SAVE_FROM_PAGE" }, evil);

  assert.equal(res.updated, true);
  const [saved] = (await env.send({ type: "GET_ENTRIES" })).entries;
  assert.equal(saved.password, "attacker-chosen");
  assert.equal(saved.history[0].password, "the-real-password");
});

test("GET_PENDING reveals a credential stashed on another site to any page that asks (current behaviour)", async () => {
  const env = await unlockedWorker();
  await env.send(
    { type: "STASH_PENDING", url: "https://bank.com/login", username: "victim@example.com", password: "p" },
    env.mock.tabSender("https://bank.com/login")
  );

  const res = await env.send({ type: "GET_PENDING" }, env.mock.tabSender("https://evil.example/"));
  assert.deepEqual(res.pending, { url: "https://bank.com/login", username: "victim@example.com" });
});

// ---- auto-lock -------------------------------------------------------------

test("SET_AUTOLOCK stores the timeout and schedules the alarm with it", async () => {
  const env = await unlockedWorker();
  assert.deepEqual(await env.send({ type: "SET_AUTOLOCK", minutes: 5 }), { ok: true });
  assert.deepEqual(env.mock.alarms.get(AUTO_LOCK_ALARM), { delayInMinutes: 5 });
  assert.equal((await env.send({ type: "STATUS" })).autoLockMinutes, 5);
});

test("SET_AUTOLOCK 0 turns auto-lock off", async () => {
  const env = await unlockedWorker();
  await env.send({ type: "SET_AUTOLOCK", minutes: 5 });
  await env.send({ type: "SET_AUTOLOCK", minutes: 0 });
  assert.equal(env.mock.alarms.has(AUTO_LOCK_ALARM), false);
});

test("SET_AUTOLOCK with a non-numeric value silently disables auto-lock (current behaviour)", async () => {
  // Nothing validates `minutes`, and the schedule check is `> 0`, which is false
  // for a string. The vault then stays unlocked indefinitely with no sign that
  // anything is wrong. Documented as it stands; reported as a defect.
  const env = await unlockedWorker();
  await env.send({ type: "SET_AUTOLOCK", minutes: 15 });
  assert.ok(env.mock.alarms.has(AUTO_LOCK_ALARM));

  assert.deepEqual(await env.send({ type: "SET_AUTOLOCK", minutes: "not a number" }), { ok: true });
  assert.equal(env.mock.alarms.has(AUTO_LOCK_ALARM), false);
  assert.equal((await env.send({ type: "STATUS" })).autoLockMinutes, "not a number");
});

test("the auto-lock alarm locks the vault", async () => {
  const env = await unlockedWorker([login()]);
  assert.equal((await env.send({ type: "STATUS" })).locked, false);

  await env.mock.fireAlarm(AUTO_LOCK_ALARM);

  assert.equal(env.session.sess_rawKey, undefined);
  assert.equal((await env.send({ type: "STATUS" })).locked, true);
});

test("an unrelated alarm does not lock the vault", async () => {
  const env = await unlockedWorker([login()]);
  await env.send({ type: "STATUS" });
  await env.mock.fireAlarm("some-other-extension-alarm");
  assert.equal((await env.send({ type: "STATUS" })).locked, false);
});

test("using the vault pushes the auto-lock deadline out again", async () => {
  const env = await unlockedWorker([login()]);
  await env.send({ type: "SET_AUTOLOCK", minutes: 7 });
  env.mock.clearRecords();

  await env.send({ type: "GET_ENTRIES" });
  await flush(); // the handler starts the reschedule without awaiting it

  assert.deepEqual(env.records.alarmsCreated, [{ name: AUTO_LOCK_ALARM, info: { delayInMinutes: 7 } }]);
});

test("the OS screen lock locks the vault, but plain idle does not", async () => {
  // Idle fires after ~60s and would override whatever timeout the user chose.
  const env = await unlockedWorker([login()]);
  await env.send({ type: "STATUS" });

  await env.mock.fireIdle("idle");
  assert.equal((await env.send({ type: "STATUS" })).locked, false);

  await env.mock.fireIdle("locked");
  assert.equal((await env.send({ type: "STATUS" })).locked, true);
});

// ---- clipboard clearing ----------------------------------------------------

test("the clipboard alarm clears in the tab that was active at copy time", async () => {
  // 30s later the active tab may be a different one, and clearing there would
  // reach into a page that was never involved.
  const env = await unlockedWorker([login()]);
  env.mock.setTabs([{ id: 7, active: true, url: "https://example.com/" }]);

  assert.deepEqual(await env.send({ type: "SCHEDULE_CLEAR_CLIPBOARD" }), { ok: true });
  assert.equal(env.session.clipboard_tabId, 7);
  assert.deepEqual(env.mock.alarms.get(CLIPBOARD_ALARM), { delayInMinutes: 0.5 });

  env.mock.setTabs([{ id: 8, active: true, url: "https://elsewhere.example/" }]);
  await env.mock.fireAlarm(CLIPBOARD_ALARM);

  assert.deepEqual(env.records.tabMessages, [{ tabId: 7, message: { type: "CLEAR_CLIPBOARD" } }]);
});

test("the clipboard alarm firing twice only clears once", async () => {
  const env = await unlockedWorker([login()]);
  env.mock.setTabs([{ id: 7, active: true, url: "https://example.com/" }]);
  await env.send({ type: "SCHEDULE_CLEAR_CLIPBOARD" });

  await env.mock.fireAlarm(CLIPBOARD_ALARM);
  await env.mock.fireAlarm(CLIPBOARD_ALARM);
  assert.equal(env.records.tabMessages.length, 1, "the remembered tab id should be consumed");
});

test("a clipboard clear survives the tab having no content script", async () => {
  const env = await unlockedWorker([login()]);
  env.mock.setTabs([{ id: 7, active: true, url: "chrome://settings" }]);
  env.mock.setTabMessageResponder(() => {
    throw new Error("Could not establish connection. Receiving end does not exist.");
  });
  await env.send({ type: "SCHEDULE_CLEAR_CLIPBOARD" });

  await env.mock.fireAlarm(CLIPBOARD_ALARM); // must not produce an unhandled rejection
  assert.equal(env.records.tabMessages.length, 1);
});

// ---- badge and keyboard shortcut -------------------------------------------

test("the badge shows how many entries match the tab's host", async () => {
  const env = await unlockedWorker([login({ name: "One" }), login({ name: "Two", username: "bob" })]);
  await env.send({ type: "STATUS" }); // hydrate before the event, as a live worker would be

  await env.mock.fireTabUpdated(3, { status: "complete" }, { id: 3, url: "https://example.com/login" });
  await flush();
  assert.equal(env.mock.badgeTextFor(3), "2");
});

test("the badge count refreshes after the entries change", async () => {
  // The count is cached per host to keep tab switches cheap; a stale cache would
  // keep advertising a credential the user just deleted.
  const entry = login();
  const env = await unlockedWorker([entry]);
  await env.send({ type: "STATUS" });

  const tab = { id: 3, url: "https://example.com/login" };
  await env.mock.fireTabUpdated(3, { status: "complete" }, tab);
  await flush();
  assert.equal(env.mock.badgeTextFor(3), "1");

  await env.send({ type: "DELETE_ENTRY", id: entry.id });
  await env.mock.fireTabUpdated(3, { status: "complete" }, tab);
  await flush();
  assert.equal(env.mock.badgeTextFor(3), "");
});

test("the badge is blank while the vault is locked", async () => {
  const env = await lockedWorker([login()]);
  await env.mock.fireTabUpdated(3, { status: "complete" }, { id: 3, url: "https://example.com/" });
  await flush();
  assert.equal(env.mock.badgeTextFor(3), "");
});

test("the fill-login shortcut pushes the matching credential to the active tab", async () => {
  const env = await unlockedWorker([login({ username: "alice", password: "the-secret" })]);
  env.mock.setTabs([{ id: 9, active: true, url: "https://example.com/login" }]);

  await env.mock.fireCommand("fill-login");
  assert.deepEqual(env.records.tabMessages, [
    { tabId: 9, message: { type: "FILL_CREDENTIALS", match: { username: "alice", password: "the-secret" } } },
  ]);
});

test("the fill-login shortcut sends nothing when the vault is locked", async () => {
  const env = await lockedWorker([login()]);
  env.mock.setTabs([{ id: 9, active: true, url: "https://example.com/login" }]);
  await env.mock.fireCommand("fill-login");
  assert.deepEqual(env.records.tabMessages, []);
});

test("the fill-login shortcut sends nothing when no entry matches the tab", async () => {
  const env = await unlockedWorker([login({ url: "example.com" })]);
  env.mock.setTabs([{ id: 9, active: true, url: "https://unrelated.example/login" }]);
  await env.mock.fireCommand("fill-login");
  assert.deepEqual(env.records.tabMessages, []);
});

// ---- Drive routes while disconnected ---------------------------------------

test("SYNC without Drive connected explains itself instead of reaching the network", async () => {
  const env = await unlockedWorker([login()]);
  const res = await env.send({ type: "SYNC" });
  assert.equal(res.ok, false);
  assert.match(res.error, /not connected/);
  assert.deepEqual(env.net.requests, [], "nothing should hit the network while disconnected");
});

test("DISCONNECT_DRIVE forgets the remote file ids so a reconnect re-discovers them", async () => {
  const env = await unlockedWorker([], {
    local: { cfg: { driveConnected: true, email: "x@example.com" }, cache_fileId: "f1", cache_modifiedTime: "t1" },
  });
  env.net.on("oauth2.googleapis.com/revoke", { status: 200, json: {} });

  assert.deepEqual(await env.send({ type: "DISCONNECT_DRIVE" }), { ok: true });
  assert.deepEqual(env.net.unmatched, [], "sign-out should only talk to the revoke endpoint");

  assert.equal(env.local.cache_fileId, undefined);
  assert.equal(env.local.cache_modifiedTime, undefined);
  const status = await env.send({ type: "STATUS" });
  assert.equal(status.connected, false);
  assert.equal(status.email, null);
  assert.ok(env.local.cache_file, "disconnecting must not delete the local vault");
});
