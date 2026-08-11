// popup.js — DrivePass popup UI logic.
import { generatePassword, passwordEntropyBits } from "../lib/crypto.js";
import { generateTOTP, getTotpTimeRemaining, parseTotpSecret, parseOtpauthURI } from "../lib/totp.js";
import { generatePassphrase, passphraseEntropyBits } from "../lib/passphrase.js";
import { applyTheme } from "../lib/theme.js";

applyTheme();

const $ = (id) => document.getElementById(id);
const views = ["loading", "create", "unlock", "list", "edit", "generator", "auth"];

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}

function showView(name) {
  for (const v of views) $("view-" + v).hidden = v !== name;
  if (name !== "auth") stopAuthTimer();
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

function toast(text) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1800);
}

let allEntries = [];
let editingId = null;
let activeTypeFilter = "all";
let activeSortOrder = 'name';
let totpTimerInterval = null;

async function refresh() {
  const st = await send("STATUS");
  const badge = $("sync-badge");
  if (!st.connected) {
    badge.textContent = "Local only";
    badge.className = "badge warn";
  } else {
    badge.textContent = "Drive ✓";
    badge.className = "badge ok";
  }
  $("lock-btn").hidden = st.locked || !st.hasVault;

  if (!st.hasVault) return showView("create");
  if (st.locked) {
    showView("unlock");
    $("pin-unlock-box").hidden = !st.hasPin;
    if (st.hasPin) $("unlock-pin").focus();
    else $("unlock-pw").focus();
    return;
  }
  await loadList();
}

async function loadList() {
  const res = await send("GET_ENTRIES");
  if (!res.ok && res.error) {
    if (/lock/i.test(res.error)) return refresh();
  }
  allEntries = res.entries || [];
  renderList($("search").value);
  showView("list");
}

// Site icon from Chrome's OWN favicon cache (the "favicon" permission), which
// resolves entirely on-device. The obvious implementation — Google's
// s2/favicons endpoint — would announce every hostname in the vault to a third
// party every time the popup opens, which is exactly what this extension
// exists to avoid. Sites the user has never visited simply have no icon; the
// caller falls back to a letter avatar via onerror.
function getFaviconUrl(url) {
  if (!url) return null;
  let origin;
  try {
    origin = new URL(url.includes("://") ? url : "https://" + url).origin;
  } catch {
    return null;
  }
  const favicon = new URL(chrome.runtime.getURL("/_favicon/"));
  favicon.searchParams.set("pageUrl", origin);
  favicon.searchParams.set("size", "32");
  return favicon.toString();
}

function renderList(filter = "") {
  const ul = $("entry-list");
  ul.innerHTML = "";
  const f = filter.trim().toLowerCase();

  // Filter and sort items
  let items = allEntries.filter((e) => {
    const matchesFilter =
      !f ||
      (e.name || "").toLowerCase().includes(f) ||
      (e.url || "").toLowerCase().includes(f) ||
      (e.username || "").toLowerCase().includes(f);
    const matchesType = activeTypeFilter === "all" || (e.type || "login") === activeTypeFilter;
    return matchesFilter && matchesType;
  });

  items.sort((a, b) => {
    // Favorites always first
    if (a.favorite !== b.favorite) return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
    
    // Then apply activeSortOrder
    if (activeSortOrder === 'name' || activeSortOrder === 'name-desc') {
      const nameA = (a.name || a.url || '').toLowerCase();
      const nameB = (b.name || b.url || '').toLowerCase();
      const cmp = nameA.localeCompare(nameB);
      return activeSortOrder === 'name-desc' ? -cmp : cmp;
    } else if (activeSortOrder === 'recent') {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    } else if (activeSortOrder === 'oldest') {
      return (a.updatedAt || 0) - (b.updatedAt || 0);
    }
    return 0;
  });

  $("empty-msg").hidden = items.length !== 0;

  for (const e of items) {
    const li = document.createElement("li");
    li.className = "entry" + (e.favorite ? " favorite" : "");
    
    const favUrl = getFaviconUrl(e.url);
    const typeIcon = e.type === "card" ? "💳" : e.type === "note" ? "📝" : e.type === "passkey" ? "🔑" : (e.name || e.url || "?").charAt(0);

    li.innerHTML = `
      <button class="star-btn" title="${e.favorite ? "Unstar" : "Star"}">${e.favorite ? "★" : "☆"}</button>
      <span class="avatar"></span>
      <span class="meta">
        <div class="name"></div>
        <div class="sub"></div>
      </span>
      <button class="copy" title="Copy">Copy</button>`;

    const avatarEl = li.querySelector(".avatar");
    if (favUrl) {
      const img = document.createElement("img");
      img.src = favUrl;
      img.width = 16;
      img.height = 16;
      img.style.borderRadius = "3px";
      img.onerror = () => { avatarEl.textContent = typeIcon; };
      avatarEl.appendChild(img);
    } else {
      avatarEl.textContent = typeIcon;
    }
    
    li.querySelector(".name").textContent = e.name || e.url || "(unnamed)";
    const subText = e.type === "card"
      ? (e.card?.number ? "•••• " + e.card.number.slice(-4) : "Credit Card")
      : e.type === "note"
      ? "Secure Note"
      : e.type === "passkey"
      ? (e.passkey?.userName || "Passkey")
      : e.username || e.url || "";
    li.querySelector(".sub").textContent = subText;

    li.querySelector(".star-btn").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await send("TOGGLE_FAVORITE", { id: e.id });
      await loadList();
    });

    li.querySelector(".copy").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const valToCopy = e.type === "card" ? (e.card?.number || "") : e.type === "note" ? (e.notes || "") : (e.password || "");
      navigator.clipboard.writeText(valToCopy);
      send("SCHEDULE_CLEAR_CLIPBOARD");
      toast(e.type === "card" ? "Card copied (clears in 30s)" : e.type === "note" ? "Note copied" : "Password copied (clears in 30s)");
    });
    li.addEventListener("click", () => openEdit(e));
    ul.appendChild(li);
  }
}

function updateTypeFormVisibility(type) {
  $("fields-login").hidden = type !== "login";
  $("fields-card").hidden = type !== "card";
  $("fields-passkey").hidden = type !== "passkey";
}

async function startTotpTimer(totpSecret) {
  if (totpTimerInterval) clearInterval(totpTimerInterval);
  const preview = $("totp-preview");
  if (!totpSecret) {
    preview.hidden = true;
    return;
  }
  preview.hidden = false;

  async function update() {
    const code = await generateTOTP(totpSecret);
    const rem = getTotpTimeRemaining();
    $("totp-code").textContent = code || "INVALID";
    $("totp-timer").textContent = `${rem}s`;
  }
  await update();
  totpTimerInterval = setInterval(update, 1000);
}

function openEdit(entry) {
  editingId = entry?.id || null;
  const type = entry?.type || "login";
  $("edit-title").textContent = entry ? "Edit Item" : "Add Item";
  $("f-type").value = type;
  $("f-name").value = entry?.name || "";
  $("f-url").value = entry?.url || "";
  $("f-username").value = entry?.username || "";
  $("f-password").value = entry?.password || "";
  $("f-totp").value = entry?.totp || "";
  $("f-notes").value = entry?.notes || "";

  $("f-card-holder").value = entry?.card?.holder || "";
  $("f-card-number").value = entry?.card?.number || "";
  $("f-card-exp").value = entry?.card?.expMonth && entry?.card?.expYear ? `${entry.card.expMonth}/${entry.card.expYear}` : "";
  $("f-card-cvv").value = entry?.card?.cvv || "";

  $("f-passkey-rpid").value = entry?.passkey?.rpId || "";
  $("f-passkey-user").value = entry?.passkey?.userName || "";
  $("f-passkey-credid").value = entry?.passkey?.credentialId || "";

  updateTypeFormVisibility(type);
  startTotpTimer(entry?.totp);

  // Render password history if available
  const historyBox = $("history-box");
  const historyList = $("history-list");
  historyList.innerHTML = "";
  if (entry && Array.isArray(entry.history) && entry.history.length > 0) {
    historyBox.hidden = false;
    for (const h of entry.history) {
      const item = document.createElement("li");
      item.className = "history-item";
      const dt = new Date(h.updatedAt).toLocaleDateString();
      const pwSpan = document.createElement("span");
      pwSpan.className = "pw";
      pwSpan.textContent = h.password;
      const dateSpan = document.createElement("span");
      dateSpan.className = "date";
      dateSpan.textContent = dt;
      item.appendChild(pwSpan);
      item.appendChild(dateSpan);
      item.addEventListener("click", () => {
        navigator.clipboard.writeText(h.password);
        send("SCHEDULE_CLEAR_CLIPBOARD");
        toast("Old password copied");
      });
      historyList.appendChild(item);
    }
  } else {
    historyBox.hidden = true;
  }

  $("edit-err").hidden = true;
  $("delete-btn").hidden = !entry;
  showView("edit");
  $("f-name").focus();
}

// ---- wire up events --------------------------------------------------------
$("f-type").addEventListener("change", (e) => updateTypeFormVisibility(e.target.value));
$("f-totp").addEventListener("input", (e) => startTotpTimer(e.target.value));

$("copy-totp-btn")?.addEventListener("click", () => {
  const code = $("totp-code").textContent;
  if (code && code !== "------" && code !== "INVALID") {
    navigator.clipboard.writeText(code);
    send("SCHEDULE_CLEAR_CLIPBOARD");
    toast("2FA code copied");
  }
});

document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    e.target.classList.add("active");
    activeTypeFilter = e.target.dataset.type;
    renderList($("search").value);
  });
});

document.querySelectorAll(".pw-toggle").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const input = btn.previousElementSibling;
    if (input.type === "password") {
      input.type = "text";
      btn.style.opacity = "1";
    } else {
      input.type = "password";
      btn.style.opacity = "";
    }
  });
});

$("create-pw").addEventListener("input", (e) => {
  const pw = e.target.value;
  const meter = $("pw-strength");
  if (!pw) {
    meter.hidden = true;
    return;
  }
  meter.hidden = false;
  
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
  
  const bits = pool === 0 ? 0 : Math.round(pw.length * Math.log2(pool));
  const fill = $("pw-strength-fill");
  const label = $("pw-strength-label");
  
  const pct = Math.min(100, Math.max(0, bits));
  fill.style.width = pct + "%";
  
  if (bits < 40) {
    fill.style.backgroundColor = "var(--danger)";
    label.textContent = "Very Weak";
    label.style.color = "var(--danger)";
  } else if (bits < 60) {
    fill.style.backgroundColor = "#f97316";
    label.textContent = "Weak";
    label.style.color = "#f97316";
  } else if (bits < 80) {
    fill.style.backgroundColor = "#eab308";
    label.textContent = "Fair";
    label.style.color = "#eab308";
  } else if (bits < 100) {
    fill.style.backgroundColor = "var(--ok)";
    label.textContent = "Strong";
    label.style.color = "var(--ok)";
  } else {
    fill.style.backgroundColor = "var(--accent)";
    label.textContent = "Very Strong";
    label.style.color = "var(--accent)";
  }
});

$("create-btn").addEventListener("click", () => {
  withLoading($("create-btn"), async () => {
    const pw = $("create-pw").value;
    const pw2 = $("create-pw2").value;
    const err = $("create-err");
    if (pw.length < 8) return showErr(err, "Use at least 8 characters.");
    if (pw !== pw2) return showErr(err, "Passwords don't match.");
    const res = await send("CREATE_VAULT", { password: pw });
    if (!res.ok) return showErr(err, res.error);
    await refresh();
  });
});

$("unlock-btn").addEventListener("click", () => withLoading($("unlock-btn"), unlock));
$("unlock-pw").addEventListener("keydown", (e) => e.key === "Enter" && withLoading($("unlock-btn"), unlock));
async function unlock() {
  const err = $("unlock-err");
  const res = await send("UNLOCK", { password: $("unlock-pw").value });
  if (!res.ok) return showErr(err, res.error);
  $("unlock-pw").value = "";
  await refresh();
}

$("unlock-pin-btn")?.addEventListener("click", () => withLoading($("unlock-pin-btn"), unlockPin));
$("unlock-pin")?.addEventListener("keydown", (e) => e.key === "Enter" && withLoading($("unlock-pin-btn"), unlockPin));
async function unlockPin() {
  const err = $("unlock-err");
  const pin = $("unlock-pin").value.trim();
  if (!pin) return showErr(err, "Enter PIN.");
  const res = await send("UNLOCK_PIN", { pin });
  if (!res.ok) return showErr(err, res.error);
  $("unlock-pin").value = "";
  await refresh();
}

$("lock-btn").addEventListener("click", async () => {
  await send("LOCK");
  await refresh();
});
$("settings-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("security-btn").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("src/security/security.html") })
);
$("add-btn").addEventListener("click", () => openEdit(null));
$("empty-add-btn")?.addEventListener("click", () => openEdit(null));
$("search").addEventListener("input", (e) => renderList(e.target.value));
$("cancel-btn").addEventListener("click", () => {
  if (totpTimerInterval) clearInterval(totpTimerInterval);
  loadList();
});
$("gen-btn").addEventListener("click", () => {
  $("f-password").value = generatePassword(20, { symbols: true });
});
$("gen-phrase-btn")?.addEventListener("click", () => {
  $("f-password").value = generatePassphrase(4, "-", true);
  toast("Generated passphrase");
});

$("save-btn").addEventListener("click", () => {
  withLoading($("save-btn"), async () => {
    const type = $("f-type").value;
    const expParts = $("f-card-exp").value.split("/");
    const entry = {
      id: editingId || undefined,
      type,
      name: $("f-name").value.trim(),
      url: $("f-url").value.trim(),
      username: $("f-username").value.trim(),
      password: $("f-password").value,
      totp: $("f-totp").value.trim(),
      notes: $("f-notes").value.trim(),
      card: {
        holder: $("f-card-holder").value.trim(),
        number: $("f-card-number").value.trim(),
        expMonth: (expParts[0] || "").trim(),
        expYear: (expParts[1] || "").trim(),
        cvv: $("f-card-cvv").value.trim(),
      },
      passkey: {
        rpId: $("f-passkey-rpid").value.trim(),
        userName: $("f-passkey-user").value.trim(),
        credentialId: $("f-passkey-credid").value.trim(),
      },
    };
    if (!entry.name && !entry.url) return showErr($("edit-err"), "Add a name or title.");
    const res = await send("SAVE_ENTRY", { entry });
    if (!res.ok) return showErr($("edit-err"), res.error);
    if (res.sync && res.sync.error) toast("Saved locally — sync failed");
    if (totpTimerInterval) clearInterval(totpTimerInterval);
    await loadList();
  });
});

$("delete-btn").addEventListener("click", async () => {
  if (!editingId) return;
  if (!confirm('Move this item to trash?')) return;
  const res = await send("DELETE_ENTRY", { id: editingId });
  if (!res.ok) return showErr($("edit-err"), res.error);
  if (totpTimerInterval) clearInterval(totpTimerInterval);
  await loadList();
});

function showErr(el, msg) {
  el.textContent = msg || "Something went wrong.";
  el.hidden = false;
}

// ---- Generator Studio ------------------------------------------------------
let genMode = "random"; // "random" | "passphrase"

function updateStudioGenerator() {
  let pw = "";
  let bits = 0;

  if (genMode === "random") {
    const len = parseInt($("gen-len-slider").value, 10);
    const upper = $("gen-opt-upper").checked;
    const lower = $("gen-opt-lower").checked;
    const nums = $("gen-opt-nums").checked;
    const syms = $("gen-opt-syms").checked;
    $("gen-len-val").textContent = String(len);

    const opts = { upper, lower, digits: nums, symbols: syms };
    pw = generatePassword(len, opts);
    // Entropy from the generator's own alphabet, so the meter can't drift from
    // what is actually generated.
    bits = Math.round(passwordEntropyBits(len, opts));
  } else {
    const words = parseInt($("gen-words-slider").value, 10);
    const sep = $("gen-sep-select").value;
    $("gen-words-val").textContent = String(words);

    pw = generatePassphrase(words, sep, true);
    bits = Math.round(passphraseEntropyBits(words, true));
  }

  $("gen-output").textContent = pw;
  $("gen-entropy-label").textContent = `${bits} bits entropy`;

  const strengthEl = $("gen-strength-label");
  if (bits < 45) {
    strengthEl.textContent = "Weak";
    strengthEl.style.color = "var(--danger)";
  } else if (bits < 70) {
    strengthEl.textContent = "Fair";
    strengthEl.style.color = "#f59e0b";
  } else if (bits < 95) {
    strengthEl.textContent = "Strong";
    strengthEl.style.color = "var(--ok)";
  } else {
    strengthEl.textContent = "Extremely Secure";
    strengthEl.style.color = "var(--accent)";
  }
}

$("gen-studio-btn")?.addEventListener("click", () => {
  showView("generator");
  updateStudioGenerator();
});

$("gen-back-btn")?.addEventListener("click", () => {
  loadList();
});

$("gen-mode-random")?.addEventListener("click", () => {
  genMode = "random";
  $("gen-mode-random").classList.add("active");
  $("gen-mode-passphrase").classList.remove("active");
  $("gen-ctrl-random").hidden = false;
  $("gen-ctrl-passphrase").hidden = true;
  updateStudioGenerator();
});

$("gen-mode-passphrase")?.addEventListener("click", () => {
  genMode = "passphrase";
  $("gen-mode-passphrase").classList.add("active");
  $("gen-mode-random").classList.remove("active");
  $("gen-ctrl-random").hidden = true;
  $("gen-ctrl-passphrase").hidden = false;
  updateStudioGenerator();
});

$("gen-len-slider")?.addEventListener("input", updateStudioGenerator);
$("gen-words-slider")?.addEventListener("input", updateStudioGenerator);
$("gen-sep-select")?.addEventListener("change", updateStudioGenerator);
$("gen-opt-upper")?.addEventListener("change", updateStudioGenerator);
$("gen-opt-lower")?.addEventListener("change", updateStudioGenerator);
$("gen-opt-nums")?.addEventListener("change", updateStudioGenerator);
$("gen-opt-syms")?.addEventListener("change", updateStudioGenerator);
$("gen-refresh-btn")?.addEventListener("click", updateStudioGenerator);

$("gen-copy-btn")?.addEventListener("click", () => {
  const pw = $("gen-output").textContent;
  if (pw && pw !== "-") {
    navigator.clipboard.writeText(pw);
    send("SCHEDULE_CLEAR_CLIPBOARD");
    toast("Password copied (clears in 30s)");
  }
});

$("sort-select")?.addEventListener("change", (e) => {
  activeSortOrder = e.target.value;
  renderList($("search").value);
});

document.addEventListener('keydown', (e) => {
  // Escape: go back to list from edit/generator views
  if (e.key === 'Escape') {
    const editVisible = !$('view-edit').hidden;
    const genVisible = !$('view-generator').hidden;
    if (editVisible) { if (totpTimerInterval) clearInterval(totpTimerInterval); loadList(); }
    else if (genVisible) { loadList(); }
  }
  // Ctrl/Cmd + F: focus search when list is visible
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !$('view-list').hidden) {
    e.preventDefault();
    $('search').focus();
  }
});

// ---- Authenticator (2FA codes) --------------------------------------------
let authTimer = null;
let authAccounts = []; // [{ entry, codeEl, ringFg, numEl }]
const RING_C = 2 * Math.PI * 14;

function stopAuthTimer() {
  if (authTimer) {
    clearInterval(authTimer);
    authTimer = null;
  }
}

function fmtCode(code) {
  if (!code) return "------";
  return code.length === 6 ? code.slice(0, 3) + " " + code.slice(3) : code;
}

async function showAuthView() {
  const res = await send("GET_ENTRIES");
  if (!res.ok && res.error) {
    if (/lock/i.test(res.error)) return refresh();
  }
  allEntries = res.entries || allEntries;
  renderAuthList();
  showView("auth");
}

function renderAuthList() {
  stopAuthTimer();
  const ul = $("auth-list");
  ul.innerHTML = "";
  authAccounts = [];
  const totpEntries = (allEntries || []).filter((e) => (e.totp || "").trim());
  $("auth-empty").hidden = totpEntries.length !== 0;

  for (const e of totpEntries) {
    const li = document.createElement("li");
    li.className = "auth-card";
    li.innerHTML = `
      <div class="auth-ring">
        <svg width="34" height="34" viewBox="0 0 34 34">
          <circle class="ring-bg" cx="17" cy="17" r="14"></circle>
          <circle class="ring-fg" cx="17" cy="17" r="14" transform="rotate(-90 17 17)"></circle>
        </svg>
        <span class="ring-num"></span>
      </div>
      <div class="auth-meta">
        <div class="issuer"></div>
        <div class="account"></div>
      </div>
      <div class="auth-code">------</div>`;
    li.querySelector(".issuer").textContent = e.name || e.url || "Account";
    li.querySelector(".account").textContent = e.username || "";
    const ringFg = li.querySelector(".ring-fg");
    ringFg.style.strokeDasharray = String(RING_C);
    const rec = {
      entry: e,
      codeEl: li.querySelector(".auth-code"),
      ringFg,
      numEl: li.querySelector(".ring-num"),
    };
    authAccounts.push(rec);
    li.addEventListener("click", () => {
      const code = (rec.codeEl.textContent || "").replace(/\s/g, "");
      if (code && code !== "------" && code !== "INVALID") {
        navigator.clipboard.writeText(code);
        send("SCHEDULE_CLEAR_CLIPBOARD");
        toast("2FA code copied (clears in 30s)");
      }
    });
    ul.appendChild(li);
  }

  if (authAccounts.length) {
    tickAuth();
    authTimer = setInterval(tickAuth, 1000);
  }
}

async function tickAuth() {
  const rem = getTotpTimeRemaining(30);
  for (const rec of authAccounts) {
    const code = await generateTOTP(rec.entry.totp);
    rec.codeEl.textContent = fmtCode(code);
    rec.numEl.textContent = String(rem);
    rec.ringFg.style.strokeDashoffset = String(RING_C * (1 - rem / 30));
    rec.ringFg.style.stroke = rem <= 5 ? "var(--danger)" : "var(--accent)";
  }
}

function fillAddFormFromUri(uri) {
  const parsed = parseOtpauthURI(uri);
  $("auth-secret").value = uri;
  if (parsed) {
    if (!$("auth-issuer").value) $("auth-issuer").value = parsed.issuer || "";
    if (!$("auth-account").value) $("auth-account").value = parsed.account || "";
  }
  $("auth-add-err").hidden = true;
}

async function decodeQrFromFile(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = self.jsQR ? self.jsQR(img.data, img.width, img.height) : null;
  return result ? result.data : null;
}

async function saveAuthAccount() {
  const raw = $("auth-secret").value.trim();
  let issuer = $("auth-issuer").value.trim();
  let account = $("auth-account").value.trim();
  if (!raw) return showErr($("auth-add-err"), "Enter a setup key or otpauth:// URI.");

  let secret = raw;
  if (raw.toLowerCase().startsWith("otpauth://")) {
    const parsed = parseOtpauthURI(raw);
    if (!parsed) return showErr($("auth-add-err"), "Couldn't read that otpauth:// URI.");
    secret = parsed.secret;
    if (!issuer) issuer = parsed.issuer;
    if (!account) account = parsed.account;
  }
  secret = parseTotpSecret(secret);
  const test = await generateTOTP(secret);
  if (!test) return showErr($("auth-add-err"), "Invalid 2FA secret — check the key and try again.");

  const entry = {
    type: "login",
    name: issuer || account || "Authenticator",
    username: account,
    totp: secret,
  };
  const res = await send("SAVE_ENTRY", { entry });
  if (!res.ok) return showErr($("auth-add-err"), res.error);
  $("auth-secret").value = $("auth-issuer").value = $("auth-account").value = "";
  $("auth-add-err").hidden = true;
  $("auth-add-panel").hidden = true;
  toast("Account added");
  await showAuthView();
}

$("auth-btn").addEventListener("click", showAuthView);
$("auth-back-btn").addEventListener("click", () => {
  stopAuthTimer();
  loadList();
});
$("auth-add-toggle").addEventListener("click", () => {
  const p = $("auth-add-panel");
  p.hidden = !p.hidden;
  if (!p.hidden) $("auth-secret").focus();
});
$("auth-save-btn").addEventListener("click", () => withLoading($("auth-save-btn"), saveAuthAccount));
$("auth-secret").addEventListener("paste", (e) => {
  const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
  if (text.toLowerCase().startsWith("otpauth://")) setTimeout(() => fillAddFormFromUri(text.trim()), 0);
});
$("auth-upload-btn").addEventListener("click", () => $("auth-qr-file").click());
$("auth-qr-file").addEventListener("change", async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  try {
    const uri = await decodeQrFromFile(file);
    if (!uri) showErr($("auth-add-err"), "No QR code found in that image.");
    else fillAddFormFromUri(uri);
  } catch {
    showErr($("auth-add-err"), "Couldn't read that image.");
  } finally {
    ev.target.value = "";
  }
});
$("auth-scan-btn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/authenticator/scan.html") });
});

$("create-pw2")?.addEventListener("keydown", (e) => e.key === "Enter" && $("create-btn").click());
refresh();
