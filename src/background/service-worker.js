// service-worker.js — DrivePass background coordinator.
//
// Responsibilities:
//   * Hold the decryption key for the current session (in chrome.storage.session,
//     which is in-memory and cleared when the browser fully closes).
//   * Route messages from the popup, options page, and content scripts.
//   * Sync the encrypted vault to/from Google Drive.
//   * Auto-lock after a period of inactivity.
//
// The vault works fully offline/local before Google Drive is connected, so the
// extension is testable without OAuth setup. Connecting Drive turns on sync.

import { importRawKey, exportRawKey, decryptJSON, setupPin, unlockWithPin, removePin } from "../lib/crypto.js";
import {
  FILE_NAME,
  newEntry,
  createVaultFile as buildVaultFile,
  openVaultFile,
  sealVault,
  rekeyVault,
  mergeVaults,
  liveEntries,
  trashEntries,
  restoreEntry,
  purgeEntry,
  purgeAllTrash,
  toggleFavorite,
  matchEntriesForHost,
} from "../lib/vault.js";
import {
  getToken,
  getUserEmail,
  findVaultFile,
  getFileMeta,
  createVaultFile as driveCreateFile,
  updateVaultFile,
  downloadVaultFile,
  signOut as driveSignOut,
} from "../lib/drive.js";

const AUTO_LOCK_ALARM = "drivepass-autolock";

// In-memory session state (rebuilt from chrome.storage.session on SW wake).
let sessionKey = null; // CryptoKey
let vaultData = null; // { entries: [...] }
let cachedFileObj = null; // last encrypted file object

// ---- config --------------------------------------------------------------
async function getConfig() {
  const { cfg } = await chrome.storage.local.get("cfg");
  return { autoLockMinutes: 15, driveConnected: false, email: null, ...(cfg || {}) };
}
async function saveConfig(patch) {
  const cfg = { ...(await getConfig()), ...patch };
  await chrome.storage.local.set({ cfg });
  return cfg;
}

// ---- session (un)lock ------------------------------------------------------
// Rebuild in-memory state from session storage after a SW restart.
async function hydrate() {
  if (sessionKey && vaultData) return true;
  const sess = await chrome.storage.session.get("sess_rawKey");
  const local = await chrome.storage.local.get("cache_file");
  if (!sess.sess_rawKey || !local.cache_file) return false;
  try {
    sessionKey = await importRawKey(sess.sess_rawKey);
    cachedFileObj = local.cache_file;
    vaultData = await decryptJSON(sessionKey, cachedFileObj.iv, cachedFileObj.ciphertext);
    return true;
  } catch {
    await lock();
    return false;
  }
}

async function lock() {
  sessionKey = null;
  vaultData = null;
  invalidateBadgeCache();
  await chrome.storage.session.remove("sess_rawKey");
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
}

async function scheduleAutoLock() {
  const cfg = await getConfig();
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  if (cfg.autoLockMinutes > 0) {
    chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: cfg.autoLockMinutes });
  }
}

function touchActivity() {
  scheduleAutoLock();
}

// ---- vault persistence -----------------------------------------------------

// Raised when the Drive copy can't be reconciled with ours. Distinct from a
// network/auth failure so the caller knows not to retry with fresh consent.
class VaultConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "VaultConflict";
  }
}

// The file we were syncing to is gone from Drive and no replacement was found
// by name. Distinct from a conflict, and equally not an auth problem.
class VaultMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = "VaultMissing";
  }
}

// Errors that mean "stop, this will not succeed on retry" — as opposed to a
// stale token, which a fresh interactive grant would fix.
const isTerminalSyncError = (e) => e?.name === "VaultConflict" || e?.name === "VaultMissing";

// Fold any changes another device made into `vaultData` before we overwrite
// the Drive copy. Without this, a plain PATCH silently drops whatever the
// other device wrote since our last sync. Returns true if a merge happened.
async function mergeRemoteIfChanged(fileId, knownModifiedTime, meta) {
  if (!meta) return false;
  if (knownModifiedTime && meta.modifiedTime === knownModifiedTime) return false;

  const remoteFile = await downloadVaultFile(fileId);
  let remoteData;
  try {
    remoteData = await decryptJSON(sessionKey, remoteFile.iv, remoteFile.ciphertext);
  } catch {
    // We cannot read the Drive copy, so we cannot merge it — most likely it was
    // re-keyed on another device. Overwriting would destroy a vault we can't
    // read, so refuse and surface it rather than "winning" the conflict.
    throw new VaultConflictError(
      "The copy in Drive can't be opened with this key — it may have been " +
        "re-keyed on another device. Leaving it untouched."
    );
  }
  vaultData = mergeVaults(vaultData, remoteData);
  return true;
}

// Seal the current vault, cache it locally, and push to Drive if connected.
async function persistVault() {
  // Local cache first, so the write survives even if Drive is unreachable.
  cachedFileObj = await sealVault(sessionKey, vaultData, cachedFileObj);
  await chrome.storage.local.set({ cache_file: cachedFileObj });
  invalidateBadgeCache(); // entries changed; counts may have too

  const cfg = await getConfig();
  if (!cfg.driveConnected) return { synced: false };

  async function pushToDrive() {
    let { cache_fileId, cache_modifiedTime } = await chrome.storage.local.get([
      "cache_fileId",
      "cache_modifiedTime",
    ]);
    let meta = null;
    // A file we just located by name has never been reconciled against this
    // device's copy, so its modifiedTime tells us nothing and we must merge
    // rather than assume our copy is newer.
    let freshlyDiscovered = false;
    if (!cache_fileId) {
      const found = await findVaultFile(FILE_NAME);
      cache_fileId = found?.id;
      cache_modifiedTime = found?.modifiedTime;
      freshlyDiscovered = !!cache_fileId;
      if (cache_fileId) meta = await getFileMeta(cache_fileId);
    } else {
      // Confirm the id still resolves BEFORE patching it. A cached id can go
      // stale when the file is deleted or the per-file grant is withdrawn, and
      // PATCHing a dead id 404s on every future save with no way to recover.
      meta = await getFileMeta(cache_fileId);
      if (!meta) {
        await chrome.storage.local.remove(["cache_fileId", "cache_modifiedTime"]);
        const found = await findVaultFile(FILE_NAME);
        if (!found) {
          // Deliberately NOT creating one here: if the grant was merely lost,
          // creating would fork the vault into two files that then take turns
          // overwriting each other. Better to stop and say so.
          throw new VaultMissingError(
            "The vault file is no longer in your Google Drive. Reconnect Drive, " +
              "or restore vault.enc, to resume syncing."
          );
        }
        cache_fileId = found.id;
        cache_modifiedTime = found.modifiedTime;
        freshlyDiscovered = true;
        meta = await getFileMeta(cache_fileId);
      }
    }

    const since = freshlyDiscovered ? null : cache_modifiedTime;
    if (cache_fileId && (await mergeRemoteIfChanged(cache_fileId, since, meta))) {
      // The merge changed our in-memory vault — re-seal so we push the union.
      cachedFileObj = await sealVault(sessionKey, vaultData, cachedFileObj);
      await chrome.storage.local.set({ cache_file: cachedFileObj });
    }

    const result = cache_fileId
      ? await updateVaultFile(cache_fileId, cachedFileObj)
      : await driveCreateFile(FILE_NAME, cachedFileObj, false);
    await chrome.storage.local.set({
      cache_fileId: result.id,
      cache_modifiedTime: result.modifiedTime,
    });
    return { synced: true };
  }

  try {
    // Ensure we have a valid token before pushing
    await getToken(false);
    return await pushToDrive();
  } catch (e) {
    // A conflict or a missing file is not an auth problem — re-prompting for
    // consent would just throw a Google window at the user and fail the same way.
    if (isTerminalSyncError(e)) return { synced: false, error: e.message };
    // If token expired or first attempt failed, retry once with a fresh token
    try {
      await getToken(true);
      return await pushToDrive();
    } catch (retryErr) {
      return { synced: false, error: retryErr.message };
    }
  }
}

// ---- handlers --------------------------------------------------------------
async function handleStatus() {
  const cfg = await getConfig();
  const unlocked = await hydrate();
  const local = await chrome.storage.local.get("cache_file");
  const { pin_config } = await chrome.storage.local.get("pin_config");
  let hasVault = !!local.cache_file;

  if (!hasVault && cfg.driveConnected) {
    try {
      const found = await findVaultFile(FILE_NAME);
      if (found) {
        const obj = await downloadVaultFile(found.id);
        await chrome.storage.local.set({ cache_file: obj, cache_fileId: found.id });
        hasVault = true;
      }
    } catch {
      /* offline — leave hasVault as-is */
    }
  }
  return {
    connected: cfg.driveConnected,
    email: cfg.email,
    locked: !unlocked,
    hasVault,
    hasPin: !!pin_config,
    count: unlocked ? liveEntries(vaultData).length : 0,
    autoLockMinutes: cfg.autoLockMinutes,
  };
}

async function handleCreateVault({ password }) {
  const cfg = await getConfig();
  if (cfg.driveConnected) {
    const found = await findVaultFile(FILE_NAME);
    if (found) throw new Error("A vault already exists in your Drive. Unlock it instead.");
  }
  const { file, key } = await buildVaultFile(password);
  sessionKey = key;
  vaultData = { entries: [] };
  cachedFileObj = file;
  await chrome.storage.local.set({ cache_file: file });
  await chrome.storage.session.set({ sess_rawKey: await exportRawKey(key) });
  if (cfg.driveConnected) {
    const result = await driveCreateFile(FILE_NAME, file, false);
    await chrome.storage.local.set({ cache_fileId: result.id, cache_modifiedTime: result.modifiedTime });
  }
  await scheduleAutoLock();
  return { ok: true };
}

async function handleUnlock({ password }) {
  const cfg = await getConfig();
  let fileObj = null;

  if (cfg.driveConnected) {
    try {
      const found = await findVaultFile(FILE_NAME);
      if (found) {
        fileObj = await downloadVaultFile(found.id);
        await chrome.storage.local.set({
          cache_file: fileObj,
          cache_fileId: found.id,
          cache_modifiedTime: found.modifiedTime,
        });
      }
    } catch {
      /* offline — fall back to local cache */
    }
  }
  if (!fileObj) {
    const local = await chrome.storage.local.get("cache_file");
    fileObj = local.cache_file;
  }
  if (!fileObj) throw new Error("No vault found yet. Create one first.");

  // throws on wrong password
  const { key, data, needsKdfUpgrade } = await openVaultFile(fileObj, password);
  sessionKey = key;
  vaultData = data;
  cachedFileObj = fileObj;
  await chrome.storage.session.set({ sess_rawKey: await exportRawKey(key) });
  await chrome.storage.local.set({ cache_file: fileObj });
  await scheduleAutoLock();

  // Vault predates a KDF cost increase — migrate it while we still hold the
  // master password. Best-effort: a failure here must not block unlock.
  const upgradeKdf = async () => {
    if (!needsKdfUpgrade) return;
    try {
      const up = await rekeyVault(password, vaultData);
      sessionKey = up.key;
      cachedFileObj = up.file;
      await chrome.storage.session.set({ sess_rawKey: await exportRawKey(up.key) });
      await persistVault();
    } catch {
      /* keep the vault open at its old cost; retry on the next unlock */
    }
  };

  // Order matters: merging reads the Drive copy with the key it was written
  // under, so the sync has to finish before we change keys underneath it.
  const cfg2 = await getConfig();
  if (cfg2.driveConnected) {
    handleSync()
      .then(upgradeKdf)
      .catch(() => { /* silent background sync failure */ });
  } else {
    await upgradeKdf();
  }

  return { ok: true };
}

async function handleUnlockPin({ pin }) {
  const rawKeyB64 = await unlockWithPin(pin);
  const local = await chrome.storage.local.get("cache_file");
  if (!local.cache_file) throw new Error("Vault not found.");
  cachedFileObj = local.cache_file;
  sessionKey = await importRawKey(rawKeyB64);
  vaultData = await decryptJSON(sessionKey, cachedFileObj.iv, cachedFileObj.ciphertext);
  await chrome.storage.session.set({ sess_rawKey: rawKeyB64 });
  await scheduleAutoLock();

  // Auto-sync with Drive if connected
  const cfg2 = await getConfig();
  if (cfg2.driveConnected) {
    handleSync().catch(() => { /* silent background sync failure */ });
  }

  return { ok: true };
}

async function handleSetupPin({ pin }) {
  if (!(await hydrate())) throw new Error("Vault is locked.");
  if (!pin || pin.length < 6) throw new Error("PIN must be at least 6 digits.");
  const rawKeyB64 = await exportRawKey(sessionKey);
  await setupPin(pin, rawKeyB64);
  return { ok: true };
}

async function handleRemovePin() {
  await removePin();
  return { ok: true };
}

async function handleGetEntries() {
  if (!(await hydrate())) throw new Error("Vault is locked.");
  touchActivity();
  return { entries: liveEntries(vaultData) };
}

async function handleGetTrash() {
  if (!(await hydrate())) throw new Error("Vault is locked.");
  touchActivity();
  return { entries: trashEntries(vaultData) };
}

async function handleRestoreEntry({ id }) {
  if (!(await hydrate())) throw new Error("Vault is locked.");
  touchActivity();
  restoreEntry(vaultData, id);
  const sync = await persistVault();
  return { ok: true, sync };
}

async function handlePurgeEntry({ id }) {
  if (!(await hydrate())) throw new Error("Vault is locked.");
  touchActivity();
  purgeEntry(vaultData, id);
  const sync = await persistVault();
  return { ok: true, sync };
}

async function handlePurgeAllTrash() {
  if (!(await hydrate())) throw new Error("Vault is locked.");
  touchActivity();
  purgeAllTrash(vaultData);
  const sync = await persistVault();
  return { ok: true, sync };
}

async function handleToggleFavorite({ id }) {
  if (!(await hydrate())) throw new Error("Vault is locked.");
  touchActivity();
  toggleFavorite(vaultData, id);
  const sync = await persistVault();
  return { ok: true, sync };
}

async function handleScheduleClearClipboard() {
  // Remember which tab was in front when the copy happened. The alarm fires
  // 30s later, by which time the active tab may be a different one — clearing
  // there would reach into a page that was never involved.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.storage.session.set({ clipboard_tabId: tab?.id ?? null });
  chrome.alarms.create("drivepass-clear-clipboard", { delayInMinutes: 0.5 });
  return { ok: true };
}

async function handleImportEntries({ entries }) {
  if (!(await hydrate())) throw new Error("Vault is locked.");
  touchActivity();
  if (!Array.isArray(entries) || !entries.length) throw new Error("No entries to import.");
  const existing = liveEntries(vaultData);
  let imported = 0;
  for (const e of entries) {
    const isDuplicate = existing.some(
      (x) => x.url && e.url && x.url.toLowerCase() === e.url.toLowerCase() && x.username === e.username
    );
    if (!isDuplicate) {
      // Mint a fresh id rather than trusting one from the imported file: a
      // colliding id would give the vault two entries the same id, which the
      // merge and delete paths both key on.
      vaultData.entries.push(newEntry({ ...e, id: undefined }));
      imported++;
    }
  }
  const sync = await persistVault();
  return { ok: true, count: imported, skipped: entries.length - imported, sync };
}

async function handleSaveEntry({ entry }) {
  if (!(await hydrate())) throw new Error("Vault is locked.");
  touchActivity();
  const now = Date.now();
  if (entry.id) {
    const idx = vaultData.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      const existing = vaultData.entries[idx];
      const history = Array.isArray(existing.history) ? [...existing.history] : [];
      // Push previous password into history if it changed
      if (entry.password && existing.password && entry.password !== existing.password) {
        history.unshift({ password: existing.password, updatedAt: existing.updatedAt || now });
        if (history.length > 10) history.pop();
      }
      vaultData.entries[idx] = newEntry({
        ...existing,
        ...entry,
        history,
        updatedAt: now,
        deletedAt: null,
      });
    } else {
      vaultData.entries.push(newEntry(entry));
    }
  } else {
    vaultData.entries.push(newEntry(entry));
  }
  const sync = await persistVault();
  return { ok: true, sync };
}

async function handleDeleteEntry({ id }) {
  if (!(await hydrate())) throw new Error("Vault is locked.");
  touchActivity();
  const idx = vaultData.entries.findIndex((e) => e.id === id);
  if (idx >= 0) {
    vaultData.entries[idx].deletedAt = Date.now();
    vaultData.entries[idx].updatedAt = Date.now();
  }
  const sync = await persistVault();
  return { ok: true, sync };
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// The host a message actually came from. A content script can put anything in
// the message body, so for anything that gates access to a secret we trust the
// sender the browser reports, never the caller's own claim.
function senderHost(sender) {
  if (!sender) return "";
  if (sender.origin) return hostFromUrl(sender.origin);
  if (sender.tab?.url) return hostFromUrl(sender.tab.url);
  return "";
}

// Which entries apply to this page — WITHOUT their secrets. The content script
// runs on every site the user visits; handing it plaintext passwords on page
// load puts them in reach of any bug in it, for no benefit. It only needs
// enough to draw the dropdown, and asks for the secret when the user picks one.
async function handleGetMatches({ url }, sender) {
  if (!(await hydrate())) return { locked: true, matches: [] };
  const host = senderHost(sender) || hostFromUrl(url);
  const matches = matchEntriesForHost(vaultData, host).map((e) => ({
    id: e.id,
    name: e.name,
    username: e.username,
    hasTotp: !!(e.totp || "").trim(),
  }));
  return { locked: false, matches };
}

// Release one credential, for one entry, to a page that is actually entitled
// to it. Re-runs the host match against the browser-reported sender so a
// compromised content script cannot ask for an arbitrary entry by id.
async function handleGetCredential({ id }, sender) {
  if (!(await hydrate())) return { ok: false, locked: true };
  const host = senderHost(sender);
  if (!host) throw new Error("Could not determine the requesting page.");
  const entry = matchEntriesForHost(vaultData, host).find((e) => e.id === id);
  if (!entry) throw new Error("No credential for this site.");
  touchActivity();
  return {
    ok: true,
    credential: { username: entry.username, password: entry.password, totp: entry.totp },
  };
}

// host -> number of matching entries. onUpdated fires twice per navigation and
// again on every tab switch, and each miss walks the whole entry list parsing
// URLs. Cleared whenever the vault changes, so a stale count can't linger.
const badgeCountCache = new Map();

function invalidateBadgeCache() {
  badgeCountCache.clear();
}

async function updateBadge(tabId, url) {
  if (!url || !(await hydrate())) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }
  const host = hostFromUrl(url);
  if (!host) return;
  let count = badgeCountCache.get(host);
  if (count === undefined) {
    count = matchEntriesForHost(vaultData, host).length;
    badgeCountCache.set(host, count);
  }
  chrome.action.setBadgeText({ text: count ? String(count) : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1', tabId });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateBadge(tabId, tab.url);
  } catch { /* tab doesn't exist */ }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    updateBadge(tabId, tab.url);
  }
});

// Called when the user accepts the content script's "save this login?" prompt.
// The credential is read from the stash the submit handler wrote, not from the
// message, so the page's password never has to travel back through the banner.
async function handleSaveFromPage() {
  if (!(await hydrate())) return { ok: false, locked: true };
  const { pending_save } = await chrome.storage.session.get("pending_save");
  if (!pending_save?.password) return { ok: false, error: "Nothing to save." };
  const { url, username, password } = pending_save;
  const host = hostFromUrl(url);

  const existing = matchEntriesForHost(vaultData, host).find((e) => e.username === username);
  if (existing) {
    if (existing.password !== password) {
      const history = Array.isArray(existing.history) ? [...existing.history] : [];
      history.unshift({ password: existing.password, updatedAt: existing.updatedAt || Date.now() });
      existing.password = password;
      existing.history = history.slice(0, 10);
      existing.updatedAt = Date.now();
      const sync = await persistVault();
      return { ok: true, updated: true, sync };
    }
    return { ok: true, updated: false };
  }
  vaultData.entries.push(
    newEntry({ name: host.replace(/^www\./, ""), url: host, username, password })
  );
  const sync = await persistVault();
  return { ok: true, created: true, sync };
}

async function handleConnectDrive() {
  await getToken(true); // interactive consent
  const email = await getUserEmail();
  await saveConfig({ driveConnected: true, email });

  // Reconcile local vs remote vault.
  const found = await findVaultFile(FILE_NAME);
  if (found) {
    const fileObj = await downloadVaultFile(found.id);
    await chrome.storage.local.set({
      cache_file: fileObj,
      cache_fileId: found.id,
      cache_modifiedTime: found.modifiedTime,
    });
    await lock(); // adopt remote — require unlock with its master password
    return { email, adopted: "remote" };
  }
  const local = await chrome.storage.local.get("cache_file");
  if (local.cache_file) {
    const result = await driveCreateFile(FILE_NAME, local.cache_file, false);
    await chrome.storage.local.set({ cache_fileId: result.id, cache_modifiedTime: result.modifiedTime });
    return { email, adopted: "local" };
  }
  return { email, adopted: "none" };
}

async function handleDisconnectDrive() {
  await driveSignOut();
  await saveConfig({ driveConnected: false, email: null });
  await chrome.storage.local.remove(["cache_fileId", "cache_modifiedTime"]);
  return { ok: true };
}

async function handleSync() {
  const cfg = await getConfig();
  if (!cfg.driveConnected) return { ok: false, error: "Google Drive is not connected." };
  if (!(await hydrate())) throw new Error("Unlock the vault before syncing.");
  const found = await findVaultFile(FILE_NAME);
  if (found) {
    const remoteFile = await downloadVaultFile(found.id);
    let remoteData;
    try {
      remoteData = await decryptJSON(sessionKey, remoteFile.iv, remoteFile.ciphertext);
    } catch {
      return { ok: false, error: "Remote vault uses a different master password." };
    }
    vaultData = mergeVaults(vaultData, remoteData);
    // Record what we just reconciled against so the push below doesn't
    // re-download and re-merge the same revision.
    await chrome.storage.local.set({
      cache_fileId: found.id,
      cache_modifiedTime: found.modifiedTime,
    });
  }
  const sync = await persistVault();
  return { ok: true, sync, count: liveEntries(vaultData).length };
}

async function handleStashPending({ url, username, password }) {
  await chrome.storage.session.set({ pending_save: { url, username, password } });
  return { ok: true };
}
async function handleGetPending() {
  const { pending_save } = await chrome.storage.session.get("pending_save");
  if (!pending_save) return { pending: null };

  // Suppress the "save this login?" banner when we already hold exactly this
  // credential. This comparison used to happen in the content script, which
  // meant shipping it the stored password to compare against.
  if (await hydrate()) {
    const host = hostFromUrl(pending_save.url);
    const known = matchEntriesForHost(vaultData, host).some(
      (e) => e.username === pending_save.username && e.password === pending_save.password
    );
    if (known) {
      await chrome.storage.session.remove("pending_save");
      return { pending: null };
    }
  }
  // Never hand the password back to the page — it came from there, and the
  // banner only needs to name the account.
  return { pending: { url: pending_save.url, username: pending_save.username } };
}
async function handleClearPending() {
  await chrome.storage.session.remove("pending_save");
  return { ok: true };
}

async function handleSetAutoLock({ minutes }) {
  await saveConfig({ autoLockMinutes: minutes });
  await scheduleAutoLock();
  return { ok: true };
}

async function handleChangeMasterPassword({ current, next }) {
  if (!(await hydrate())) throw new Error("Unlock the vault first.");
  await openVaultFile(cachedFileObj, current);
  const data = vaultData;
  const { file, key } = await buildVaultFile(next);
  sessionKey = key;
  cachedFileObj = file;
  vaultData = data;
  await chrome.storage.session.set({ sess_rawKey: await exportRawKey(key) });

  // The PIN wraps the OLD master key, which no longer opens this vault. We
  // cannot re-wrap it (that needs the PIN itself, which we never store), so
  // drop it and tell the caller to prompt for a new one. Leaving it in place
  // would make a correct PIN fail with a raw WebCrypto error at unlock.
  const { pin_config } = await chrome.storage.local.get("pin_config");
  const pinCleared = !!pin_config;
  if (pinCleared) await removePin();

  const sync = await persistVault();
  return { ok: true, sync, pinCleared };
}

// ---- message routing -------------------------------------------------------
const ROUTES = {
  STATUS: handleStatus,
  CREATE_VAULT: handleCreateVault,
  UNLOCK: handleUnlock,
  UNLOCK_PIN: handleUnlockPin,
  SETUP_PIN: handleSetupPin,
  REMOVE_PIN: handleRemovePin,
  LOCK: async () => (await lock(), { ok: true }),
  GET_ENTRIES: handleGetEntries,
  GET_TRASH: handleGetTrash,
  RESTORE_ENTRY: handleRestoreEntry,
  PURGE_ENTRY: handlePurgeEntry,
  PURGE_ALL_TRASH: handlePurgeAllTrash,
  TOGGLE_FAVORITE: handleToggleFavorite,
  IMPORT_ENTRIES: handleImportEntries,
  SAVE_ENTRY: handleSaveEntry,
  DELETE_ENTRY: handleDeleteEntry,
  GET_MATCHES: handleGetMatches,
  GET_CREDENTIAL: handleGetCredential,
  SAVE_FROM_PAGE: handleSaveFromPage,
  STASH_PENDING: handleStashPending,
  GET_PENDING: handleGetPending,
  CLEAR_PENDING: handleClearPending,
  CONNECT_DRIVE: handleConnectDrive,
  DISCONNECT_DRIVE: handleDisconnectDrive,
  SYNC: handleSync,
  SET_AUTOLOCK: handleSetAutoLock,
  CHANGE_MASTER: handleChangeMasterPassword,
  SCHEDULE_CLEAR_CLIPBOARD: handleScheduleClearClipboard,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = ROUTES[msg?.type];
  if (!handler) {
    sendResponse({ ok: false, error: "Unknown message type: " + msg?.type });
    return false;
  }
  handler(msg, sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) lock();
  else if (alarm.name === "drivepass-clear-clipboard") {
    const { clipboard_tabId } = await chrome.storage.session.get("clipboard_tabId");
    await chrome.storage.session.remove("clipboard_tabId");
    if (clipboard_tabId == null) return;
    // The tab may be closed, navigated, or have no content script (chrome://).
    chrome.tabs
      .sendMessage(clipboard_tabId, { type: "CLEAR_CLIPBOARD" })
      .catch(() => { /* nothing to clear through */ });
  }
});

// Lock immediately when the OS screen locks — a strong, deliberate signal.
// Plain inactivity is handled by the configurable auto-lock alarm instead, so
// we do NOT lock on "idle" (that fires after ~60s and would override the user's
// chosen timeout).
if (chrome.idle?.onStateChanged) {
  chrome.idle.onStateChanged.addListener((state) => {
    if (state === "locked") lock();
  });
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "fill-login") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;
    if (!(await hydrate())) return;
    // The keystroke is an explicit request to fill this tab, so we push the
    // credential to it directly rather than letting the page ask for one.
    const [entry] = matchEntriesForHost(vaultData, hostFromUrl(tab.url));
    if (!entry) return;
    touchActivity();
    chrome.tabs.sendMessage(tab.id, {
      type: "FILL_CREDENTIALS",
      match: { username: entry.username, password: entry.password },
    }).catch(() => { /* no content script on this page */ });
  }
});
