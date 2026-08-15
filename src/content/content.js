// content.js — login-form autofill + "save this login?" prompt.
// Self-contained (content scripts are not ES modules). UI is rendered inside a
// shadow root so the host page's CSS cannot affect it.

(function () {
  if (window.__drivepassLoaded) return;
  window.__drivepassLoaded = true;

  const send = (type, payload = {}) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (res) =>
        resolve(chrome.runtime.lastError ? { ok: false } : res)
      );
    });

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  };

  const passwordFields = () =>
    [...document.querySelectorAll('input[type="password"]')].filter(isVisible);

  function usernameFieldFor(pwField) {
    const scope = pwField.form || document;
    const cands = [...scope.querySelectorAll("input")].filter(
      (i) =>
        i !== pwField &&
        isVisible(i) &&
        ["text", "email", "tel", ""].includes((i.type || "").toLowerCase())
    );
    const preceding = cands.filter(
      (i) => pwField.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING
    );
    return (
      cands.find((i) => (i.autocomplete || "").includes("username")) ||
      cands.find((i) => (i.type || "").toLowerCase() === "email") ||
      preceding[preceding.length - 1] ||
      cands[0] ||
      null
    );
  }

  // Set a value in a way React/Vue controlled inputs notice.
  function setValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillCredentials(match) {
    const pw = passwordFields()[0];
    if (!pw) return;
    const user = usernameFieldFor(pw);
    if (user && match.username) setValue(user, match.username);
    setValue(pw, match.password || "");
  }

  // `matches` carries no secrets — ask for the password only once the user has
  // actually chosen an entry, so a password is in this script's memory for the
  // moment it takes to fill a field rather than for the life of the page.
  async function fillById(id, username) {
    const res = await send("GET_CREDENTIAL", { id });
    if (!res || !res.ok) {
      if (res && res.locked) alert("Unlock DrivePass first, then try again.");
      return;
    }
    fillCredentials({ username, ...res.credential });
  }

  // ---- shadow-root UI host -------------------------------------------------
  let host, root;
  function ui() {
    if (root) return root;
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;";
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .panel{position:fixed;background:#fff;color:#1f2330;border:1px solid #e5e7eb;
        border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);
        font:13px system-ui,sans-serif;overflow:hidden;min-width:220px}
      .row{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer}
      .row:hover{background:#f3f4f6}
      .row .k{font-size:15px}
      .name{font-weight:600}.sub{color:#6b7280;font-size:12px}
      .hdr{padding:7px 10px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:11px;
        display:flex;justify-content:space-between;align-items:center}
      .banner{position:fixed;right:16px;bottom:16px;min-width:260px}
      .banner .body{padding:12px 12px 6px}
      .banner .acts{display:flex;gap:8px;justify-content:flex-end;padding:0 10px 10px}
      button{font:13px system-ui;border-radius:7px;padding:6px 12px;cursor:pointer;border:1px solid #e5e7eb;background:#fff;color:#1f2330}
      button.p{background:#4f46e5;color:#fff;border-color:#4f46e5}
      .x{background:none;border:none;cursor:pointer;color:#6b7280;font-size:14px}
      @media (prefers-color-scheme: dark) {
        .panel { background:#1e293b; color:#f8fafc; border-color:#334155; }
        .row:hover { background:#334155; }
        .hdr { border-bottom-color:#334155; color:#94a3b8; }
        .sub { color:#94a3b8; }
        button { background:#1e293b; color:#f8fafc; border-color:#334155; }
        button:hover { background:#334155; }
        button.p { background:#4f46e5; color:#fff; border-color:#4f46e5; }
        .x { color:#94a3b8; }
        .x:hover { color:#f8fafc; }
      }
    `;
    root.appendChild(style);
    document.documentElement.appendChild(host);
    return root;
  }
  function clearUI() {
    if (!root) return;
    [...root.querySelectorAll(".panel,.banner")].forEach((n) => n.remove());
  }

  // ---- autofill dropdown ---------------------------------------------------
  let matches = [];
  function showDropdown(anchor) {
    if (!matches.length) return;
    clearUI();
    const r = ui();
    const rect = anchor.getBoundingClientRect();
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.style.left = Math.round(rect.left) + "px";
    panel.style.top = Math.round(rect.bottom + 4) + "px";
    panel.style.minWidth = Math.max(220, rect.width) + "px";
    panel.innerHTML = `<div class="hdr"><span>🔑 DrivePass</span><button class="x" data-x>✕</button></div>`;
    for (const m of matches) {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<span class="k">👤</span><span><div class="name"></div><div class="sub"></div></span>`;
      row.querySelector(".name").textContent = m.name || m.username;
      row.querySelector(".sub").textContent = m.username || "";
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        fillById(m.id, m.username);
        clearUI();
      });
      panel.appendChild(row);
    }
    panel.querySelector("[data-x]").addEventListener("click", clearUI);
    r.appendChild(panel);
  }

  function attachFocusHandlers() {
    document.addEventListener(
      "focusin",
      (e) => {
        const el = e.target;
        if (!(el instanceof HTMLInputElement)) return;
        const pw = passwordFields()[0];
        if (el === pw || (pw && el === usernameFieldFor(pw))) {
          if (matches.length) showDropdown(el);
        }
      },
      true
    );
    document.addEventListener(
      "mousedown",
      (e) => {
        if (host && !e.composedPath().includes(host)) clearUI();
      },
      true
    );
  }

  // ---- save prompt ---------------------------------------------------------
  function watchSubmits() {
    document.addEventListener(
      "submit",
      (e) => {
        const form = e.target;
        if (!(form instanceof HTMLFormElement)) return;
        const pw = [...form.querySelectorAll('input[type="password"]')][0];
        if (!pw || !pw.value) return;
        const user = usernameFieldFor(pw);
        send("STASH_PENDING", {
          url: location.href,
          username: user ? user.value : "",
          password: pw.value,
        });
      },
      true
    );
  }

  async function maybeShowSaveBanner() {
    // The service worker decides whether this credential is already stored —
    // it holds the vault, so the comparison happens there and no stored
    // password has to come back to the page to make it.
    const res = await send("GET_PENDING");
    const p = res && res.pending;
    if (!p) return;
    const r = ui();
    const banner = document.createElement("div");
    banner.className = "panel banner";
    banner.innerHTML = `
      <div class="hdr"><span>🔑 Save login to DrivePass?</span><button class="x" data-x>✕</button></div>
      <div class="body"><div class="name"></div><div class="sub"></div></div>
      <div class="acts"><button data-no>Not now</button><button class="p" data-yes>Save</button></div>`;
    banner.querySelector(".name").textContent = p.username || "(no username)";
    let hostLabel = p.url || "";
    try {
      hostLabel = new URL(p.url).hostname;
    } catch {
      /* ignore invalid URL */
    }
    banner.querySelector(".sub").textContent = hostLabel;
    const close = () => {
      send("CLEAR_PENDING");
      clearUI();
    };
    banner.querySelector("[data-x]").addEventListener("click", close);
    banner.querySelector("[data-no]").addEventListener("click", close);
    banner.querySelector("[data-yes]").addEventListener("click", async () => {
      const save = await send("SAVE_FROM_PAGE");
      if (save && save.locked) alert("Unlock DrivePass first, then try again.");
      close();
    });
    r.appendChild(banner);
  }

  // ---- init ----------------------------------------------------------------
  async function init() {
    const res = await send("GET_MATCHES", { url: location.href });
    matches = (res && res.matches) || [];
    attachFocusHandlers();
    watchSubmits();
    await maybeShowSaveBanner();

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "FILL_CREDENTIALS" && msg.match) {
        fillCredentials(msg.match);
      } else if (msg?.type === "CLEAR_CLIPBOARD") {
        // writeText rejects outright unless the document is focused, and an
        // unhandled rejection here shows up as an error on the user's page.
        //
        // KNOWN LIMITATION: we cannot tell whether the clipboard still holds
        // the password or something the user copied since — reading it back
        // would need the clipboardRead permission, which is a steep ask for
        // this. So the clear is skipped unless the copying tab is still the one
        // in front, which is the case where it is most likely still ours.
        if (document.hasFocus()) {
          navigator.clipboard.writeText("").catch(() => { /* not permitted here */ });
        }
      }
    });
  }
  init();
})();
