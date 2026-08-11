// crypto.js — all client-side encryption for DrivePass.
//
// Design:
//   master password --PBKDF2(SHA-256, 210k)--> AES-256-GCM key
//   vault JSON       --AES-256-GCM(key, random IV)--> ciphertext
//
// The master password and the derived key never leave the device and are
// never written to Google Drive. Drive only ever stores the ciphertext plus
// the public KDF parameters (salt + iteration count) needed to re-derive the
// key on unlock.

export const KDF_ITERATIONS = 210000;
// PIN unlock wraps the master key on disk, protected only by a short numeric
// PIN (low entropy). To make offline brute-forcing of a stolen profile costly,
// the PIN wrap uses a HIGH iteration count so every guess pays a real price.
export const PIN_KDF_ITERATIONS = 600000;
export const MIN_PIN_LENGTH = 6;
const KEY_LENGTH = 256;

// ---- base64 <-> bytes helpers -------------------------------------------
export function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- key derivation ------------------------------------------------------
export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

// Derives an AES-GCM CryptoKey from the master password.
// `extractable` is true so the raw key can be cached in chrome.storage.session
// (in-memory only) to survive service-worker restarts without re-prompting.
export async function deriveKey(password, salt, iterations = KDF_ITERATIONS, extractable = true) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: KEY_LENGTH },
    extractable,
    ["encrypt", "decrypt"]
  );
}

// Re-import a raw key (base64) cached in session storage back into a CryptoKey.
export async function importRawKey(rawB64, extractable = true) {
  return crypto.subtle.importKey(
    "raw",
    b64ToBytes(rawB64),
    { name: "AES-GCM", length: KEY_LENGTH },
    extractable,
    ["encrypt", "decrypt"]
  );
}

export async function exportRawKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bytesToB64(raw);
}

// ---- encrypt / decrypt ---------------------------------------------------
export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(JSON.stringify(obj))
  );
  return { iv: bytesToB64(iv), ciphertext: bytesToB64(ct) };
}

export async function decryptJSON(key, ivB64, ctB64) {
  const iv = b64ToBytes(ivB64);
  const ct = b64ToBytes(ctB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---- password generator (used by the UI) --------------------------------

// Uniform integer in [0, max). Rejection sampling rather than `% max`: modulo
// folds the 2^32 output range onto `max` values unevenly, making the first few
// characters of every alphabet very slightly likelier than the rest. The bias
// is small but it costs nothing to not have it.
export function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  let v;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return v % max;
}

// Character classes deliberately omit visually ambiguous glyphs (l/I/1, O/0)
// so a generated password can be read off a screen and retyped correctly.
const CHAR_SETS = {
  lower: "abcdefghijkmnpqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%^&*()-_=+[]{}",
};

// Which character sets a given options object selects. Shared with the UI so
// the strength meter is computed from the alphabet actually used — hardcoding
// 26/26/10/20 there overstates it, since the ambiguous glyphs are excluded.
// `opts` accepts either short (lower/upper/digits) or long
// (lowercase/uppercase/numbers) key names — the UI grew the long ones.
export function activeCharSets(opts = {}) {
  const want = (short, long, defaultOn) => {
    const v = opts[short] !== undefined ? opts[short] : opts[long];
    return v === undefined ? defaultOn : !!v;
  };

  const active = [];
  if (want("lower", "lowercase", true)) active.push(CHAR_SETS.lower);
  if (want("upper", "uppercase", true)) active.push(CHAR_SETS.upper);
  if (want("digits", "numbers", true)) active.push(CHAR_SETS.digits);
  if (want("symbols", "symbols", false)) active.push(CHAR_SETS.symbols);
  if (!active.length) {
    active.push(CHAR_SETS.lower, CHAR_SETS.upper, CHAR_SETS.digits);
  }
  return active;
}

// Entropy of a password this generator would produce with these settings.
export function passwordEntropyBits(length, opts = {}) {
  const poolSize = activeCharSets(opts).join("").length;
  return length * Math.log2(poolSize);
}

export function generatePassword(length = 20, opts = {}) {
  const active = activeCharSets(opts);
  const pool = active.join("");
  const draw = () => pool[randomInt(pool.length)];

  // Too short to fit one of each class — just draw from the whole pool.
  if (length < active.length) {
    return Array.from({ length }, draw).join("");
  }

  // Guarantee at least one character from every selected class, otherwise a
  // "with symbols" password can come out with no symbol in it and get rejected
  // by the site's own complexity rules.
  const chars = active.map((set) => set[randomInt(set.length)]);
  while (chars.length < length) chars.push(draw());

  // Fisher-Yates, so the guaranteed characters aren't always in front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// ---- PIN quick unlock ---------------------------------------------------
// SECURITY TRADEOFF: enabling a PIN stores the master key on disk, wrapped by a
// key derived from the (low-entropy) PIN. Anyone who copies the local profile
// can attempt an OFFLINE brute force — the in-app 5-attempt lockout does NOT
// stop that. We mitigate with a long PIN minimum and a high wrap-KDF cost, but
// a PIN is inherently weaker than the master password. It is convenience, not
// equivalent security.
export async function setupPin(pin, rawMasterKeyB64) {
  if (!pin || pin.length < MIN_PIN_LENGTH) {
    throw new Error(`PIN must be at least ${MIN_PIN_LENGTH} digits.`);
  }
  const pinSalt = randomSalt();
  const pinKey = await deriveKey(pin, pinSalt, PIN_KDF_ITERATIONS);
  const wrapped = await encryptJSON(pinKey, { rawMasterKey: rawMasterKeyB64 });
  await chrome.storage.local.set({
    pin_config: {
      salt: bytesToB64(pinSalt),
      iterations: PIN_KDF_ITERATIONS,
      wrappedIv: wrapped.iv,
      wrappedCt: wrapped.ciphertext,
      failedAttempts: 0,
    },
  });
}

export async function unlockWithPin(pin) {
  const { pin_config } = await chrome.storage.local.get("pin_config");
  if (!pin_config) throw new Error("PIN unlock is not configured.");
  if (pin_config.failedAttempts >= 5) {
    await removePin();
    throw new Error("Too many failed PIN attempts. PIN disabled for security.");
  }
  const pinSalt = b64ToBytes(pin_config.salt);
  const pinKey = await deriveKey(pin, pinSalt, pin_config.iterations || PIN_KDF_ITERATIONS);
  let decrypted;
  try {
    decrypted = await decryptJSON(pinKey, pin_config.wrappedIv, pin_config.wrappedCt);
  } catch {
    pin_config.failedAttempts = (pin_config.failedAttempts || 0) + 1;
    await chrome.storage.local.set({ pin_config });
    const remaining = 5 - pin_config.failedAttempts;
    throw new Error(`Incorrect PIN. ${remaining} attempts remaining.`);
  }
  // Reset failed attempts on success
  pin_config.failedAttempts = 0;
  await chrome.storage.local.set({ pin_config });
  return decrypted.rawMasterKey;
}

export async function removePin() {
  await chrome.storage.local.remove("pin_config");
}

