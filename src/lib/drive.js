// drive.js — Google Drive REST wrapper (drive.file scope).
//
// With the drive.file scope the extension can only see files it created or
// opened, so the vault.enc file it creates is the only thing it can touch —
// it cannot read the rest of the user's Drive. The file grant follows the
// Google account, so the same file is found again on other devices.

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

// Get an OAuth token via chrome.identity. `interactive` shows the consent
// screen when true; use false for silent refreshes.
// On Chrome, uses native getAuthToken. On Edge / non-Chrome browsers, falls back
// to launchWebAuthFlow.
export function getToken(interactive = false) {
  return new Promise((resolve, reject) => {
    if (typeof chrome?.identity?.getAuthToken !== "function") {
      return getAuthTokenViaWebAuthFlow(interactive).then(resolve).catch(reject);
    }
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      const errMsg = err?.message || "";
      if (err || !token) {
        if (errMsg.includes("not supported") || errMsg.includes("Edge") || errMsg.includes("unsupported")) {
          getAuthTokenViaWebAuthFlow(interactive).then(resolve).catch(reject);
        } else {
          reject(new Error(errMsg || "Not signed in to Google."));
        }
      } else {
        resolve(token);
      }
    });
  });
}

async function getAuthTokenViaWebAuthFlow(interactive) {
  const { edge_token, edge_expires } = await chrome.storage.session.get(["edge_token", "edge_expires"]);
  if (edge_token && edge_expires && Date.now() < edge_expires) {
    return edge_token;
  }
  if (!interactive) {
    throw new Error("Google authentication required.");
  }

  const manifest = chrome.runtime.getManifest();
  const clientId = manifest.oauth2?.client_id;
  if (!clientId || clientId.startsWith("REPLACE_")) {
    throw new Error("OAuth Client ID not configured in manifest.json.");
  }

  const redirectUri = chrome.identity.getRedirectURL();
  console.log("[DrivePass] OAuth Redirect URI for Google Cloud Console:", redirectUri);
  const scope = encodeURIComponent("https://www.googleapis.com/auth/drive.file");
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectUrl) => {
      const err = chrome.runtime.lastError;
      if (err || !redirectUrl) {
        return reject(new Error(err?.message || "Google sign-in was cancelled or blocked."));
      }
      const match = redirectUrl.match(/access_token=([^&]+)/);
      const expiresInMatch = redirectUrl.match(/expires_in=([^&]+)/);
      if (match && match[1]) {
        const token = match[1];
        const expiresIn = expiresInMatch ? parseInt(expiresInMatch[1], 10) : 3600;
        const expiresAt = Date.now() + (expiresIn - 60) * 1000;
        await chrome.storage.session.set({ edge_token: token, edge_expires: expiresAt });
        resolve(token);
      } else {
        reject(new Error("Failed to extract OAuth access token from response."));
      }
    });
  });
}

export function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.storage.session.remove(["edge_token", "edge_expires"]);
    if (!token || typeof chrome?.identity?.removeCachedAuthToken !== "function") return resolve();
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

export async function signOut() {
  try {
    const token = await getToken(false);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: "POST" });
    await removeCachedToken(token);
  } catch {
    /* already signed out */
  }
}

// fetch wrapper that attaches the token and retries once on 401 by dropping
// the (possibly stale) cached token and re-authing.
async function driveFetch(url, options = {}, interactive = false) {
  let token = await getToken(interactive);
  let res = await fetch(url, withAuth(options, token));
  if (res.status === 401) {
    await removeCachedToken(token);
    token = await getToken(interactive);
    res = await fetch(url, withAuth(options, token));
  }
  return res;
}

function withAuth(options, token) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", "Bearer " + token);
  return { ...options, headers };
}

export async function getUserEmail() {
  const res = await driveFetch(`${DRIVE_API}/about?fields=user(emailAddress)`);
  if (!res.ok) throw new Error("Failed to read account info.");
  const json = await res.json();
  return json.user?.emailAddress || null;
}

// Find our vault file. Returns { id, modifiedTime } or null.
export async function findVaultFile(fileName) {
  const q = encodeURIComponent(`name='${fileName}' and trashed=false`);
  const url = `${DRIVE_API}/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`;
  const res = await driveFetch(url);
  if (!res.ok) throw new Error("Drive search failed: " + res.status);
  const json = await res.json();
  const file = json.files?.[0];
  return file ? { id: file.id, modifiedTime: file.modifiedTime } : null;
}

// Create the vault file (multipart: metadata + media). Returns { id, modifiedTime }.
export async function createVaultFile(fileName, contentObj, interactive = true) {
  const boundary = "drivepass" + Math.abs(hashString(fileName + fileName.length));
  const metadata = { name: fileName, mimeType: "application/json" };
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    "Content-Type: application/json\r\n\r\n" +
    JSON.stringify(contentObj) +
    `\r\n--${boundary}--`;

  const res = await driveFetch(
    `${UPLOAD_API}/files?uploadType=multipart&fields=id,modifiedTime`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
    interactive
  );
  if (!res.ok) throw new Error("Drive create failed: " + res.status);
  const json = await res.json();
  return { id: json.id, modifiedTime: json.modifiedTime };
}

// Overwrite the vault file contents. Returns { id, modifiedTime }.
export async function updateVaultFile(fileId, contentObj) {
  const res = await driveFetch(
    `${UPLOAD_API}/files/${fileId}?uploadType=media&fields=id,modifiedTime`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(contentObj),
    }
  );
  if (!res.ok) throw new Error("Drive update failed: " + res.status);
  return res.json();
}

// Download and parse the vault file contents.
export async function downloadVaultFile(fileId) {
  const res = await driveFetch(`${DRIVE_API}/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error("Drive download failed: " + res.status);
  return res.json();
}

// tiny deterministic hash for the multipart boundary (avoids Math.random)
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
