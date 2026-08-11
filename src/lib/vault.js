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

// The KDF cost lives in cleartext in the file, outside the AEAD, so a tampered
// or corrupt file can name any number. Below the floor the derived key would be
// cheap to attack; above the ceiling the derivation would hang the browser.
export const MIN_ACCEPTED_ITERATIONS = 100000;
export const MAX_ACCEPTED_ITERATIONS = 10000000;

// Decrypt a vault file with the master password.
// Returns { key, data, needsKdfUpgrade }. Throws if the password is wrong
// (AES-GCM auth tag fails).
export async function openVaultFile(fileObj, masterPassword) {
  if (!fileObj || fileObj.format !== FORMAT) {
    throw new Error("Unrecognized vault file format.");
  }
  const iterations = Number(fileObj.iterations) || KDF_ITERATIONS;
  if (
    !Number.isInteger(iterations) ||
    iterations < MIN_ACCEPTED_ITERATIONS ||
    iterations > MAX_ACCEPTED_ITERATIONS
  ) {
    throw new Error("This vault file declares an unsafe KDF cost. Refusing to open it.");
  }
  const salt = b64ToBytes(fileObj.salt);
  const key = await deriveKey(masterPassword, salt, iterations);
  let data;
  try {
    data = await decryptJSON(key, fileObj.iv, fileObj.ciphertext);
  } catch (e) {
    throw new Error("Wrong master password or corrupted vault.");
  }
  if (!data || !Array.isArray(data.entries)) data = { entries: [] };
  return { key, data, needsKdfUpgrade: iterations < KDF_ITERATIONS };
}

// Re-derive the key at the CURRENT cost with a fresh salt, keeping the
// contents. Raising KDF_ITERATIONS in a release does nothing for vaults that
// already exist — sealVault has to keep their params, since the in-memory key
// was derived from them. Migrating requires the master password, so it happens
// at unlock, which is the one moment we have it.
export async function rekeyVault(masterPassword, data) {
  const salt = randomSalt();
  const key = await deriveKey(masterPassword, salt, KDF_ITERATIONS);
  const { iv, ciphertext } = await encryptJSON(key, data);
  return {
    key,
    file: {
      format: FORMAT,
      kdf: "PBKDF2-SHA256",
      iterations: KDF_ITERATIONS,
      salt: bytesToB64(salt),
      iv,
      ciphertext,
    },
  };
}

// Re-encrypt vault data with an already-derived key. KDF params MUST carry over
// unchanged — `key` was derived from this salt and cost, so rewriting them here
// would produce a file nothing can open. Use rekeyVault to change them.
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

// ---- host matching for autofill -------------------------------------------
//
// Deciding which entries an origin may see is a security boundary, not a
// convenience: offer a credential too broadly and the vault hands a password
// to a site that did not earn it. Two rules follow from that:
//
//   1. Matching is one-directional. An entry saved for the site itself fills
//      on its subdomains (example.com -> login.example.com), never the reverse
//      (mail.example.com must not fill on example.com, which may be a
//      different application entirely).
//   2. Sharing a public suffix is not sharing a site. a.github.io and
//      b.github.io are run by different people; neither may see the other's
//      credentials.

// A compact public-suffix list. The real PSL is ~10k entries and too heavy to
// embed, so this covers the two cases that actually matter here: hosts that
// serve arbitrary user content under a shared parent, and the common
// country-code second-level domains.
const MULTI_LABEL_SUFFIXES = new Set([
  // user-content / PaaS hosts
  "github.io", "githubusercontent.com", "gitlab.io", "codeberg.page",
  "netlify.app", "vercel.app", "pages.dev", "workers.dev", "onrender.com",
  "herokuapp.com", "appspot.com", "firebaseapp.com", "web.app", "run.app",
  "cloudfunctions.net", "azurewebsites.net", "cloudfront.net",
  "s3.amazonaws.com", "amplifyapp.com", "ondigitalocean.app", "fly.dev",
  "glitch.me", "repl.co", "replit.app", "surge.sh", "pythonanywhere.com",
  "readthedocs.io", "js.org", "neocities.org", "blogspot.com",
  "wordpress.com", "tumblr.com", "myshopify.com", "wixsite.com",
  "squarespace.com", "weebly.com", "ngrok.io", "ngrok-free.app",
  // country-code second-level domains
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "net.nz", "org.nz", "co.za", "co.ke", "com.ng", "com.gh", "com.eg",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "co.kr", "com.tw", "com.hk", "com.cn",
  "net.cn", "org.cn", "gov.cn", "com.sg", "com.my", "co.id", "com.ph",
  "com.vn", "co.th", "co.in", "net.in", "org.in", "com.pk", "com.bd",
  "com.br", "net.br", "org.br", "gov.br", "com.mx", "com.ar", "com.co",
  "com.pe", "com.ve", "com.ec", "com.uy", "com.tr", "com.ua", "com.pl",
  "co.il", "com.sa",
]);

function normalizeHost(h) {
  return String(h || "").replace(/^www\./i, "").toLowerCase();
}

// The registrable domain ("eTLD+1") — the shortest suffix of `host` that a
// single owner could have registered. login.example.co.uk -> example.co.uk
function registrableDomain(host) {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  if (MULTI_LABEL_SUFFIXES.has(parts.slice(-3).join("."))) return parts.slice(-4).join(".");
  if (MULTI_LABEL_SUFFIXES.has(parts.slice(-2).join("."))) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

// Hostname an entry is scoped to, or null if its URL can't be understood.
function entryHost(entry) {
  if (!entry.url) return null;
  try {
    const raw = entry.url.includes("://") ? entry.url : "https://" + entry.url;
    return normalizeHost(new URL(raw).hostname) || null;
  } catch {
    return null;
  }
}

// Return entries whose URL host matches the given hostname (for autofill).
export function matchEntriesForHost(data, hostname) {
  if (!hostname) return [];
  const target = normalizeHost(hostname);
  if (!target) return [];
  const targetSite = registrableDomain(target);

  return liveEntries(data).filter((e) => {
    const host = entryHost(e);
    if (!host) return false;
    if (host === target) return true;
    return host === targetSite && target.endsWith("." + host);
  });
}
