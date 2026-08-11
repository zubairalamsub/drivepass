// vault.js — vault data model + on-disk (Drive) file format.
//
// The Drive file (vault.enc) is JSON with cleartext KDF params and an
// encrypted payload:
//
//   {
//     "format": "drivepass-v1",
//     "kdf": "PBKDF2-SHA256",
//     "iterations": 210000,
//     "salt": "<base64>",
//     "iv": "<base64>",
//     "ciphertext": "<base64>"   // encrypts { entries: [...] }
//   }

import {
  KDF_ITERATIONS,
  randomSalt,
  deriveKey,
  encryptJSON,
  decryptJSON,
  bytesToB64,
  b64ToBytes,
} from "./crypto.js";

export const FILE_NAME = "vault.enc";
export const FORMAT = "drivepass-v1";

export function newEntry(data = {}) {
  const now = Date.now();
  return {
    id: data.id || crypto.randomUUID(),
    type: data.type || "login", // "login" | "card" | "note" | "passkey"
    name: data.name || "",
    url: data.url || "",
    username: data.username || "",
    password: data.password || "",
    totp: data.totp || "",
    notes: data.notes || "",
    card: data.card || { number: "", expMonth: "", expYear: "", cvv: "", holder: "" },
    passkey: data.passkey || { rpId: "", credentialId: "", userName: "" },
    history: Array.isArray(data.history) ? data.history : [],
    favorite: !!data.favorite,
    tags: Array.isArray(data.tags) ? data.tags : [],
    createdAt: data.createdAt || now,
    updatedAt: now,
    deletedAt: data.deletedAt || null, // tombstone for sync
  };
}

export function toggleFavorite(data, id) {
  const entry = data.entries.find((e) => e.id === id);
  if (entry) {
    entry.favorite = !entry.favorite;
    entry.updatedAt = Date.now();
  }
}

// Build a fresh, empty encrypted vault file from a master password.
export async function createVaultFile(masterPassword) {
  const salt = randomSalt();
  const key = await deriveKey(masterPassword, salt, KDF_ITERATIONS);
  const { iv, ciphertext } = await encryptJSON(key, { entries: [] });
  const file = {
    format: FORMAT,
    kdf: "PBKDF2-SHA256",
    iterations: KDF_ITERATIONS,
    salt: bytesToB64(salt),
    iv,
    ciphertext,
  };
  return { file, key };
}

// Decrypt a vault file with the master password. Returns { key, data }.
// Throws if the password is wrong (AES-GCM auth tag fails).
export async function openVaultFile(fileObj, masterPassword) {
  if (!fileObj || fileObj.format !== FORMAT) {
    throw new Error("Unrecognized vault file format.");
  }
  const salt = b64ToBytes(fileObj.salt);
  const key = await deriveKey(masterPassword, salt, fileObj.iterations || KDF_ITERATIONS);
  let data;
  try {
    data = await decryptJSON(key, fileObj.iv, fileObj.ciphertext);
  } catch (e) {
    throw new Error("Wrong master password or corrupted vault.");
  }
  if (!data || !Array.isArray(data.entries)) data = { entries: [] };
  return { key, data };
}

// Re-encrypt vault data with an already-derived key, preserving KDF params.
export async function sealVault(key, data, prevFileObj) {
  const { iv, ciphertext } = await encryptJSON(key, data);
  return {
    format: FORMAT,
    kdf: "PBKDF2-SHA256",
    iterations: prevFileObj?.iterations || KDF_ITERATIONS,
    salt: prevFileObj?.salt || bytesToB64(randomSalt()),
    iv,
    ciphertext,
  };
}

// Merge two decrypted vaults by entry id, last-write-wins on updatedAt.
// Used when the Drive copy changed while we held a local copy.
export function mergeVaults(local, remote) {
  const purged = new Set([...(local.purged || []), ...(remote.purged || [])]);
  const byId = new Map();
  for (const e of remote.entries) byId.set(e.id, e);
  for (const e of local.entries) {
    const existing = byId.get(e.id);
    if (!existing || (e.updatedAt || 0) >= (existing.updatedAt || 0)) {
      byId.set(e.id, e);
    }
  }
  // Drop anything purged on either side so it can't come back through merge.
  for (const id of purged) byId.delete(id);
  return { entries: [...byId.values()], purged: [...purged] };
}

// Live (non-deleted) entries, sorted by name.
export function liveEntries(data) {
  return data.entries
    .filter((e) => !e.deletedAt)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

// Soft-deleted entries in the Trash bin, sorted by deletion date descending.
export function trashEntries(data) {
  return data.entries
    .filter((e) => !!e.deletedAt)
    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

export function restoreEntry(data, id) {
  const entry = data.entries.find((e) => e.id === id);
  if (entry) {
    entry.deletedAt = null;
    entry.updatedAt = Date.now();
  }
}

// Hard-delete records the id in a `purged` tombstone list so the deletion
// propagates through sync and the entry cannot be resurrected from another
// device's copy. (The list grows slowly; acceptable for a personal vault.)
export function purgeEntry(data, id) {
  if (!Array.isArray(data.purged)) data.purged = [];
  if (!data.purged.includes(id)) data.purged.push(id);
  data.entries = data.entries.filter((e) => e.id !== id);
}

export function purgeAllTrash(data) {
  if (!Array.isArray(data.purged)) data.purged = [];
  for (const e of data.entries) {
    if (e.deletedAt && !data.purged.includes(e.id)) data.purged.push(e.id);
  }
  data.entries = data.entries.filter((e) => !e.deletedAt);
}

// Return entries whose URL host matches the given hostname (for autofill).
export function matchEntriesForHost(data, hostname) {
  if (!hostname) return [];
  const target = hostname.replace(/^www\./, "").toLowerCase();
  return liveEntries(data).filter((e) => {
    if (!e.url) return false;
    let host;
    try {
      host = new URL(e.url.includes("://") ? e.url : "https://" + e.url).hostname;
    } catch {
      host = e.url;
    }
    host = host.replace(/^www\./, "").toLowerCase();
    return host === target || target.endsWith("." + host) || host.endsWith("." + target);
  });
}
