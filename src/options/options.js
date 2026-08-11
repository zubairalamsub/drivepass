import { detectAndImportFile, exportToCSV } from "../lib/importer.js";
import { applyTheme } from "../lib/theme.js";

applyTheme();

const $ = (id) => document.getElementById(id);

const send = (type, payload = {}) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) =>
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res)
    );
  });

function msg(el, text, cls = "") {
  el.textContent = text || "";
  el.className = "status " + cls;
}

async function withLoading(btn, asyncFn) {
  if (!btn) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = original + '…';
  try {
    await asyncFn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function refresh() {
  const st = await send("STATUS");
  $("autolock").value = String(st.autoLockMinutes ?? 15);
  
  const savedTheme = (await chrome.storage.local.get("theme")).theme || "system";
  if ($("theme-select")) $("theme-select").value = savedTheme;

  if (st.connected) {
    $("drive-state").innerHTML = `Connected as <span class="pill">${st.email || "Google account"}</span>`;
    $("connect-btn").hidden = true;
    $("sync-btn").hidden = false;
    $("disconnect-btn").hidden = false;
  } else {
    $("drive-state").textContent = "Not connected. Your vault is stored locally only.";
    $("connect-btn").hidden = false;
    $("sync-btn").hidden = true;
    $("disconnect-btn").hidden = true;
  }

  // PIN status
  if (st.hasPin) {
    $("pin-state").innerHTML = `Status: <span class="pill ok">PIN Enabled</span>`;
    $("remove-pin-btn").hidden = false;
  } else {
    $("pin-state").textContent = "Status: No PIN set.";
    $("remove-pin-btn").hidden = true;
  }

  if (!st.locked) {
    loadTrash();
  }
}

async function loadTrash() {
  const res = await send("GET_TRASH");
  const container = $("trash-list");
  container.innerHTML = "";
  if (!res.ok || !res.entries || !res.entries.length) {
    container.innerHTML = `<p class="muted">Trash is empty.</p>`;
    $("purge-all-btn").hidden = true;
    return;
  }
  $("purge-all-btn").hidden = false;
  for (const e of res.entries) {
    const div = document.createElement("div");
    div.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border); font-size:13px;";
    const infoSpan = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = e.name || e.url || "Item";
    infoSpan.appendChild(strong);
    infoSpan.appendChild(document.createTextNode(` (${e.username || e.type || "login"})`));
    
    const btnsSpan = document.createElement("span");
    btnsSpan.innerHTML = `
        <button class="ghost small restore-btn" style="margin-top:0; padding:3px 8px;">Restore</button>
        <button class="danger small purge-btn" style="margin-top:0; padding:3px 8px;">Purge</button>
    `;
    
    div.appendChild(infoSpan);
    div.appendChild(btnsSpan);
    div.querySelector(".restore-btn").addEventListener("click", async () => {
      await send("RESTORE_ENTRY", { id: e.id });
      loadTrash();
    });
    div.querySelector(".purge-btn").addEventListener("click", async () => {
      await send("PURGE_ENTRY", { id: e.id });
      loadTrash();
    });
    container.appendChild(div);
  }
}

$("set-pin-btn")?.addEventListener("click", async () => {
  const pin = $("pin-input").value.trim();
  if (!pin || pin.length < 6) return msg($("pin-msg"), "Enter at least 6 digits for your PIN.", "err");
  if (!/^\d+$/.test(pin)) return msg($("pin-msg"), "PIN must be digits only.", "err");
  const res = await send("SETUP_PIN", { pin });
  if (!res.ok) return msg($("pin-msg"), res.error || "Failed to set PIN.", "err");
  $("pin-input").value = "";
  msg($("pin-msg"), "PIN enabled successfully!", "ok");
  refresh();
});

$("remove-pin-btn")?.addEventListener("click", async () => {
  const res = await send("REMOVE_PIN");
  if (!res.ok) return msg($("pin-msg"), res.error || "Failed.", "err");
  msg($("pin-msg"), "PIN removed.", "ok");
  refresh();
});

$("import-btn")?.addEventListener("click", () => {
  withLoading($("import-btn"), async () => {
    const fileInput = $("import-file");
    if (!fileInput.files || !fileInput.files[0]) return msg($("import-msg"), "Select a CSV or JSON file first.", "err");
    
    msg($("import-msg"), "Reading file…");
    const file = fileInput.files[0];
    const text = await file.text();
    
    try {
      const entries = detectAndImportFile(text);
      if (!entries.length) return msg($("import-msg"), "No valid entries found in file.", "err");
      const res = await send("IMPORT_ENTRIES", { entries });
      if (!res.ok) return msg($("import-msg"), res.error || "Import failed.", "err");
      const skippedNote = res.skipped ? ` (${res.skipped} duplicates skipped)` : '';
      // Check if Drive sync succeeded
      if (res.sync && res.sync.synced) {
        msg($("import-msg"), `Imported ${res.count} items — synced to Drive ✓${skippedNote}`, "ok");
      } else if (res.sync && res.sync.error) {
        msg($("import-msg"), `Imported ${res.count} items locally${skippedNote}. Drive sync failed: ${res.sync.error}. Try "Sync now".`, "err");
      } else {
        msg($("import-msg"), `Imported ${res.count} items${skippedNote}. Connect Drive to sync.`, "ok");
      }
      fileInput.value = "";
    } catch (e) {
      msg($("import-msg"), "Failed to parse file: " + e.message, "err");
    }
  });
});

$("export-csv-btn")?.addEventListener("click", async () => {
  const res = await send("GET_ENTRIES");
  if (!res.ok || !res.entries) return msg($("import-msg"), res.error || "Unlock vault first.", "err");
  const csv = exportToCSV(res.entries);
  downloadFile(csv, "drivepass-export.csv", "text/csv");
  msg($("import-msg"), "CSV exported successfully.", "ok");
});

$("export-json-btn")?.addEventListener("click", async () => {
  const local = await chrome.storage.local.get("cache_file");
  if (!local.cache_file) return msg($("import-msg"), "No vault found.", "err");
  const jsonStr = JSON.stringify(local.cache_file, null, 2);
  downloadFile(jsonStr, "drivepass-vault-backup.json", "application/json");
  msg($("import-msg"), "Encrypted JSON exported successfully.", "ok");
});

$('export-dec-json-btn')?.addEventListener('click', async () => {
  const res = await send('GET_ENTRIES');
  if (!res.ok || !res.entries) return msg($('import-msg'), res.error || 'Unlock vault first.', 'err');
  if (!confirm('This will export ALL your passwords in PLAINTEXT. Only use for migration. Continue?')) return;
  const exportData = {
    encrypted: false,
    format: 'drivepass-export-v1',
    exportedAt: new Date().toISOString(),
    items: res.entries.map(e => ({
      type: e.type || 'login',
      name: e.name, url: e.url, username: e.username, password: e.password,
      totp: e.totp, notes: e.notes, card: e.card, passkey: e.passkey,
      favorite: e.favorite, tags: e.tags,
    })),
  };
  downloadFile(JSON.stringify(exportData, null, 2), 'drivepass-export-decrypted.json', 'application/json');
  msg($('import-msg'), 'Decrypted JSON exported. Store it securely!', 'ok');
});

function downloadFile(content, fileName, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

$("purge-all-btn")?.addEventListener("click", async () => {
  if (!confirm("Permanently delete all items in trash?")) return;
  await send("PURGE_ALL_TRASH");
  loadTrash();
});

$("connect-btn").addEventListener("click", () => {
  withLoading($("connect-btn"), async () => {
    msg($("drive-msg"), "Opening Google sign-in…");
    const res = await send("CONNECT_DRIVE");
    if (!res.ok && res.error) return msg($("drive-msg"), res.error, "err");
    const note =
      res.adopted === "remote"
        ? "Found an existing vault in Drive — unlock it from the popup with its master password."
        : res.adopted === "local"
        ? "Local vault uploaded to Drive."
        : "Connected.";
    msg($("drive-msg"), note, "ok");
    refresh();
  });
});

$("sync-btn").addEventListener("click", () => {
  withLoading($("sync-btn"), async () => {
    msg($("drive-msg"), "Syncing…");
    const res = await send("SYNC");
    if (!res.ok) return msg($("drive-msg"), res.error || "Sync failed.", "err");
    msg($("drive-msg"), `Synced. ${res.count} logins.`, "ok");
  });
});

$("disconnect-btn").addEventListener("click", async () => {
  const res = await send("DISCONNECT_DRIVE");
  if (!res.ok) return msg($("drive-msg"), res.error || "Failed.", "err");
  msg($("drive-msg"), "Disconnected. Vault remains available locally.", "ok");
  refresh();
});

$("security-btn").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("src/security/security.html") })
);

$("autolock").addEventListener("change", async (e) => {
  const minutes = parseInt(e.target.value, 10);
  const res = await send("SET_AUTOLOCK", { minutes });
  msg($("autolock-msg"), res.ok ? "Saved." : res.error, res.ok ? "ok" : "err");
});

$("change-btn").addEventListener("click", () => {
  withLoading($("change-btn"), async () => {
    const cur = $("cur-pw").value;
    const next = $("new-pw").value;
    const next2 = $("new-pw2").value;
    if (next.length < 8) return msg($("change-msg"), "New password needs 8+ characters.", "err");
    if (next !== next2) return msg($("change-msg"), "New passwords don't match.", "err");
    const res = await send("CHANGE_MASTER", { current: cur, next });
    if (!res.ok) return msg($("change-msg"), res.error || "Failed.", "err");
    $("cur-pw").value = $("new-pw").value = $("new-pw2").value = "";
    msg($("change-msg"), "Master password changed.", "ok");
  });
});

$("theme-select")?.addEventListener("change", async (e) => {
  const theme = e.target.value;
  await chrome.storage.local.set({ theme });
});

refresh();
