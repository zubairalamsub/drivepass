// The chrome/fetch harness in tests/helpers/chrome-mock.js is load-bearing for
// every suite that touches the background worker, so a defect in it shows up as
// a wrong assertion in some *other* file — usually one that looks like a real
// product bug. These tests pin the harness behaviours the other suites lean on:
// chrome's callback-vs-promise duality, storage returning snapshots rather than
// live references, message routing, request recording, and the install-then-
// import ordering that decides whether the worker's listeners exist at all.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  installChrome,
  installFetch,
  loadServiceWorker,
  reset,
  uninstall,
  flush,
} from "./helpers/chrome-mock.js";

afterEach(() => uninstall());

// Run a callback-style chrome API and resolve with what the callback saw,
// including chrome.runtime.lastError as it was *during* the callback.
const viaCallback = (invoke) =>
  new Promise((resolve) => {
    invoke((value) => resolve({ value, error: globalThis.chrome.runtime.lastError?.message }));
  });

// ---- storage ---------------------------------------------------------------

test("the fake chrome is installed on globalThis, where the source expects it", () => {
  const h = installChrome();
  assert.equal(globalThis.chrome, h.chrome);
  uninstall();
  assert.equal("chrome" in globalThis, false);
});

test("storage round-trips a value between set and get", async () => {
  const h = installChrome();
  await h.chrome.storage.local.set({ cfg: { autoLockMinutes: 5 } });
  assert.deepEqual(await h.chrome.storage.local.get("cfg"), { cfg: { autoLockMinutes: 5 } });
  assert.deepEqual(h.local.cfg, { autoLockMinutes: 5 }, "the backing store should be inspectable");
});

test("a key that was never set comes back absent, not present-and-undefined", async () => {
  // getConfig() destructures `const { cfg } = await get("cfg")`, so a mock that
  // invented the key would still work — but `key in result` checks elsewhere
  // would quietly change meaning.
  const h = installChrome();
  assert.deepEqual(await h.chrome.storage.local.get("cache_file"), {});
});

test("get accepts a string, an array, and an object of defaults", async () => {
  const h = installChrome().seed({ local: { a: 1, b: 2 } });
  assert.deepEqual(await h.chrome.storage.local.get("a"), { a: 1 });
  assert.deepEqual(await h.chrome.storage.local.get(["a", "b", "missing"]), { a: 1, b: 2 });
  assert.deepEqual(await h.chrome.storage.local.get({ a: 99, missing: "fallback" }), {
    a: 1,
    missing: "fallback",
  });
  assert.deepEqual(await h.chrome.storage.local.get(null), { a: 1, b: 2 });
});

test("a value read out of storage is a snapshot, not a live reference", async () => {
  // Real chrome structured-clones on the way out. Handing back the stored
  // object would make "mutate it and forget to write it back" bugs pass.
  const h = installChrome().seed({ local: { pin_config: { failedAttempts: 0 } } });
  const { pin_config } = await h.chrome.storage.local.get("pin_config");
  pin_config.failedAttempts = 4;
  assert.equal(h.local.pin_config.failedAttempts, 0);
  assert.equal((await h.chrome.storage.local.get("pin_config")).pin_config.failedAttempts, 0);
});

test("storage works in callback style as well as promise style", async () => {
  // drive.js and the worker await storage; older callback-style call sites and
  // any future ones must not hang.
  const h = installChrome();
  const setResult = h.chrome.storage.session.set({ sess_rawKey: "k" }, () => {});
  assert.equal(setResult, undefined, "the callback form must not also return a promise");
  const { value } = await viaCallback((cb) => h.chrome.storage.session.get("sess_rawKey", cb));
  assert.deepEqual(value, { sess_rawKey: "k" });
});

test("local and session storage are separate areas", async () => {
  const h = installChrome();
  await h.chrome.storage.local.set({ k: "local" });
  await h.chrome.storage.session.set({ k: "session" });
  assert.deepEqual(await h.chrome.storage.local.get("k"), { k: "local" });
  assert.deepEqual(await h.chrome.storage.session.get("k"), { k: "session" });
});

test("removing a key notifies storage.onChanged with the old value", async () => {
  // theme.js reacts to onChanged to keep pages in sync; nothing else exercises it.
  const h = installChrome().seed({ local: { theme: "dark" } });
  const seen = [];
  h.chrome.storage.onChanged.addListener((changes, area) => seen.push({ changes, area }));

  await h.chrome.storage.local.remove("theme");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].area, "local");
  assert.deepEqual(seen[0].changes.theme, { oldValue: "dark", newValue: undefined });
});

test("writes are logged in order so a suite can assert what was persisted", async () => {
  const h = installChrome();
  await h.chrome.storage.local.set({ cache_file: { iv: "x" } });
  await h.chrome.storage.session.remove("sess_rawKey");
  assert.deepEqual(
    h.records.storage.map((r) => `${r.area}:${r.op}:${r.keys.join(",")}`),
    ["local:set:cache_file", "session:remove:sess_rawKey"]
  );
});

// ---- runtime messaging -----------------------------------------------------

test("sendMessage reaches an onMessage listener that replies synchronously", async () => {
  const h = installChrome();
  h.chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    sendResponse({ echoed: msg.type });
  });
  assert.deepEqual(await h.chrome.runtime.sendMessage({ type: "PING" }), { echoed: "PING" });
});

test("sendMessage waits for a listener that returns true and replies later", async () => {
  // This is exactly how service-worker.js answers every message; a mock that
  // resolved at the end of the listener would return undefined for all of them.
  const h = installChrome();
  h.chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    Promise.resolve().then(() => sendResponse({ ok: true, type: msg.type }));
    return true;
  });
  assert.deepEqual(await h.send({ type: "STATUS" }), { ok: true, type: "STATUS" });
});

test("a listener sees the sender it was dispatched with", async () => {
  // Handlers that gate secrets read the host off the browser-reported sender,
  // never off the message body, so suites must be able to forge one.
  const h = installChrome();
  let received;
  h.chrome.runtime.onMessage.addListener((_msg, sender, sendResponse) => {
    received = sender;
    sendResponse({ ok: true });
  });
  await h.send({ type: "GET_CREDENTIAL" }, h.tabSender("https://example.com/login", 7));
  assert.equal(received.origin, "https://example.com");
  assert.equal(received.tab.id, 7);
});

test("with nothing listening, sendMessage reports lastError instead of throwing", async () => {
  // The popup's send() wrapper checks lastError to render "extension asleep"
  // rather than crashing, so the mock has to reproduce that shape.
  const h = installChrome();
  const { value, error } = await viaCallback((cb) => h.chrome.runtime.sendMessage({ type: "STATUS" }, cb));
  assert.equal(value, undefined);
  assert.match(error, /Receiving end does not exist/);
});

test("lastError is cleared again once the callback returns", async () => {
  const h = installChrome();
  await viaCallback((cb) => h.chrome.runtime.sendMessage({ type: "STATUS" }, cb));
  assert.equal(h.chrome.runtime.lastError, undefined, "a stale lastError would poison the next call");
});

test("getURL produces a parseable extension URL", () => {
  // popup.js does `new URL(chrome.runtime.getURL("/_favicon/"))`, which throws
  // on anything relative.
  const h = installChrome();
  assert.equal(new URL(h.chrome.runtime.getURL("/_favicon/")).pathname, "/_favicon/");
  assert.match(h.chrome.runtime.getURL("src/options/options.html"), /^chrome-extension:\/\/[a-z]+\/src\//);
});

// ---- alarms, tabs, badge ---------------------------------------------------

test("alarms are recorded, cleared, and can be fired at their listener", async () => {
  const h = installChrome();
  const fired = [];
  h.chrome.alarms.onAlarm.addListener((alarm) => fired.push(alarm.name));

  h.chrome.alarms.create("drivepass-autolock", { delayInMinutes: 15 });
  assert.deepEqual(h.alarms.get("drivepass-autolock"), { delayInMinutes: 15 });

  await h.fireAlarm("drivepass-autolock");
  assert.deepEqual(fired, ["drivepass-autolock"]);

  assert.equal(await h.chrome.alarms.clear("drivepass-autolock"), true);
  assert.equal(h.alarms.size, 0);
});

test("firing an event drains work the handler started without awaiting it", async () => {
  // The worker's alarm handler calls lock() fire-and-forget. Awaiting only the
  // listener would let a suite assert "still unlocked" a tick too early, so the
  // fire* helpers flush before they resolve.
  const h = installChrome().seed({ session: { sess_rawKey: "k" } });
  h.chrome.alarms.onAlarm.addListener(() => {
    Promise.resolve().then(() => h.chrome.storage.session.remove("sess_rawKey"));
  });

  await h.fireAlarm("drivepass-autolock");
  assert.deepEqual(await h.chrome.storage.session.get(null), {});
});

test("flush is exported for background work no event helper triggered", async () => {
  // handleUnlock kicks off a Drive sync it never awaits; suites need a way to
  // let it finish before asserting on what got written.
  const h = installChrome();
  let ran = false;
  Promise.resolve().then(() => h.chrome.storage.local.set({ done: true })).then(() => (ran = true));
  await flush();
  assert.equal(ran, true);
  assert.equal(h.local.done, true);
});

test("tabs.query honours active/currentWindow the way the worker uses it", async () => {
  const h = installChrome().setTabs([
    { id: 1, url: "https://a.test/", active: false },
    { id: 2, url: "https://b.test/", active: true },
    { id: 3, url: "https://c.test/", active: true, windowId: 99 },
  ]);
  const found = await h.chrome.tabs.query({ active: true, currentWindow: true });
  assert.deepEqual(found.map((t) => t.id), [2]);
});

test("tabs.get rejects for a tab that no longer exists", async () => {
  // The worker's onActivated handler relies on this rejection to skip closed tabs.
  const h = installChrome().setTabs([{ id: 1, url: "https://a.test/" }]);
  await assert.rejects(() => h.chrome.tabs.get(404), /No tab with id/);
});

test("messages sent to a tab are recorded, and the responder can refuse", async () => {
  const h = installChrome();
  h.chrome.tabs.sendMessage(3, { type: "CLEAR_CLIPBOARD" });
  assert.deepEqual(h.records.tabMessages, [{ tabId: 3, message: { type: "CLEAR_CLIPBOARD" } }]);

  h.setTabMessageResponder(() => {
    throw new Error("Could not establish connection.");
  });
  await assert.rejects(() => h.chrome.tabs.sendMessage(3, { type: "FILL_CREDENTIALS" }), /connection/);
});

test("badge writes are recorded per tab", async () => {
  const h = installChrome();
  await h.chrome.action.setBadgeText({ text: "2", tabId: 5 });
  await h.chrome.action.setBadgeText({ text: "", tabId: 6 });
  await h.chrome.action.setBadgeBackgroundColor({ color: "#6366f1", tabId: 5 });
  assert.equal(h.badgeTextFor(5), "2");
  assert.equal(h.badgeTextFor(6), "");
  assert.equal(h.badgeTextFor(7), undefined);
  assert.deepEqual(h.records.badgeColor, [{ color: "#6366f1", tabId: 5 }]);
});

// ---- identity --------------------------------------------------------------

test("getAuthToken hands the token to its callback", async () => {
  const h = installChrome();
  h.state.identity.token = "ya29.fake";
  const { value, error } = await viaCallback((cb) => h.chrome.identity.getAuthToken({ interactive: false }, cb));
  assert.equal(value, "ya29.fake");
  assert.equal(error, undefined);
  assert.deepEqual(h.records.getAuthToken, [{ interactive: false }]);
});

test("a refused token surfaces through lastError, not a rejection", async () => {
  // drive.js reads chrome.runtime.lastError inside the callback; a rejecting
  // mock would leave that branch untested.
  const h = installChrome();
  h.state.identity.error = "OAuth2 not granted or revoked.";
  const { value, error } = await viaCallback((cb) => h.chrome.identity.getAuthToken({ interactive: false }, cb));
  assert.equal(value, undefined);
  assert.match(error, /not granted/);
});

test("queued tokens let a suite drive the 401-then-refresh path", async () => {
  const h = installChrome();
  h.state.identity.tokenQueue = ["stale", "fresh"];
  const first = await viaCallback((cb) => h.chrome.identity.getAuthToken({ interactive: false }, cb));
  const second = await viaCallback((cb) => h.chrome.identity.getAuthToken({ interactive: false }, cb));
  assert.equal(first.value, "stale");
  assert.equal(second.value, "fresh");
});

test("emulateEdge removes getAuthToken so the web-auth-flow fallback is reachable", () => {
  // drive.js switches on `typeof chrome.identity.getAuthToken !== "function"`.
  const h = installChrome().emulateEdge();
  assert.equal(typeof h.chrome.identity.getAuthToken, "undefined");
  assert.match(h.chrome.identity.getRedirectURL("cb"), /^https:\/\/.+\.chromiumapp\.org\/cb$/);
});

// ---- fetch -----------------------------------------------------------------

test("every request is recorded with its url, method, headers and body", async () => {
  const net = installFetch();
  net.on("*", { json: { id: "f1" } });

  // Built the way drive.js builds it: a real Headers instance, not a literal.
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("Authorization", "Bearer ya29.fake");
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=media", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ ciphertext: "…" }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "f1" });

  const req = net.lastRequest;
  assert.equal(req.method, "PATCH");
  assert.equal(req.headers.authorization, "Bearer ya29.fake");
  assert.equal(req.headers["content-type"], "application/json");
  assert.deepEqual(req.json(), { ciphertext: "…" });
});

test("responses are matched per URL pattern, not first-come", async () => {
  const net = installFetch();
  net.on("/drive/v3/files?q=", { json: { files: [] } });
  net.on(/\/about\?/, { json: { user: { emailAddress: "z@example.com" } } });

  const about = await (await fetch("https://www.googleapis.com/drive/v3/about?fields=user")).json();
  const search = await (await fetch("https://www.googleapis.com/drive/v3/files?q=name")).json();
  assert.equal(about.user.emailAddress, "z@example.com");
  assert.deepEqual(search.files, []);
});

test("queued responses are consumed in order before the standing one", async () => {
  // The retry paths need "fail once, then succeed" without rewriting the rule
  // between calls.
  const net = installFetch();
  net.on("*", { status: 200, json: { attempt: "standing" } });
  net.queue("*", { status: 401 }, { status: 200, json: { attempt: "second" } });

  assert.equal((await fetch("https://x.test/1")).status, 401);
  assert.deepEqual(await (await fetch("https://x.test/2")).json(), { attempt: "second" });
  assert.deepEqual(await (await fetch("https://x.test/3")).json(), { attempt: "standing" });
});

test("a text response and a non-2xx status come through intact", async () => {
  const net = installFetch();
  net.on("pwnedpasswords", { status: 200, text: "0018A45C4D1DEF81644B54AB7F969B88D65:1\n" });
  net.on("teapot", { status: 418, text: "no" });

  const ok = await fetch("https://api.pwnedpasswords.com/range/21BD1");
  assert.equal(ok.ok, true);
  assert.match(await ok.text(), /^0018A45C/);

  const bad = await fetch("https://x.test/teapot");
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 418);
});

test("a response can be computed from the request", async () => {
  const net = installFetch();
  net.on("/echo", (req) => ({ json: { sawMethod: req.method } }));
  const res = await fetch("https://x.test/echo", { method: "DELETE" });
  assert.deepEqual(await res.json(), { sawMethod: "DELETE" });
});

test("throws simulates an offline network rather than an HTTP error", async () => {
  const net = installFetch();
  net.on("*", { throws: "Failed to fetch" });
  await assert.rejects(() => fetch("https://x.test/"), /Failed to fetch/);
});

test("an unmocked request fails loudly and is listed under net.unmatched", async () => {
  // Several worker paths swallow network errors as "offline". Without a record,
  // a forgotten mock would look like the offline branch working correctly.
  const net = installFetch();
  await assert.rejects(() => fetch("https://x.test/forgotten"), /no response registered/);
  assert.deepEqual(net.unmatched.map((r) => r.url), ["https://x.test/forgotten"]);
});

// ---- reset -----------------------------------------------------------------

test("reset clears storage, records, listeners and queued responses", async () => {
  const h = installChrome().seed({ local: { cfg: { autoLockMinutes: 1 } } });
  const net = installFetch();
  net.queue("*", { json: { a: 1 } });
  await fetch("https://x.test/a");
  h.chrome.alarms.create("drivepass-autolock", { delayInMinutes: 15 });
  h.chrome.runtime.onMessage.addListener(() => true);

  reset();

  assert.deepEqual(await h.chrome.storage.local.get(null), {});
  assert.deepEqual(net.requests, []);
  assert.equal(h.alarms.size, 0);
  assert.deepEqual(h.records.alarmsCreated, []);
  assert.equal(h.listeners.message.length, 0, "a leftover listener would answer the next suite's messages");
  await assert.rejects(() => fetch("https://x.test/a"), /no response registered/);
});

// ---- the install-then-import dance -----------------------------------------

test("loadServiceWorker registers the worker's listeners against the mock", async () => {
  // The worker calls addListener while its module body runs. If the mock were
  // installed after the import, this STATUS would time out with no listener.
  const env = await loadServiceWorker();
  assert.ok(env.mock.listeners.message.length > 0, "onMessage listener was never registered");

  const status = await env.send({ type: "STATUS" });
  assert.deepEqual(status, {
    connected: false,
    email: null,
    locked: true,
    hasVault: false,
    hasPin: false,
    count: 0,
    autoLockMinutes: 15,
  });
  assert.deepEqual(env.net.requests, [], "a local, unconnected vault must not touch the network");
});

test("each load of the service worker starts from clean module state", async () => {
  // The worker keeps the session key in a module-level variable, so reusing a
  // cached module would carry an unlocked vault into the next test.
  const first = await loadServiceWorker();
  assert.equal((await first.send({ type: "CREATE_VAULT", password: "correct horse battery" })).ok, true);
  assert.equal((await first.send({ type: "STATUS" })).locked, false);
  assert.deepEqual(first.mock.alarms.get("drivepass-autolock"), { delayInMinutes: 15 });

  const second = await loadServiceWorker();
  assert.equal((await second.send({ type: "STATUS" })).locked, true, "the in-memory key leaked between loads");
});

test("the two mocks work together across a real Drive round-trip", async () => {
  // Proves the chain the other suites depend on: message -> worker -> drive.js
  // -> chrome.identity for a token -> fetch -> back into chrome.storage.
  const env = await loadServiceWorker();
  env.mock.seed({ local: { cfg: { driveConnected: true, email: "z@example.com" } } });
  env.mock.state.identity.token = "ya29.fake";

  const remoteFile = { format: "drivepass-v1", iv: "aXY=", ciphertext: "Y3Q=" };
  env.net.on("/drive/v3/files?q=", { json: { files: [{ id: "file-1", modifiedTime: "2026-01-01T00:00:00Z" }] } });
  env.net.on("/files/file-1?alt=media", { json: remoteFile });

  const status = await env.send({ type: "STATUS" });

  assert.deepEqual(env.net.unmatched, [], "an unmatched request would be swallowed as 'offline'");
  assert.equal(status.hasVault, true);
  assert.equal(status.connected, true);
  assert.equal(status.locked, true, "finding a vault must not unlock it");
  assert.deepEqual(env.local.cache_file, remoteFile);
  assert.equal(env.local.cache_fileId, "file-1");
  for (const req of env.net.requests) {
    assert.equal(req.headers.authorization, "Bearer ya29.fake", `${req.url} went out unauthenticated`);
  }
});
