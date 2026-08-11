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
// Seal the current vault, cache it locally, and push to Drive if connected.
async function persistVault() {
  cachedFileObj = await sealVault(sessionKey, vaultData, cachedFileObj);
  await chrome.storage.local.set({ cache_file: cachedFileObj });

  const cfg = await getConfig();
  if (!cfg.driveConnected) return { synced: false };

  async function pushToDrive() {
    let { cache_fileId } = await chrome.storage.local.get("cache_fileId");
    if (!cache_fileId) {
      const found = await findVaultFile(FILE_NAME);
      cache_fileId = found?.id;
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

  const { key, data } = await openVaultFile(fileObj, password); // throws on wrong password
  sessionKey = key;
  vaultData = data;
  cachedFileObj = fileObj;
  await chrome.storage.session.set({ sess_rawKey: await exportRawKey(key) });
  await chrome.storage.local.set({ cache_file: fileObj });
  await scheduleAutoLock();

  // Auto-sync with Drive if connected
  const cfg2 = await getConfig();
  if (cfg2.driveConnected) {
    handleSync().catch(() => { /* silent background sync failure */ });
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
      vaultData.entries.push(newEntry(e));
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

async function handleGetMatches({ url }) {
  if (!(await hydrate())) return { locked: true, matches: [] };
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  const matches = matchEntriesForHost(vaultData, host).map((e) => ({
    id: e.id,
    name: e.name,
    username: e.username,
    password: e.password,
    totp: e.totp,
  }));
  return { locked: false, matches };
}

async function updateBadge(tabId, url) {
  if (!url || !(await hydrate())) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }
  let host = '';
  try { host = new URL(url).hostname; } catch { return; }
  const count = matchEntriesForHost(vaultData, host).length;
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

// Called by the content script's "save this login?" prompt.
async function handleSaveFromPage({ url, username, password }) {
  if (!(await hydrate())) return { ok: false, locked: true };
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  const existing = matchEntriesForHost(vaultData, host).find((e) => e.username === username);
  if (existing) {
    if (existing.password !== password) {
      const history = Array.isArray(existing.history) ? [...existing.history] : [];
      history.unshift({ password: existing.password, updatedAt: existing.updatedAt || Date.now() });
      existing.password = password;
      existing.history = history.slice(0, 10);
      existing.updatedAt = Date.now();
      await persistVault();
      return { ok: true, updated: true };
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
  return { pending: pending_save || null };
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
  const sync = await persistVault();
  return { ok: true, sync };
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = ROUTES[msg?.type];
  if (!handler) {
    sendResponse({ ok: false, error: "Unknown message type: " + msg?.type });
    return false;
  }
  handler(msg)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) lock();
  else if (alarm.name === "drivepass-clear-clipboard") {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "CLEAR_CLIPBOARD" }).catch(() => {});
    }
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
    const res = await handleGetMatches({ url: tab.url });
    if (res.matches && res.matches.length > 0) {
      chrome.tabs.sendMessage(tab.id, { type: "FILL_CREDENTIALS", match: res.matches[0] });
    }
  }
});
