// security.js — DrivePass Security Center.
//
// Password-health analysis (reuse / weak / old) runs entirely in this page on
// entries fetched from the (unlocked) vault — nothing leaves the device.
// The breach check is opt-in per visit and sends only 5-char SHA-1 prefixes
// to the HIBP range API (see lib/hibp.js for the k-anonymity details).
// The Recommendations tab renders the bundled offers.json; links open only
// on explicit user click (CWS affiliate policy compliance).

import { pwnedCounts } from "../lib/hibp.js";
import { applyTheme } from "../lib/theme.js";

applyTheme();
import { generatePassword } from "../lib/crypto.js";

const $ = (id) => document.getElementById(id);

const send = (type, payload = {}) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) =>
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res)
    );
  });

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

let entries = []; // live entries that have a password
let allVaultEntries = [];
let health = null; // { reusedGroups, weak, old, missingTotp }
let breachedByPassword = null; // Map<password, count> after a breach check

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

init();

async function init() {
  const st = await send("STATUS");
  if (!st || !st.hasVault || st.locked) {
    $("view-locked").hidden = false;
    return;
  }
  const res = await send("GET_ENTRIES");
  if (!res.ok && res.error) {
    $("view-locked").hidden = false;
    return;
  }
  allVaultEntries = res.entries || [];
  entries = allVaultEntries.filter((e) => e.password);
  health = analyze(allVaultEntries);

  $("view-main").hidden = false;
  renderScore();
  renderSummary();
  renderHealth();
  renderTotpAudit();
  loadOffers();
  wireTabs();
  $("breach-btn").addEventListener("click", runBreachCheck);
}

// ---- local analysis --------------------------------------------------------
function charsetCount(pw) {
  let n = 0;
  if (/[a-z]/.test(pw)) n++;
  if (/[A-Z]/.test(pw)) n++;
  if (/[0-9]/.test(pw)) n++;
  if (/[^a-zA-Z0-9]/.test(pw)) n++;
  return n;
}

function isWeak(pw) {
  if (pw.length < 8) return true;
  if (pw.length < 12 && charsetCount(pw) < 3) return true;
  return false;
}

function analyze(list) {
  const pwList = list.filter((e) => e.password);
  const byPassword = new Map();
  for (const e of pwList) {
    if (!byPassword.has(e.password)) byPassword.set(e.password, []);
    byPassword.get(e.password).push(e);
  }
  const reusedGroups = [...byPassword.values()].filter((g) => g.length > 1);
  const weak = pwList.filter((e) => isWeak(e.password));
  const old = pwList.filter((e) => Date.now() - (e.updatedAt || 0) > YEAR_MS);
  const missingTotp = list.filter((e) => (e.type || "login") === "login" && !e.totp);
  return { reusedGroups, weak, old, missingTotp };
}

function calculateScore() {
  if (!entries.length) return 100;
  let score = 100;

  const reusedCount = health.reusedGroups.flat().length;
  const weakCount = health.weak.length;
  const oldCount = health.old.length;
  const missingTotpCount = health.missingTotp.length;
  const breachedCount = breachedByPassword
    ? entries.filter((e) => breachedByPassword.get(e.password) > 0).length
    : 0;

  score -= reusedCount * 8;
  score -= weakCount * 12;
  score -= oldCount * 4;
  score -= missingTotpCount * 2;
  score -= breachedCount * 25;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function renderScore() {
  const score = calculateScore();
  const numEl = $("score-num");
  const circleEl = $("score-circle");
  const badgeEl = $("score-badge");
  const descEl = $("score-desc");

  numEl.textContent = String(score);
  let color = "#10b981";
  let label = "EXCELLENT";
  let desc = "Your vault has high password strength, uniqueness, and security coverage.";

  if (score < 50) {
    color = "#ef4444";
    label = "CRITICAL RISK";
    desc = "High-risk vulnerabilities detected! Update weak, reused, or breached passwords immediately.";
  } else if (score < 75) {
    color = "#f59e0b";
    label = "NEEDS ATTENTION";
    desc = "Fair health score. Consider rotating old/reused passwords and enabling 2FA.";
  }

  circleEl.style.borderColor = color;
  numEl.style.color = color;
  badgeEl.textContent = label;
  badgeEl.className = "pill " + (score >= 75 ? "good" : score >= 50 ? "warn" : "bad");
  descEl.textContent = desc;
}

// ---- rendering --------------------------------------------------------------
function stat(label, value, cls = "") {
  return `<div class="stat ${cls}"><div class="num">${value}</div><div class="lbl">${label}</div></div>`;
}

function renderSummary() {
  const reusedEntries = health.reusedGroups.flat().length;
  const breached = breachedByPassword
    ? entries.filter((e) => breachedByPassword.get(e.password) > 0).length
    : null;
  $("summary").innerHTML =
    stat("Logins", allVaultEntries.length) +
    stat("Reused", reusedEntries, reusedEntries ? "warn" : "good") +
    stat("Weak", health.weak.length, health.weak.length ? "warn" : "good") +
    stat("Old (1yr+)", health.old.length, health.old.length ? "warn" : "good") +
    stat("Missing 2FA", health.missingTotp.length, health.missingTotp.length ? "warn" : "good") +
    stat("Breached", breached === null ? "?" : breached, breached ? "bad" : breached === 0 ? "good" : "");
}

function entryRow(e, tagText = "", tagBad = false) {
  const row = document.createElement("div");
  row.className = "issue-row";
  row.innerHTML = `
    <span class="avatar"></span>
    <span class="meta"><div class="name"></div><div class="sub"></div></span>
    <span class="tag${tagBad ? " bad" : ""}"></span>
    <button class="primary small gen-fix-btn" style="margin:0 0 0 10px; padding:4px 10px; font-size:12px;" title="Generate & save new strong password">Fix 🎲</button>`;
  
  row.querySelector(".avatar").textContent = (e.name || e.url || "?").charAt(0);
  row.querySelector(".name").textContent = e.name || e.url || "(unnamed)";
  row.querySelector(".sub").textContent = e.username || e.url || "";
  row.querySelector(".tag").textContent = tagText;

  row.querySelector(".gen-fix-btn").addEventListener("click", async () => {
    if (!confirm('Replace password for ' + (e.name || e.url || 'this entry') + ' with a new 24-char password?')) return;
    const newPass = generatePassword(24, { symbols: true });
    e.password = newPass;
    e.updatedAt = Date.now();
    await send("SAVE_ENTRY", { entry: e });
    navigator.clipboard.writeText(newPass);
    toast("Generated & copied new 24-char password!");
    
    // Re-analyze
    const res = await send("GET_ENTRIES");
    if (res.ok) {
      allVaultEntries = res.entries || [];
      entries = allVaultEntries.filter((el) => el.password);
      health = analyze(allVaultEntries);
      renderScore();
      renderSummary();
      renderHealth();
      renderTotpAudit();
    }
  });

  return row;
}

function renderIssueList(el, items, emptyText, tagFor = () => "") {
  el.innerHTML = "";
  if (!items.length) {
    el.innerHTML = `<p class="all-clear">✓ ${emptyText}</p>`;
    return;
  }
  for (const e of items) el.appendChild(entryRow(e, tagFor(e)));
}

function renderHealth() {
  const reusedEntries = health.reusedGroups.flat();
  setPill($("reused-count"), reusedEntries.length);
  setPill($("weak-count"), health.weak.length);
  setPill($("old-count"), health.old.length);

  const reusedEl = $("reused-list");
  reusedEl.innerHTML = "";
  if (!health.reusedGroups.length) {
    reusedEl.innerHTML = `<p class="all-clear">✓ Every login has a unique password.</p>`;
  } else {
    health.reusedGroups.forEach((group, i) => {
      const wrap = document.createElement("div");
      wrap.className = "issue-group";
      const label = document.createElement("p");
      label.className = "muted";
      label.textContent = `Shared password #${i + 1} — used by ${group.length} logins:`;
      wrap.appendChild(label);
      for (const e of group) wrap.appendChild(entryRow(e));
      reusedEl.appendChild(wrap);
    });
  }

  renderIssueList($("weak-list"), health.weak, "No weak passwords found.", (e) =>
    e.password.length < 8 ? "very short" : "short / low variety"
  );
  renderIssueList($("old-list"), health.old, "All passwords updated within the last year.", (e) => {
    const days = Math.floor((Date.now() - (e.updatedAt || 0)) / (24 * 60 * 60 * 1000));
    return `${Math.floor(days / 30)} months`;
  });
}

function renderTotpAudit() {
  const listEl = $("totp-list");
  listEl.innerHTML = "";
  if (!health.missingTotp.length) {
    listEl.innerHTML = `<p class="all-clear">✓ All logins have 2FA (TOTP) keys configured!</p>`;
    return;
  }
  for (const e of health.missingTotp) {
    listEl.appendChild(entryRow(e, "Missing 2FA", true));
  }
}

function setPill(el, count) {
  el.textContent = String(count);
  el.className = "pill " + (count ? "warn" : "good");
}

// ---- breach check (opt-in) ---------------------------------------------------
async function runBreachCheck() {
  const btn = $("breach-btn");
  const progress = $("breach-progress");
  const errEl = $("breach-error");
  btn.disabled = true;
  errEl.hidden = true;
  progress.hidden = false;

  try {
    const passwords = entries.map((e) => e.password);
    breachedByPassword = await pwnedCounts(passwords, (done, total) => {
      progress.textContent = `Checked ${done} of ${total} unique passwords…`;
    });
  } catch (e) {
    errEl.textContent = e.message || "Breach check failed — are you online?";
    errEl.hidden = false;
    btn.disabled = false;
    progress.hidden = true;
    return;
  }

  progress.hidden = true;
  btn.disabled = false;
  btn.textContent = "Check again";

  const hits = entries
    .map((e) => ({ entry: e, count: breachedByPassword.get(e.password) || 0 }))
    .filter((h) => h.count > 0)
    .sort((a, b) => b.count - a.count);

  const results = $("breach-results");
  const list = $("breach-list");
  results.hidden = false;
  list.innerHTML = "";
  if (!hits.length) {
    $("breach-headline").textContent = "✓ None of your passwords appear in known breaches.";
  } else {
    $("breach-headline").textContent =
      `⚠️ ${hits.length} login${hits.length > 1 ? "s use" : " uses"} a breached password — change ${hits.length > 1 ? "these" : "it"} now:`;
    for (const h of hits) {
      list.appendChild(
        entryRow(h.entry, `seen ${h.count.toLocaleString()}× in breaches`, true)
      );
    }
  }
  renderSummary();
}

// ---- recommendations ---------------------------------------------------------
async function loadOffers() {
  let data;
  try {
    const res = await fetch(chrome.runtime.getURL("src/security/offers.json"));
    data = await res.json();
  } catch {
    $("tab-offers").innerHTML = `<p class="muted">Recommendations unavailable.</p>`;
    return;
  }
  $("offers-disclosure").textContent = data.disclosure;
  const grid = $("offers-grid");
  for (const o of data.offers) {
    const card = document.createElement("div");
    card.className = "offer";
    card.innerHTML = `
      <span class="cat"></span>
      <span class="title"><span class="icon"></span><span class="t"></span></span>
      <span class="tagline"></span>
      <span class="benefit"></span>
      <a class="cta" target="_blank" rel="noopener noreferrer sponsored"></a>`;
    card.querySelector(".cat").textContent = o.category;
    card.querySelector(".icon").textContent = o.icon;
    card.querySelector(".t").textContent = o.title;
    card.querySelector(".tagline").textContent = o.tagline;
    card.querySelector(".benefit").textContent = o.benefit;
    const a = card.querySelector("a.cta");
    a.textContent = o.cta;
    a.href = o.url;
    grid.appendChild(card);
  }
}

// ---- tabs ---------------------------------------------------------------------
function wireTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const t of tabs) t.classList.toggle("active", t === tab);
      for (const p of document.querySelectorAll(".tabpanel")) {
        p.hidden = p.id !== "tab-" + tab.dataset.tab;
      }
    });
  }
}
