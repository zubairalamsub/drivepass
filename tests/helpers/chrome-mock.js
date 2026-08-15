// A fake `chrome` extension API plus a recording `fetch`, shared by every suite
// that tests code living outside the pure functions in src/lib.
//
// Why one shared harness instead of ad-hoc stubs per suite:
//
//   1. The background worker touches ~20 different chrome.* APIs, and a stub
//      that covers only what one suite expects fails with a TypeError from an
//      unrelated line the moment the worker takes a different branch. That
//      reads like a product bug and isn't one.
//   2. The same API is used both callback-style (chrome.identity.getAuthToken,
//      chrome.runtime.sendMessage from the popup) and promise-style
//      (chrome.storage.* from the worker). A mock that supports only one style
//      silently hangs the other.
//   3. service-worker.js registers its listeners at MODULE TOP LEVEL. Import it
//      before the mock is installed and the listeners attach to nothing, so
//      every message "times out" for reasons invisible in the test.
//
// (3) is the one that bites hardest, so read this before writing a suite:
//
//   import { loadServiceWorker, reset } from "./helpers/chrome-mock.js";
//
//   let env;
//   beforeEach(async () => { env = await loadServiceWorker(); });
//   afterEach(() => reset());
//
//   const status = await env.send({ type: "STATUS" });
//
// `env.mock` is the harness (seed/records/fire*), `env.chrome` is the fake API
// object the source code sees, and `env.net` is the fetch harness.
//
// loadServiceWorker() installs both mocks and THEN dynamically imports the
// worker with a cache-busting query, so each test gets a worker with fresh
// module state (session key, cached vault, badge cache) wired to a fresh mock.
// Never add a static `import "../src/background/service-worker.js"` to a suite.

const REPO_ROOT = new URL("../../", import.meta.url);

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

// chrome.storage round-trips values through structured clone, so what a caller
// gets back is a snapshot, not a live reference into the store. Preserving that
// matters: code that mutates a fetched object and forgets to write it back is a
// real bug, and a mock handing out live references would hide it.
function snapshot(value) {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    return value; // non-cloneable (e.g. a CryptoKey a test seeded on purpose)
  }
}

// chrome invokes callbacks asynchronously. queueMicrotask rather than
// Promise.then so a throwing callback surfaces as an uncaught exception the
// test runner attributes to the test, not as an unhandled rejection.
function defer(fn) {
  queueMicrotask(fn);
}

/**
 * Wait one macrotask, which drains any promise chain not parked on a timer.
 *
 * Several worker handlers start async work and deliberately don't await it —
 * the alarm listener calls lock() fire-and-forget, and handleUnlock kicks off
 * a background sync. Awaiting the thing that triggered them is therefore not
 * enough to see their effects. The fire* helpers below flush for you; call this
 * yourself after a send() that starts background work.
 */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeEvent(store) {
  return {
    addListener: (fn) => {
      if (!store.includes(fn)) store.push(fn);
    },
    removeListener: (fn) => {
      const i = store.indexOf(fn);
      if (i >= 0) store.splice(i, 1);
    },
    hasListener: (fn) => store.includes(fn),
    hasListeners: () => store.length > 0,
  };
}

// ---------------------------------------------------------------------------
// chrome mock
// ---------------------------------------------------------------------------

const DEFAULT_MANIFEST = {
  manifest_version: 3,
  name: "DrivePass — Password Manager",
  version: "1.0.0",
  oauth2: {
    client_id: "test-client-id.apps.googleusercontent.com",
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  },
};

const EXTENSION_ID = "drivepassmockextensionidaaaaaaaa";

let installedChrome = null;
let previousChrome;
let hadPreviousChrome = false;

/**
 * Install a fake `chrome` on globalThis. Returns a harness for seeding state
 * and making assertions. Calling it again replaces any previous install.
 */
export function installChrome(options = {}) {
  if (installedChrome) installedChrome.uninstall();

  const local = {};
  const session = {};

  const listeners = {
    message: [],
    alarm: [],
    tabActivated: [],
    tabUpdated: [],
    tabRemoved: [],
    idle: [],
    command: [],
    storageChanged: [],
  };

  const records = {
    storage: [], // { area, op, keys, items }
    badgeText: [], // { text, tabId }
    badgeColor: [], // { color, tabId }
    alarmsCreated: [], // { name, info }
    alarmsCleared: [], // name
    tabMessages: [], // { tabId, message }
    tabsCreated: [], // createProperties
    getAuthToken: [], // { interactive }
    removedTokens: [], // token
    webAuthFlows: [], // { url, interactive }
    openOptionsPage: 0,
  };

  const state = {
    tabs: [],
    currentWindowId: 1,
    activeAlarms: new Map(),
    tabMessageResponder: null,
    // Resolve/reject behaviour for chrome.identity.
    identity: {
      token: "test-access-token",
      tokenQueue: [],
      error: null, // string -> reported through chrome.runtime.lastError
      requireInteractive: false,
      redirectUrl: null, // what launchWebAuthFlow hands back
      redirectBase: `https://${EXTENSION_ID}.chromiumapp.org/`,
    },
    manifest: options.manifest ? snapshot(options.manifest) : snapshot(DEFAULT_MANIFEST),
    responseTimeoutMs: options.responseTimeoutMs ?? 5000,
    defaultSender: { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/src/popup/popup.html` },
  };

  // ---- storage ------------------------------------------------------------

  function fireStorageChanged(changes, areaName) {
    if (!Object.keys(changes).length) return;
    for (const fn of [...listeners.storageChanged]) fn(changes, areaName);
  }

  function makeArea(areaName, store) {
    function select(keys) {
      if (keys === null || keys === undefined) {
        const out = {};
        for (const k of Object.keys(store)) out[k] = snapshot(store[k]);
        return out;
      }
      if (typeof keys === "string") keys = [keys];
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in store) out[k] = snapshot(store[k]);
        return out;
      }
      // Object form: the values are defaults for keys that are absent.
      const out = {};
      for (const [k, dflt] of Object.entries(keys)) out[k] = k in store ? snapshot(store[k]) : dflt;
      return out;
    }

    // Every method accepts an optional trailing callback; with one it returns
    // undefined (chrome's callback style), without one it returns a Promise.
    function settle(callback, produce) {
      if (typeof callback === "function") {
        defer(() => callback(produce()));
        return undefined;
      }
      return Promise.resolve().then(produce);
    }

    return {
      get(keys, callback) {
        if (typeof keys === "function") [keys, callback] = [null, keys];
        return settle(callback, () => select(keys));
      },
      set(items, callback) {
        return settle(callback, () => {
          const changes = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: snapshot(store[k]), newValue: snapshot(v) };
            store[k] = snapshot(v);
          }
          records.storage.push({ area: areaName, op: "set", keys: Object.keys(items), items: snapshot(items) });
          fireStorageChanged(changes, areaName);
          return undefined;
        });
      },
      remove(keys, callback) {
        const list = Array.isArray(keys) ? keys : [keys];
        return settle(callback, () => {
          const changes = {};
          for (const k of list) {
            if (!(k in store)) continue;
            changes[k] = { oldValue: snapshot(store[k]), newValue: undefined };
            delete store[k];
          }
          records.storage.push({ area: areaName, op: "remove", keys: list });
          fireStorageChanged(changes, areaName);
          return undefined;
        });
      },
      clear(callback) {
        return settle(callback, () => {
          const changes = {};
          for (const k of Object.keys(store)) {
            changes[k] = { oldValue: snapshot(store[k]), newValue: undefined };
            delete store[k];
          }
          records.storage.push({ area: areaName, op: "clear", keys: Object.keys(changes) });
          fireStorageChanged(changes, areaName);
          return undefined;
        });
      },
      getBytesInUse: (_keys, callback) => (callback ? (defer(() => callback(0)), undefined) : Promise.resolve(0)),
    };
  }

  // ---- runtime.sendMessage routing ---------------------------------------

  // Drive a message through the registered onMessage listeners the way chrome
  // does, including the `return true` / async-sendResponse contract the worker
  // relies on.
  function dispatchMessage(message, sender) {
    return new Promise((resolve, reject) => {
      const targets = [...listeners.message];
      if (!targets.length) {
        reject(new Error("Could not establish connection. Receiving end does not exist."));
        return;
      }

      let settled = false;
      let timer = null;
      const finish = (fn) => (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };
      const ok = finish(resolve);
      const fail = finish(reject);

      let keepChannelOpen = false;
      for (const listener of targets) {
        let returned;
        try {
          returned = listener(message, sender, ok);
        } catch (err) {
          fail(err);
          return;
        }
        if (returned === true) keepChannelOpen = true;
        else if (returned && typeof returned.then === "function") {
          keepChannelOpen = true;
          returned.then(ok, fail);
        }
      }

      if (settled) return;
      if (!keepChannelOpen) {
        fail(new Error("The message port closed before a response was received."));
        return;
      }
      // A listener that promises a response and never sends one would hang the
      // whole run, so bound the wait and say why.
      timer = setTimeout(() => {
        fail(
          new Error(
            `No listener answered ${JSON.stringify(message?.type ?? message)} within ` +
              `${state.responseTimeoutMs}ms (a listener returned true but never called sendResponse).`
          )
        );
      }, state.responseTimeoutMs);
    });
  }

  // ---- identity -----------------------------------------------------------

  function nextToken() {
    if (state.identity.tokenQueue.length) return state.identity.tokenQueue.shift();
    return state.identity.token;
  }

  function withLastError(message, fn) {
    chrome.runtime.lastError = message ? { message } : undefined;
    try {
      fn();
    } finally {
      chrome.runtime.lastError = undefined;
    }
  }

  // ---- the object itself ---------------------------------------------------

  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      getManifest: () => snapshot(state.manifest),
      getURL: (path = "") => `chrome-extension://${EXTENSION_ID}/${String(path).replace(/^\/+/, "")}`,
      openOptionsPage: (callback) => {
        records.openOptionsPage++;
        if (callback) return defer(callback), undefined;
        return Promise.resolve();
      },
      sendMessage: (...args) => {
        const message = typeof args[0] === "string" && args.length > 1 ? args[1] : args[0];
        const callback = args.find((a) => typeof a === "function");
        const promise = dispatchMessage(message, state.defaultSender);
        if (!callback) return promise;
        promise.then(
          (res) => withLastError(null, () => callback(res)),
          (err) => withLastError(err.message, () => callback(undefined))
        );
        return undefined;
      },
      onMessage: makeEvent(listeners.message),
      onInstalled: makeEvent([]),
      onStartup: makeEvent([]),
    },

    storage: {
      local: makeArea("local", local),
      session: makeArea("session", session),
      sync: makeArea("sync", {}),
      onChanged: makeEvent(listeners.storageChanged),
    },

    alarms: {
      create: (name, info) => {
        records.alarmsCreated.push({ name, info: snapshot(info) });
        state.activeAlarms.set(name, snapshot(info));
      },
      clear: (name, callback) => {
        const existed = state.activeAlarms.delete(name);
        records.alarmsCleared.push(name);
        if (callback) return defer(() => callback(existed)), undefined;
        return Promise.resolve(existed);
      },
      clearAll: (callback) => {
        state.activeAlarms.clear();
        if (callback) return defer(() => callback(true)), undefined;
        return Promise.resolve(true);
      },
      get: (name, callback) => {
        const info = state.activeAlarms.get(name);
        const alarm = info ? { name, ...info } : undefined;
        if (callback) return defer(() => callback(alarm)), undefined;
        return Promise.resolve(alarm);
      },
      getAll: (callback) => {
        const all = [...state.activeAlarms].map(([name, info]) => ({ name, ...info }));
        if (callback) return defer(() => callback(all)), undefined;
        return Promise.resolve(all);
      },
      onAlarm: makeEvent(listeners.alarm),
    },

    tabs: {
      query: (info = {}, callback) => {
        const result = state.tabs
          .filter((t) => (info.active === undefined ? true : !!t.active === !!info.active))
          .filter((t) => (info.currentWindow ? (t.windowId ?? 1) === state.currentWindowId : true))
          .filter((t) => (info.url ? t.url === info.url : true))
          .map(snapshot);
        if (callback) return defer(() => callback(result)), undefined;
        return Promise.resolve(result);
      },
      get: (tabId, callback) => {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (callback) {
          return (
            defer(() => withLastError(tab ? null : `No tab with id: ${tabId}.`, () => callback(snapshot(tab)))),
            undefined
          );
        }
        return tab ? Promise.resolve(snapshot(tab)) : Promise.reject(new Error(`No tab with id: ${tabId}.`));
      },
      create: (props = {}, callback) => {
        records.tabsCreated.push(snapshot(props));
        const tab = { id: state.tabs.length + 100, windowId: state.currentWindowId, active: true, ...props };
        state.tabs.push(tab);
        if (callback) return defer(() => callback(snapshot(tab))), undefined;
        return Promise.resolve(snapshot(tab));
      },
      sendMessage: (tabId, message, ...rest) => {
        records.tabMessages.push({ tabId, message: snapshot(message) });
        const callback = rest.find((a) => typeof a === "function");
        const run = async () => {
          if (state.tabMessageResponder) return state.tabMessageResponder(tabId, message);
          return undefined;
        };
        const promise = run();
        if (!callback) return promise;
        promise.then(
          (res) => withLastError(null, () => callback(res)),
          (err) => withLastError(err.message, () => callback(undefined))
        );
        return undefined;
      },
      onActivated: makeEvent(listeners.tabActivated),
      onUpdated: makeEvent(listeners.tabUpdated),
      onRemoved: makeEvent(listeners.tabRemoved),
    },

    action: {
      setBadgeText: (details = {}) => {
        records.badgeText.push(snapshot(details));
        return Promise.resolve();
      },
      setBadgeBackgroundColor: (details = {}) => {
        records.badgeColor.push(snapshot(details));
        return Promise.resolve();
      },
      setTitle: () => Promise.resolve(),
      setIcon: () => Promise.resolve(),
    },

    identity: {
      getAuthToken: ({ interactive } = {}, callback) => {
        records.getAuthToken.push({ interactive: !!interactive });
        const failure =
          state.identity.error ||
          (state.identity.requireInteractive && !interactive ? "OAuth2 not granted or revoked." : null);
        const token = failure ? undefined : nextToken();
        if (!callback) return failure ? Promise.reject(new Error(failure)) : Promise.resolve(token);
        defer(() => withLastError(failure, () => callback(token)));
        return undefined;
      },
      removeCachedAuthToken: ({ token } = {}, callback) => {
        records.removedTokens.push(token);
        if (callback) return defer(() => callback()), undefined;
        return Promise.resolve();
      },
      launchWebAuthFlow: ({ url, interactive } = {}, callback) => {
        records.webAuthFlows.push({ url, interactive: !!interactive });
        const redirect = state.identity.redirectUrl;
        const failure = redirect ? null : state.identity.error || "The user did not approve access.";
        if (!callback) return failure ? Promise.reject(new Error(failure)) : Promise.resolve(redirect);
        defer(() => withLastError(failure, () => callback(redirect ?? undefined)));
        return undefined;
      },
      getRedirectURL: (path = "") => state.identity.redirectBase + String(path).replace(/^\/+/, ""),
    },

    idle: {
      onStateChanged: makeEvent(listeners.idle),
      queryState: (_s, callback) => (callback ? (defer(() => callback("active")), undefined) : Promise.resolve("active")),
      setDetectionInterval: () => {},
    },

    commands: {
      onCommand: makeEvent(listeners.command),
      getAll: (callback) => (callback ? (defer(() => callback([])), undefined) : Promise.resolve([])),
    },

    scripting: {
      executeScript: () => Promise.resolve([]),
    },
  };

  const harness = {
    chrome,
    /** Raw backing objects for chrome.storage.local / .session. Safe to read
     *  and to seed directly; identity is stable across reset(). */
    local,
    session,
    listeners,
    records,
    state,

    /** Seed storage without going through the async API. */
    seed({ local: l = {}, session: s = {} } = {}) {
      for (const [k, v] of Object.entries(l)) local[k] = snapshot(v);
      for (const [k, v] of Object.entries(s)) session[k] = snapshot(v);
      return harness;
    },

    /** Send a message to the worker's onMessage listener and await its reply.
     *  `sender` defaults to an extension page (no tab, no origin). */
    send: (message, sender = state.defaultSender) => dispatchMessage(message, sender),
    dispatchMessage: (message, sender = state.defaultSender) => dispatchMessage(message, sender),

    /** A sender object shaped like the one chrome gives a content script, for
     *  handlers that derive the requesting host from the sender rather than
     *  from the message body. */
    tabSender(url, tabId = 1) {
      return { id: EXTENSION_ID, origin: new URL(url).origin, tab: { id: tabId, url } };
    },

    setTabs(tabs) {
      state.tabs.length = 0;
      for (const t of tabs) state.tabs.push({ windowId: state.currentWindowId, ...t });
      return harness;
    },
    addTab(tab) {
      state.tabs.push({ id: state.tabs.length + 1, windowId: state.currentWindowId, ...tab });
      return harness;
    },
    /** Control what chrome.tabs.sendMessage does: return a value, or throw to
     *  simulate a page with no content script. */
    setTabMessageResponder(fn) {
      state.tabMessageResponder = fn;
      return harness;
    },

    /** Fire the events the worker subscribes to at import time. Each awaits the
     *  listeners and then flushes, so work a handler started without awaiting
     *  has also finished by the time the call resolves. */
    async fireAlarm(name) {
      await Promise.all([...listeners.alarm].map((fn) => fn({ name, scheduledTime: Date.now() })));
      await flush();
    },
    async fireTabActivated(tabId, windowId = state.currentWindowId) {
      await Promise.all([...listeners.tabActivated].map((fn) => fn({ tabId, windowId })));
      await flush();
    },
    async fireTabUpdated(tabId, changeInfo, tab) {
      await Promise.all([...listeners.tabUpdated].map((fn) => fn(tabId, changeInfo, tab)));
      await flush();
    },
    async fireIdle(newState) {
      await Promise.all([...listeners.idle].map((fn) => fn(newState)));
      await flush();
    },
    async fireCommand(command, tab) {
      await Promise.all([...listeners.command].map((fn) => fn(command, tab)));
      await flush();
    },
    fireStorageChanged: (changes, area = "local") => fireStorageChanged(changes, area),

    /** Alarms currently scheduled, as name -> create info. */
    get alarms() {
      return new Map(state.activeAlarms);
    },
    /** Last badge text set for a tab (undefined if never set). */
    badgeTextFor(tabId) {
      const hit = [...records.badgeText].reverse().find((d) => d.tabId === tabId);
      return hit?.text;
    },

    /** Pretend we are on Edge, where chrome.identity.getAuthToken is absent and
     *  drive.js has to fall back to launchWebAuthFlow. */
    emulateEdge() {
      delete chrome.identity.getAuthToken;
      delete chrome.identity.removeCachedAuthToken;
      return harness;
    },

    clearStorage() {
      for (const k of Object.keys(local)) delete local[k];
      for (const k of Object.keys(session)) delete session[k];
    },
    clearRecords() {
      for (const key of Object.keys(records)) {
        if (Array.isArray(records[key])) records[key].length = 0;
      }
      records.openOptionsPage = 0;
    },

    /** Full reset: storage, records, listeners, tabs, alarms, identity config.
     *  Because it drops listeners, re-import the service worker afterwards
     *  (loadServiceWorker does this for you). */
    reset() {
      harness.clearStorage();
      harness.clearRecords();
      for (const list of Object.values(listeners)) list.length = 0;
      state.tabs.length = 0;
      state.activeAlarms.clear();
      state.tabMessageResponder = null;
      state.identity.token = "test-access-token";
      state.identity.tokenQueue = [];
      state.identity.error = null;
      state.identity.requireInteractive = false;
      state.identity.redirectUrl = null;
      chrome.runtime.lastError = undefined;
      return harness;
    },

    uninstall() {
      if (installedChrome === harness) {
        installedChrome = null;
        if (hadPreviousChrome) globalThis.chrome = previousChrome;
        else delete globalThis.chrome;
      }
    },
  };

  hadPreviousChrome = "chrome" in globalThis;
  previousChrome = globalThis.chrome;
  globalThis.chrome = chrome;
  installedChrome = harness;

  if (options.local || options.session) harness.seed(options);
  if (options.tabs) harness.setTabs(options.tabs);

  return harness;
}

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

function patternKey(pattern) {
  if (pattern instanceof RegExp) return "re:" + String(pattern);
  if (typeof pattern === "function") return pattern;
  return "str:" + String(pattern);
}

function patternMatcher(pattern) {
  if (pattern === "*" || pattern == null) return () => true;
  if (typeof pattern === "string") return (url) => url.includes(pattern);
  if (pattern instanceof RegExp) {
    // A /g regexp is stateful under .test(), which would make matching depend
    // on how many requests came before. Strip the flag.
    const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
    return (url) => re.test(url);
  }
  if (typeof pattern === "function") return pattern;
  throw new TypeError("Unsupported fetch pattern: " + String(pattern));
}

function headersToObject(init) {
  const out = {};
  if (!init) return out;
  const h = init instanceof Headers ? init : new Headers(init);
  for (const [k, v] of h.entries()) out[k.toLowerCase()] = v;
  return out;
}

const BODYLESS_STATUSES = new Set([101, 103, 204, 205, 304]);

function buildResponse(spec, url) {
  const { status = 200, statusText, headers = {}, json, text, body } = spec;
  let payload = null;
  const finalHeaders = { ...headers };
  if (json !== undefined) {
    payload = JSON.stringify(json);
    if (!Object.keys(finalHeaders).some((k) => k.toLowerCase() === "content-type")) {
      finalHeaders["Content-Type"] = "application/json";
    }
  } else if (text !== undefined) {
    payload = text;
  } else if (body !== undefined) {
    payload = body;
  }
  const res = new Response(BODYLESS_STATUSES.has(status) ? null : payload, {
    status,
    statusText,
    headers: finalHeaders,
  });
  // Response.url is a read-only getter that construction leaves empty; shadow
  // it so assertions and any redirect logic see the URL that was requested.
  Object.defineProperty(res, "url", { value: url, configurable: true });
  return res;
}

let installedFetch = null;

/**
 * Install a recording fetch on globalThis. Returns the network harness.
 */
export function installFetch(options = {}) {
  if (installedFetch) installedFetch.restore();

  const originalFetch = globalThis.fetch;
  const requests = [];
  const unmatched = [];
  const rules = new Map(); // key -> { pattern, match, queue: [], persistent, calls }
  let fallback = options.default ?? null;

  function ruleFor(pattern) {
    const key = patternKey(pattern);
    let rule = rules.get(key);
    if (!rule) {
      rule = { pattern, match: patternMatcher(pattern), queue: [], persistent: undefined, calls: 0 };
      rules.set(key, rule);
    }
    return rule;
  }

  function resolveSpec(url, req) {
    // Queued (one-shot) responses win over standing handlers, whatever order
    // they were registered in — otherwise a catch-all installed in a beforeEach
    // would swallow the specific response a single test queued up.
    for (const rule of rules.values()) {
      if (rule.queue.length && rule.match(url, req)) {
        rule.calls++;
        return rule.queue.shift();
      }
    }
    for (const rule of rules.values()) {
      if (rule.persistent !== undefined && rule.match(url, req)) {
        rule.calls++;
        return rule.persistent;
      }
    }
    return fallback;
  }

  const fetchMock = async (input, init = {}) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? input);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ?? null;
    const record = {
      url,
      method,
      headers: headersToObject(init.headers),
      body,
      init,
      json() {
        return JSON.parse(typeof body === "string" ? body : String(body));
      },
    };
    requests.push(record);

    let spec = resolveSpec(url, record);
    if (typeof spec === "function") spec = await spec(record);

    if (spec == null) {
      unmatched.push(record);
      throw new Error(
        `fetch mock: no response registered for ${method} ${url}. ` +
          `Register one with net.on(pattern, {json}) / net.queue(pattern, ...) / net.setDefault(...).`
      );
    }
    if (spec.throws) {
      throw spec.throws instanceof Error ? spec.throws : new TypeError(String(spec.throws));
    }
    if (spec instanceof Response) return spec;
    return buildResponse(spec, url);
  };

  const net = {
    /** Every request made, in order: { url, method, headers, body, json() }. */
    requests,
    /** Requests that matched no rule — assert this is empty in suites that
     *  swallow network errors, or the swallowed error looks like a code path. */
    unmatched,

    get lastRequest() {
      return requests[requests.length - 1];
    },
    requestsMatching(pattern) {
      const match = patternMatcher(pattern);
      return requests.filter((r) => match(r.url, r));
    },

    /** Standing response for every request matching `pattern`. */
    on(pattern, spec) {
      ruleFor(pattern).persistent = spec;
      return net;
    },
    /** Queue one-shot responses, consumed in order before the standing one. */
    queue(pattern, ...specs) {
      ruleFor(pattern).queue.push(...specs);
      return net;
    },
    once(pattern, spec) {
      return net.queue(pattern, spec);
    },
    /** Used when nothing else matches. Without it, an unmatched request throws. */
    setDefault(spec) {
      fallback = spec;
      return net;
    },

    reset() {
      requests.length = 0;
      unmatched.length = 0;
      rules.clear();
      fallback = options.default ?? null;
      return net;
    },
    restore() {
      if (installedFetch === net) {
        installedFetch = null;
        globalThis.fetch = originalFetch;
      }
    },
  };

  globalThis.fetch = fetchMock;
  installedFetch = net;
  return net;
}

// ---------------------------------------------------------------------------
// module loading
// ---------------------------------------------------------------------------

let loadCounter = 0;

/**
 * Import a module from the repo root, bypassing the ESM module cache so its
 * top-level code runs again against whatever mocks are installed right now.
 * `path` is repo-relative, e.g. "src/background/service-worker.js".
 */
export function importFresh(path) {
  const url = new URL(path, REPO_ROOT);
  url.search = `fresh=${++loadCounter}`;
  return import(url.href);
}

/**
 * Install both mocks and then import the background worker, in that order.
 *
 * The worker calls chrome.runtime.onMessage.addListener (and tabs/alarms/idle/
 * commands) while the module body is evaluating, so it MUST NOT be imported
 * before the mock exists.
 *
 * Returns { mock, chrome, net, send, local, session, records, module } where
 * `mock` is the chrome harness and `chrome` is the fake API object itself —
 * the same split as installChrome()'s return value, so `mock.x` and
 * `harness.x` always mean the same thing.
 */
export async function loadServiceWorker(options = {}) {
  const mock = installChrome(options.chrome ?? options);
  const net = installFetch(options.fetch ?? {});
  const module = await importFresh("src/background/service-worker.js");
  return {
    mock,
    chrome: mock.chrome,
    net,
    module,
    send: mock.send,
    local: mock.local,
    session: mock.session,
    records: mock.records,
  };
}

/** Reset whichever mocks are installed. Safe to call when none are. */
export function reset() {
  installedChrome?.reset();
  installedFetch?.reset();
}

export const resetAll = reset;

/** Remove the mocks from globalThis entirely. */
export function uninstall() {
  installedChrome?.uninstall();
  installedFetch?.restore();
}
