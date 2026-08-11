// totp.js — RFC 6238 TOTP generator (HMAC-SHA1 via WebCrypto).
//
// Supports raw Base32 secret keys (e.g. "JBSWY3DPEHPK3PXP") and
// otpauth:// URIs (e.g. "otpauth://totp/Google:user@gmail.com?secret=JBSWY3DPEHPK3PXP&issuer=Google").

// Parse an otpauth:// URI into { issuer, account, secret, period, digits }.
// Returns null if it isn't a usable otpauth TOTP URI.
// Example: otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DP&issuer=GitHub
export function parseOtpauthURI(uri) {
  try {
    const url = new URL((uri || "").trim());
    if (url.protocol !== "otpauth:") return null;
    const secret = url.searchParams.get("secret");
    if (!secret) return null;
    let issuer = url.searchParams.get("issuer") || "";
    // For otpauth://totp/Label the label lands in the pathname.
    let label = decodeURIComponent((url.pathname || "").replace(/^\/+/, ""));
    let account = label;
    if (label.includes(":")) {
      const [iss, acct] = label.split(":");
      if (!issuer) issuer = iss.trim();
      account = acct.trim();
    }
    return {
      issuer: issuer.trim(),
      account: account.trim(),
      secret: secret.replace(/\s+/g, "").trim(),
      period: parseInt(url.searchParams.get("period") || "30", 10) || 30,
      digits: parseInt(url.searchParams.get("digits") || "6", 10) || 6,
    };
  } catch {
    return null;
  }
}

export function parseTotpSecret(secretOrUri) {
  if (!secretOrUri) return "";
  const s = secretOrUri.trim();
  if (s.toLowerCase().startsWith("otpauth://")) {
    try {
      const url = new URL(s);
      return url.searchParams.get("secret") || "";
    } catch {
      return "";
    }
  }
  return s.replace(/\s+/g, "").toUpperCase();
}

function base32ToBytes(b32) {
  const clean = b32.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (let i = 0; i < clean.length; i++) {
    const val = alphabet.indexOf(clean[i]);
    if (val >= 0) bits += val.toString(2).padStart(5, "0");
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.substr(i * 8, 8), 2);
  }
  return bytes;
}

export async function generateTOTP(secretOrUri, timestamp = Date.now(), period = 30, digits = 6) {
  const rawSecret = parseTotpSecret(secretOrUri);
  if (!rawSecret) return null;
  
  let secretBytes;
  try {
    secretBytes = base32ToBytes(rawSecret);
  } catch {
    return null;
  }
  if (secretBytes.length === 0) return null;

  const epoch = Math.floor(timestamp / 1000);
  const counter = Math.floor(epoch / period);

  // 8-byte big-endian counter
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, 0, false);
  view.setUint32(4, counter, false);

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: { name: "SHA-1" } },
      false,
      ["sign"]
    );
    const hmac = await crypto.subtle.sign("HMAC", key, buffer);
    const hmacResult = new Uint8Array(hmac);

    const offset = hmacResult[hmacResult.length - 1] & 0x0f;
    const binary =
      ((hmacResult[offset] & 0x7f) << 24) |
      ((hmacResult[offset + 1] & 0xff) << 16) |
      ((hmacResult[offset + 2] & 0xff) << 8) |
      (hmacResult[offset + 3] & 0xff);

    const otp = binary % Math.pow(10, digits);
    return otp.toString().padStart(digits, "0");
  } catch {
    return null;
  }
}

export function getTotpTimeRemaining(period = 30, timestamp = Date.now()) {
  const epoch = Math.floor(timestamp / 1000);
  return period - (epoch % period);
}
