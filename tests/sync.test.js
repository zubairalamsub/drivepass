// The Drive push protocol in src/background/service-worker.js is where DrivePass
// can lose data without anyone noticing. Every save overwrites a file a second
// device may have written since we last read it, and the only thing between that
// and a vanished entry is persistVault's "check modifiedTime -> download -> merge
// -> re-seal" dance. Nothing in the UI reports a dropped entry, so a regression
// here is silent by construction.
//
// These tests run the whole protocol against a fake Drive (a Map behind the four
// REST endpoints drive.js calls) so the assertions are about what actually landed
// in "Drive", decrypted — not about which functions were called.

import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { loadServiceWorker, reset, uninstall, flush } from "./helpers/chrome-mock.js";
import {
  FORMAT,
  FILE_NAME,
  MIN_ACCEPTED_ITERATIONS,
  newEntry,
  sealVault,
  openVaultFile,
} from "../src/lib/vault.js";
import {
  KDF_ITERATIONS,
  deriveKey,
  encryptJSON,
  decryptJSON,
  importRawKey,
  randomSalt,
  bytesToB64,
} from "../src/lib/crypto.js";

const MASTER = "correct horse battery staple";

let env;
beforeEach(async () => { env = await loadServiceWorker(); });
afterEach(() => reset());
after(() => uninstall());

// ---- a fake Drive ----------------------------------------------------------

// Backs the four endpoints drive.js talks to with a Map, so a test can read back
// exactly what was stored and under which modifiedTime. Registered per test, not
// in beforeEach, so a test can instead install a failing network.
function fakeDrive(net) {
  const files = new Map(); // id -> { name, content, modifiedTime }
  let seq = 0;
  let created = 0;
  const stamp = () => `2026-01-01T00:00:${String(seq++).padStart(2, "0")}Z`;
  const idIn = (url) => url.match(/\/files\/([^?]+)/)[1];
  const gone = { status: 404, json: { error: { code: 404, message: "File not found" } } };

  const api = {
    files,
    /** Put a file in Drive as if another device had written it. */
    put(id, content, modifiedTime = stamp()) {
      files.set(id, { name: FILE_NAME, content: structuredClone(content), modifiedTime });
      return { id, modifiedTime };
    },
    get: (id) => files.get(id),
    contentOf: (id) => files.get(id)?.content,
  };

  // findVaultFile — the real query filters by name; every file here is a vault.
  net.on(/\/drive\/v3\/files\?q=/, () => ({
    json: {
      files: [...files]
        .map(([id, f]) => ({ id, name: f.name, modifiedTime: f.modifiedTime }))
        .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime)),
    },
  }));

  // downloadVaultFile
  net.on(/alt=media/, (req) => {
    const f = files.get(idIn(req.url));
    return f ? { json: f.content } : gone;
  });

  // createVaultFile (multipart: metadata part, then the media part)
  net.on(/upload\/drive\/v3\/files\?uploadType=multipart/, (req) => {
    const media = req.body.split("\r\n\r\n")[2].split("\r\n--")[0];
    return { json: api.put(`created-${++created}`, JSON.parse(media)) };
  });

  // updateVaultFile
  net.on(/upload\/drive\/v3\/files\/[^?]+\?uploadType=media/, (req) => {
    const id = idIn(req.url);
    if (!files.has(id)) return gone;
    return { json: api.put(id, JSON.parse(req.body)) };
  });

  // getFileMeta
  net.on(/\/drive\/v3\/files\/[^?]+\?fields=/, (req) => {
    const f = files.get(idIn(req.url));
    return f ? { json: { id: idIn(req.url), modifiedTime: f.modifiedTime } } : gone;
  });

  return api;
}

function opOf(req) {
  if (req.url.includes("alt=media")) return "download";
  if (req.url.includes("uploadType=media")) return "update";
  if (req.url.includes("uploadType=multipart")) return "create";
  if (req.url.includes("?q=")) return "search";
  return "meta";
}
/** The Drive conversation so far, as a readable sequence. */
const ops = () => env.net.requests.map(opOf);
const uploadedBodies = () => env.net.requests.filter((r) => opOf(r) === "update").map((r) => JSON.parse(r.body));
const interactivePrompts = () => env.records.getAuthToken.filter((r) => r.interactive).length;

// ---- setup helpers ---------------------------------------------------------

/** A vault created and unlocked with Drive still off, so setup makes no network
 *  calls at all. Returns the session key, for reading back what was sealed. */
async function unlockedVault(entries = []) {
  assert.equal((await env.send({ type: "CREATE_VAULT", password: MASTER })).ok, true);
  for (const entry of entries) {
    assert.equal((await env.send({ type: "SAVE_ENTRY", entry })).ok, true);
  }
  return importRawKey(env.session.sess_rawKey);
}

function connectDrive(extra = {}) {
  env.mock.seed({ local: { cfg: { driveConnected: true, email: "z@example.com" }, ...extra } });
}

const readLocalCache = (key) => decryptJSON(key, env.local.cache_file.iv, env.local.cache_file.ciphertext);
const readDrive = (drive, key, id = "file-1") => {
  const f = drive.contentOf(id);
  return decryptJSON(key, f.iv, f.ciphertext);
};
const idsOf = (data) => data.entries.map((e) => e.id).sort();

// A vault as written by a release with a lower KDF cost.
async function legacyVaultFile(password, iterations, data) {
  const salt = randomSalt();
  const key = await deriveKey(password, salt, iterations);
  const { iv, ciphertext } = await encryptJSON(key, data);
  return { format: FORMAT, kdf: "PBKDF2-SHA256", iterations, salt: bytesToB64(salt), iv, ciphertext };
}

// handleUnlock starts the Drive sync and the KDF upgrade without awaiting them,
// and PBKDF2 runs off the main thread, so one flush() can land mid-chain.
async function waitFor(predicate, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// ---- persistVault: Drive not connected -------------------------------------

test("with Drive off, a save is written to the local cache and reported as unsynced", async () => {
  const key = await unlockedVault();

  const res = await env.send({ type: "SAVE_ENTRY", entry: { id: "a", name: "Alpha", password: "pw-a" } });

  assert.deepEqual(res.sync, { synced: false });
  assert.deepEqual(env.net.requests, [], "an unconnected vault must not touch the network");
  const cached = await readLocalCache(key);
  assert.deepEqual(cached.entries.map((e) => e.name), ["Alpha"], "the save has to survive locally regardless");
});

// ---- persistVault: the modifiedTime shortcut --------------------------------

test("an unchanged remote is pushed over without being downloaded again", async () => {
  // Re-downloading and re-merging on every keystroke-sized save would cost a
  // round trip per save for nothing; the modifiedTime check is what avoids it.
  const drive = fakeDrive(env.net);
  const key = await unlockedVault([{ id: "a", name: "Alpha", url: "alpha.test", password: "pw-a" }]);
  const { modifiedTime } = drive.put("file-1", env.local.cache_file);
  connectDrive({ cache_fileId: "file-1", cache_modifiedTime: modifiedTime });

  const res = await env.send({ type: "SAVE_ENTRY", entry: { id: "b", name: "Beta", url: "beta.test" } });

  assert.deepEqual(res.sync, { synced: true });
  assert.deepEqual(ops(), ["meta", "update"], "a matching modifiedTime must skip the download");
  assert.deepEqual(idsOf(await readDrive(drive, key)), ["a", "b"]);
  assert.equal(env.local.cache_modifiedTime, drive.get("file-1").modifiedTime);
});

test("a remote that moved on is downloaded, merged, and pushed back as the union", async () => {
  // The regression guard: without the merge this PATCH would replace a Drive
  // copy holding "remote" with one that has never heard of it, and nothing
  // anywhere would report the loss.
  const drive = fakeDrive(env.net);
  const key = await unlockedVault([{ id: "local", name: "Local", url: "local.test", password: "pw-local" }]);

  const remote = await sealVault(
    key,
    { entries: [newEntry({ id: "remote", name: "Remote", url: "remote.test", password: "pw-remote" })] },
    env.local.cache_file
  );
  drive.put("file-1", remote);
  connectDrive({ cache_fileId: "file-1", cache_modifiedTime: "2020-01-01T00:00:00Z" });

  const res = await env.send({
    type: "SAVE_ENTRY",
    entry: { id: "second", name: "Second", url: "second.test", password: "pw-2" },
  });

  assert.deepEqual(res.sync, { synced: true });
  assert.deepEqual(ops(), ["meta", "download", "update"]);
  assert.deepEqual(idsOf(await readDrive(drive, key)), ["local", "remote", "second"]);
  assert.deepEqual(idsOf(await readLocalCache(key)), ["local", "remote", "second"]);

  const { entries } = await env.send({ type: "GET_ENTRIES" });
  assert.deepEqual(entries.map((e) => e.name), ["Local", "Remote", "Second"]);
});

test("the merge keeps whichever side edited an entry last, in both directions", async () => {
  // Taking the remote wholesale, or ignoring it wholesale, both pass a test that
  // only looks at one entry — so check an entry we edited last and one they did.
  const drive = fakeDrive(env.net);
  const key = await unlockedVault([
    { id: "ours", name: "Ours", url: "ours.test", password: "pw-ours" },
    { id: "theirs", name: "Theirs", url: "theirs.test", password: "pw-superseded" },
  ]);

  const remote = await sealVault(
    key,
    {
      entries: [
        { ...newEntry({ id: "ours", name: "Ours", url: "ours.test", password: "pw-stale" }), updatedAt: 1 },
        {
          ...newEntry({ id: "theirs", name: "Theirs", url: "theirs.test", password: "pw-newer" }),
          updatedAt: Date.now() + 60_000,
        },
      ],
    },
    env.local.cache_file
  );
  drive.put("file-1", remote);
  connectDrive({ cache_fileId: "file-1", cache_modifiedTime: "2020-01-01T00:00:00Z" });

  await env.send({ type: "SAVE_ENTRY", entry: { id: "extra", name: "Extra", url: "extra.test" } });

  const pushed = await readDrive(drive, key);
  const passwords = Object.fromEntries(pushed.entries.map((e) => [e.id, e.password]));
  assert.equal(passwords.ours, "pw-ours");
  assert.equal(passwords.theirs, "pw-newer");
});

// ---- persistVault: an unreadable remote -------------------------------------

test("a Drive copy we cannot decrypt is left alone and surfaced as a conflict", async () => {
  // Overwriting here would destroy a vault we cannot even read. The only safe
  // move is to refuse, and to say so instead of reporting a successful sync.
  const drive = fakeDrive(env.net);
  const key = await unlockedVault([{ id: "mine", name: "Mine", url: "mine.test", password: "pw" }]);

  const foreign = await (async () => {
    const salt = randomSalt();
    const otherKey = await deriveKey("a completely different master", salt, MIN_ACCEPTED_ITERATIONS);
    const { iv, ciphertext } = await encryptJSON(otherKey, { entries: [newEntry({ id: "theirs" })] });
    return { format: FORMAT, kdf: "PBKDF2-SHA256", iterations: MIN_ACCEPTED_ITERATIONS, salt: bytesToB64(salt), iv, ciphertext };
  })();
  drive.put("file-1", foreign);
  connectDrive({ cache_fileId: "file-1", cache_modifiedTime: "2020-01-01T00:00:00Z" });

  const res = await env.send({ type: "SAVE_ENTRY", entry: { id: "new", name: "New", url: "new.test" } });

  assert.equal(res.sync.synced, false);
  assert.match(res.sync.error, /re-keyed on another device/);
  assert.deepEqual(ops(), ["meta", "download"], "the push must stop before any upload");
  assert.deepEqual(drive.contentOf("file-1"), foreign, "the unreadable Drive copy was overwritten");
  assert.equal(
    interactivePrompts(),
    0,
    "a conflict is not an auth failure; re-prompting for consent would fail the same way"
  );

  // The local save is still not lost — it just has not reached Drive.
  assert.deepEqual(idsOf(await readLocalCache(key)), ["mine", "new"]);
});

// ---- SYNC: merge semantics end to end ---------------------------------------

test("SYNC folds in a remote-only entry, keeps our newer edit, and does not resurrect a purged id", async () => {
  const drive = fakeDrive(env.net);
  const key = await unlockedVault([
    { id: "alpha", name: "Alpha", url: "alpha.test", password: "fresh-alpha" },
    { id: "beta", name: "Beta", url: "beta.test", password: "pw-beta" },
  ]);
  await env.send({ type: "PURGE_ENTRY", id: "beta" });

  // A stale Drive copy: an older Alpha, the Beta we hard-deleted, and an entry
  // only the other device knows about.
  const remote = await sealVault(
    key,
    {
      entries: [
        { ...newEntry({ id: "alpha", name: "Alpha", url: "alpha.test", password: "stale-alpha" }), updatedAt: 1 },
        newEntry({ id: "beta", name: "Beta", url: "beta.test", password: "pw-beta" }),
        newEntry({ id: "gamma", name: "Gamma", url: "gamma.test", password: "pw-gamma" }),
      ],
    },
    env.local.cache_file
  );
  drive.put("file-1", remote);
  connectDrive();

  const res = await env.send({ type: "SYNC" });

  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  const { entries } = await env.send({ type: "GET_ENTRIES" });
  assert.deepEqual(entries.map((e) => e.id), ["alpha", "gamma"]);
  assert.equal(entries[0].password, "fresh-alpha", "our newer edit must not be replaced by the stale remote one");

  const pushed = await readDrive(drive, key);
  assert.deepEqual(idsOf(pushed), ["alpha", "gamma"]);
  assert.deepEqual(pushed.purged, ["beta"], "the tombstone has to reach Drive or the other device revives beta");
});

test("SYNC records the revision it reconciled against, so the push that follows does not re-merge", async () => {
  const drive = fakeDrive(env.net);
  const key = await unlockedVault([{ id: "a", name: "Alpha", url: "alpha.test" }]);
  drive.put("file-1", await sealVault(key, { entries: [newEntry({ id: "b", name: "Beta", url: "beta.test" })] }, env.local.cache_file));
  connectDrive();

  await env.send({ type: "SYNC" });

  assert.deepEqual(
    ops(),
    ["search", "download", "meta", "update"],
    "a second download here would mean the merge ran twice against the same revision"
  );
  assert.equal(env.local.cache_fileId, "file-1");
  assert.equal(env.local.cache_modifiedTime, drive.get("file-1").modifiedTime);
  assert.deepEqual(idsOf(await readDrive(drive, key)), ["a", "b"]);
});

test("SYNC refuses rather than pushing when the remote was sealed with another password", async () => {
  const drive = fakeDrive(env.net);
  const key = await unlockedVault([{ id: "mine", name: "Mine", url: "mine.test" }]);
  const salt = randomSalt();
  const otherKey = await deriveKey("another master", salt, MIN_ACCEPTED_ITERATIONS);
  const { iv, ciphertext } = await encryptJSON(otherKey, { entries: [] });
  const foreign = { format: FORMAT, kdf: "PBKDF2-SHA256", iterations: MIN_ACCEPTED_ITERATIONS, salt: bytesToB64(salt), iv, ciphertext };
  drive.put("file-1", foreign);
  connectDrive();

  const res = await env.send({ type: "SYNC" });

  assert.equal(res.ok, false);
  assert.match(res.error, /different master password/);
  assert.deepEqual(drive.contentOf("file-1"), foreign);
  assert.deepEqual(ops(), ["search", "download"]);
  assert.deepEqual(idsOf(await readLocalCache(key)), ["mine"], "our own vault is untouched by the refusal");
});

// ---- KDF upgrade on unlock ---------------------------------------------------

test("an offline unlock of a low-cost vault re-keys it and the result opens with the same password", async () => {
  const legacy = await legacyVaultFile(MASTER, MIN_ACCEPTED_ITERATIONS, {
    entries: [newEntry({ id: "old", name: "Old", url: "old.test", password: "keep-me" })],
  });
  env.mock.seed({ local: { cache_file: legacy } });

  assert.equal((await env.send({ type: "UNLOCK", password: MASTER })).ok, true);

  assert.equal(env.local.cache_file.iterations, KDF_ITERATIONS);
  assert.notEqual(env.local.cache_file.salt, legacy.salt, "a re-key should re-salt too");
  const reopened = await openVaultFile(env.local.cache_file, MASTER);
  assert.equal(reopened.needsKdfUpgrade, false);
  assert.equal(reopened.data.entries[0].password, "keep-me");
  assert.deepEqual(env.net.requests, []);
});

test("with Drive connected, the sync push goes out under the old key before the re-key push", async () => {
  // Ordering is the whole point: merging decrypts the Drive copy with the key it
  // was written under. Re-key first and the merge can no longer read the remote,
  // so a sync at that moment reports "different master password" and whatever the
  // other device wrote is dropped.
  const drive = fakeDrive(env.net);
  const legacy = await legacyVaultFile(MASTER, MIN_ACCEPTED_ITERATIONS, {
    entries: [newEntry({ id: "old", name: "Old", url: "old.test", password: "keep-me" })],
  });
  drive.put("file-1", legacy);
  connectDrive();

  assert.equal((await env.send({ type: "UNLOCK", password: MASTER })).ok, true);
  // The local cache is re-keyed before the push, so wait on Drive, not on it.
  await waitFor(() => drive.contentOf("file-1")?.iterations === KDF_ITERATIONS, "the re-key to reach Drive");
  await flush();

  const uploads = uploadedBodies();
  assert.equal(uploads.length, 2);
  assert.equal(
    uploads[0].iterations,
    MIN_ACCEPTED_ITERATIONS,
    "the sync push must still be under the key the Drive copy was written with"
  );
  assert.equal(uploads[1].iterations, KDF_ITERATIONS, "only the second push carries the re-keyed file");
  assert.deepEqual(ops(), ["search", "download", "search", "download", "meta", "update", "meta", "update"]);

  // And the file Drive ends up holding still opens with the unchanged password.
  const opened = await openVaultFile(drive.contentOf("file-1"), MASTER);
  assert.equal(opened.needsKdfUpgrade, false);
  assert.equal(opened.data.entries[0].password, "keep-me");
});

// ---- pushing when Drive has no file / a dead file id -------------------------

test("with no file id and nothing in Drive, the first save creates the vault file", async () => {
  const drive = fakeDrive(env.net);
  const key = await unlockedVault();
  connectDrive();

  const res = await env.send({ type: "SAVE_ENTRY", entry: { id: "a", name: "Alpha", url: "alpha.test" } });

  assert.deepEqual(res.sync, { synced: true });
  assert.deepEqual(ops(), ["search", "create"]);
  assert.equal(env.local.cache_fileId, "created-1");
  assert.deepEqual(idsOf(await readDrive(drive, key, "created-1")), ["a"]);
  assert.equal(interactivePrompts(), 0, "the first push must not throw a consent window at the user");
});

test("a stale cached file id is dropped and the vault is re-found by name", async () => {
  // Regression guard. A cached id goes dead when the file is deleted or the
  // per-file grant is withdrawn. Patching it 404s forever, so the id must be
  // cleared and the vault rediscovered by name before the push.
  const drive = fakeDrive(env.net);
  const key = await unlockedVault([{ id: "mine", name: "Mine", url: "mine.test" }]);
  const stillThere = await sealVault(key, { entries: [newEntry({ id: "remote" })] }, env.local.cache_file);
  drive.put("file-new", stillThere);
  connectDrive({ cache_fileId: "file-gone", cache_modifiedTime: "2020-01-01T00:00:00Z" });

  const res = await env.send({ type: "SAVE_ENTRY", entry: { id: "fresh", name: "Fresh", url: "fresh.test" } });

  assert.deepEqual(res.sync, { synced: true });
  assert.ok(ops().includes("search"), "the dead id must send us back to the name query");
  assert.equal(env.local.cache_fileId, "file-new", "the rediscovered id replaces the dead one");
  assert.equal(interactivePrompts(), 0, "a missing file is not an auth problem");

  // The remote entry that was sitting under the new id is merged, not clobbered.
  assert.deepEqual(idsOf(await readDrive(drive, key, "file-new")), ["fresh", "mine", "remote"]);
  assert.deepEqual(idsOf(await readLocalCache(key)), ["fresh", "mine", "remote"]);
});

test("a dead file id with no vault to re-find stops instead of forking the vault", async () => {
  // Creating a replacement here would be worse than failing: if the grant was
  // merely lost, we would end up with two vault.enc files taking turns
  // overwriting each other.
  fakeDrive(env.net); // empty Drive — the name query finds nothing
  const key = await unlockedVault([{ id: "mine", name: "Mine", url: "mine.test" }]);
  connectDrive({ cache_fileId: "file-gone", cache_modifiedTime: "2020-01-01T00:00:00Z" });

  const res = await env.send({ type: "SAVE_ENTRY", entry: { id: "fresh", name: "Fresh", url: "fresh.test" } });

  assert.equal(res.sync.synced, false);
  assert.match(res.sync.error, /no longer in your Google Drive/);
  assert.ok(!ops().includes("create"), "must not silently create a second vault");
  assert.equal(interactivePrompts(), 0, "and must not throw a consent window at the user");

  // The save is still safe locally, which is the whole point of caching first.
  assert.deepEqual(idsOf(await readLocalCache(key)), ["fresh", "mine"]);
});

test("a Drive outage keeps the save locally and reports the failure instead of a sync", async () => {
  env.net.on("*", { throws: "Failed to fetch" });
  const key = await unlockedVault([{ id: "mine", name: "Mine", url: "mine.test" }]);
  connectDrive({ cache_fileId: "file-1", cache_modifiedTime: "2020-01-01T00:00:00Z" });

  const res = await env.send({ type: "SAVE_ENTRY", entry: { id: "fresh", name: "Fresh", url: "fresh.test" } });

  assert.equal(res.sync.synced, false);
  assert.match(res.sync.error, /Failed to fetch/);
  assert.deepEqual(idsOf(await readLocalCache(key)), ["fresh", "mine"]);
  // Current behaviour: any push failure, network included, is retried with
  // interactive consent. Reported — a flaky connection should not open a Google
  // window over the user's page.
  assert.equal(interactivePrompts(), 1);
});
