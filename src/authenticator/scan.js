// scan.js — live camera QR scanning for adding 2FA accounts.
// Runs in its own extension tab (not the popup) so the camera-permission
// prompt can't dismiss it. Decodes with the bundled jsQR, then saves the
// account to the vault via the service worker.

import { parseOtpauthURI, parseTotpSecret, generateTOTP } from "../lib/totp.js";

const $ = (id) => document.getElementById(id);

const send = (type, payload = {}) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) =>
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res)
    );
  });

const video = $("video");
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

let stream = null;
let scanning = false;
let rafId = null;

function setStatus(text, cls = "") {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + cls;
}

async function startCamera() {
  $("result-stage").hidden = true;
  $("video-stage").hidden = false;
  setStatus("Requesting camera…");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  } catch (e) {
    setStatus(
      e && e.name === "NotAllowedError"
        ? "Camera permission denied. Allow camera access, then reload this tab."
        : "No camera available. You can upload a QR image from the popup instead.",
      "err"
    );
    return;
  }
  video.srcObject = stream;
  await video.play();
  setStatus("Point the camera at the QR code…");
  scanning = true;
  tick();
}

function stopCamera() {
  scanning = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

function tick() {
  if (!scanning) return;
  if (video.readyState === video.HAVE_ENOUGH_DATA && self.jsQR) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = self.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
    if (result && result.data) {
      onDecoded(result.data);
      return;
    }
  }
  rafId = requestAnimationFrame(tick);
}

async function onDecoded(data) {
  const parsed = parseOtpauthURI(data);
  if (!parsed) {
    // Not an otpauth QR — keep scanning rather than saving junk.
    setStatus("That QR isn't a 2FA setup code. Still scanning…", "err");
    rafId = requestAnimationFrame(tick);
    return;
  }
  stopCamera();

  const secret = parseTotpSecret(parsed.secret);
  const code = await generateTOTP(secret);

  const entry = {
    type: "login",
    name: parsed.issuer || parsed.account || "Authenticator",
    username: parsed.account || "",
    totp: secret,
  };
  const res = await send("SAVE_ENTRY", { entry });

  $("r-issuer").textContent = entry.name;
  $("r-account").textContent = entry.username;
  $("r-code").textContent = code ? (code.length === 6 ? code.slice(0, 3) + " " + code.slice(3) : code) : "------";

  if (res.locked || (!res.ok && /lock/i.test(res.error || ""))) {
    $("r-note").textContent = "Vault is locked — unlock DrivePass from the toolbar, then scan again.";
    $("r-note").style.color = "var(--danger)";
  } else if (!res.ok) {
    $("r-note").textContent = "Couldn't save: " + (res.error || "unknown error");
    $("r-note").style.color = "var(--danger)";
  } else {
    $("r-note").textContent = "Saved to your vault ✓";
    $("r-note").style.color = "var(--ok)";
  }

  $("video-stage").hidden = true;
  $("result-stage").hidden = false;
}

$("scan-again").addEventListener("click", startCamera);
$("done-btn").addEventListener("click", () => {
  stopCamera();
  window.close();
});
window.addEventListener("beforeunload", stopCamera);

// Warn early if the vault is locked, but still let them scan.
(async () => {
  const st = await send("STATUS");
  if (st && st.locked) {
    setStatus("Tip: unlock DrivePass from the toolbar first so scans save automatically.", "err");
  }
  startCamera();
})();
