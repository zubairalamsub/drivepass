// drive.js is the only module that talks to Google, and the only place the
// OAuth scope the extension asks for is actually spelled out. Four things here
// are worth pinning down hard:
//
//   * the scope in the auth URL — widening it past drive.file would hand the
//     extension read access to everything in the user's Drive;
//   * the 401 retry — it must drop the stale token and try again exactly once,
//     never loop against Google with a token that will never work;
//   * the multipart upload body — a boundary that disagrees with the one in the
//     Content-Type header uploads a silently corrupt vault;
//   * sign-out — the revoke call is the only thing that actually severs the
//     grant, so it has to happen with the real token.
//
// Everything runs against the fake chrome + fetch in tests/helpers/chrome-mock.js.
// No network, no Google account.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installChrome, installFetch, uninstall } from "./helpers/chrome-mock.js";

// drive.js reads `chrome` only from inside its exported functions and keeps no
// module-level state, so unlike service-worker.js it is safe to import once up
// front — it picks up whichever mock the current test installed.
import {
  getToken,
  removeCachedToken,
  signOut,
  getUserEmail,
  findVaultFile,
  getFileMeta,
  createVaultFile,
  updateVaultFile,
  downloadVaultFile,
} from "../src/lib/drive.js";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DEFAULT_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const READ_API = "googleapis.com/drive/v3"; // does not match the /upload/ host path
const UPLOAD_API = "/upload/drive/v3/files";

let mock;
let net;
let realLog;

function install(options = {}) {
  mock = installChrome(options);
  net = installFetch();
  return mock;
}

beforeEach(() => {
  install();
  // getAuthTokenViaWebAuthFlow prints the redirect URI on every run. Useful in
  // a browser console, pure noise across ~20 tests here.
  realLog = console.log;
  console.log = () => {};
});

afterEach(() => {
  console.log = realLog;
  uninstall();
});

// Date.now() decides both whether a cached Edge token is still valid and what
// expiry gets written, so the boundary cases need a clock that does not move.
async function withFrozenClock(now, fn) {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** Put the harness in "this browser has no chrome.identity.getAuthToken" mode
 *  and make launchWebAuthFlow hand back a successful implicit-grant redirect. */
function edgeWithRedirect(fragment = "#access_token=edge-token&expires_in=3600&token_type=Bearer") {
  mock.emulateEdge();
  mock.state.identity.redirectUrl = mock.chrome.identity.getRedirectURL() + fragment;
  return mock;
}

// ---- getToken: the chrome.identity.getAuthToken path -----------------------

test("getToken resolves with the token chrome.identity hands back", async () => {
  assert.equal(await getToken(), "test-access-token");
  assert.deepEqual(mock.records.getAuthToken, [{ interactive: false }]);
});

test("getToken forwards the interactive flag to chrome.identity", async () => {
  await getToken(true);
  assert.deepEqual(mock.records.getAuthToken, [{ interactive: true }]);
});

test("getToken rejects with the browser's own message when sign-in fails", async () => {
  mock.state.identity.error = "OAuth2 not granted or revoked.";
  await assert.rejects(() => getToken(false), /OAuth2 not granted or revoked/);
});

test("getToken rejects with a plain message when chrome returns neither token nor error", async () => {
  mock.state.identity.token = undefined;
  await assert.rejects(() => getToken(false), /Not signed in to Google/);
});

test("a getAuthToken failure that is not a browser-support problem does not start a web auth flow", async () => {
  // Falling back on every error would show a consent popup for transient
  // network failures, which is worse than reporting them.
  mock.state.identity.error = "The network is unreachable.";
  mock.state.identity.redirectUrl = mock.chrome.identity.getRedirectURL() + "#access_token=should-not-be-used";
  await assert.rejects(() => getToken(true), /network is unreachable/);
  assert.deepEqual(mock.records.webAuthFlows, []);
});

test("getToken falls back to launchWebAuthFlow when chrome reports the API is unavailable", async () => {
  for (const message of [
    "getAuthToken is not supported on this platform.",
    "Edge does not implement getAuthToken.",
    "unsupported browser",
  ]) {
    install();
    mock.state.identity.error = message;
    mock.state.identity.redirectUrl =
      mock.chrome.identity.getRedirectURL() + "#access_token=fallback-token&expires_in=3600";

    assert.equal(await getToken(true), "fallback-token", `should fall back for "${message}"`);
    assert.equal(mock.records.webAuthFlows.length, 1);
  }
});

test("getToken falls back to launchWebAuthFlow when getAuthToken is missing entirely", async () => {
  edgeWithRedirect();
  assert.equal(await getToken(true), "edge-token");
  assert.equal(mock.records.webAuthFlows.length, 1);
});

// ---- the auth URL handed to launchWebAuthFlow ------------------------------
//
// A widened scope here is a security regression, not a style nit: drive.file
// only exposes files this extension created, anything broader exposes the
// user's whole Drive to a password-manager extension.

test("the auth URL requests exactly the drive.file scope and nothing else", async () => {
  edgeWithRedirect();
  await getToken(true);

  const { url } = mock.records.webAuthFlows[0];
  const parsed = new URL(url);
  assert.deepEqual(parsed.searchParams.getAll("scope"), [DRIVE_SCOPE]);
  // getAll() would also pass for a single space-separated "scope1 scope2"
  // value, so pin the exact string too.
  assert.equal(parsed.searchParams.get("scope"), DRIVE_SCOPE);
});

test("the auth URL asks for an implicit token grant at Google's v2 endpoint", async () => {
  edgeWithRedirect();
  await getToken(true);

  const parsed = new URL(mock.records.webAuthFlows[0].url);
  assert.equal(parsed.origin + parsed.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(parsed.searchParams.get("response_type"), "token");
});

test("the client id and redirect uri in the auth URL are percent-encoded", async () => {
  edgeWithRedirect();
  await getToken(true);

  const { url } = mock.records.webAuthFlows[0];
  const redirectUri = mock.chrome.identity.getRedirectURL();
  assert.equal(new URL(url).searchParams.get("client_id"), DEFAULT_CLIENT_ID);
  assert.equal(new URL(url).searchParams.get("redirect_uri"), redirectUri);
  // Assert on the raw string as well: a missing encodeURIComponent would still
  // round-trip through URL for these particular values.
  assert.ok(url.includes(`redirect_uri=${encodeURIComponent(redirectUri)}`), url);
  assert.ok(url.includes("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file"), url);
});

test("the web auth flow is always launched interactively", async () => {
  // interactive:false would make the flow fail instantly instead of showing the
  // consent window the fallback exists to show.
  edgeWithRedirect();
  await getToken(true);
  assert.deepEqual(mock.records.webAuthFlows[0].interactive, true);
});

test("an unconfigured OAuth client id is refused before any auth window opens", async () => {
  const badManifests = [
    { manifest_version: 3 }, // no oauth2 block at all
    { manifest_version: 3, oauth2: {} }, // block present, id missing
    { manifest_version: 3, oauth2: { client_id: "" } },
    { manifest_version: 3, oauth2: { client_id: "REPLACE_WITH_YOUR_CLIENT_ID" } },
    { manifest_version: 3, oauth2: { client_id: "REPLACE_ME.apps.googleusercontent.com" } },
  ];
  for (const manifest of badManifests) {
    install({ manifest });
    edgeWithRedirect();
    await assert.rejects(
      () => getToken(true),
      /OAuth Client ID not configured/,
      `client_id ${JSON.stringify(manifest.oauth2?.client_id)} should be refused`
    );
    assert.deepEqual(mock.records.webAuthFlows, [], "no auth window should have opened");
  }
});

// ---- token extraction from the redirect URL --------------------------------

test("the access token and its lifetime are read out of the redirect fragment", async () => {
  const now = 1_700_000_000_000;
  edgeWithRedirect("#access_token=abc123&token_type=Bearer&expires_in=3600");

  const token = await withFrozenClock(now, () => getToken(true));
  assert.equal(token, "abc123");
  assert.equal(mock.session.edge_token, "abc123");
  // 60s safety margin so a token is never used in the last second of its life.
  assert.equal(mock.session.edge_expires, now + (3600 - 60) * 1000);
});

test("a redirect without expires_in is treated as a one-hour token", async () => {
  const now = 1_700_000_000_000;
  edgeWithRedirect("#access_token=abc123&token_type=Bearer");

  await withFrozenClock(now, () => getToken(true));
  assert.equal(mock.session.edge_expires, now + (3600 - 60) * 1000);
});

test("a short-lived token keeps the same 60s margin", async () => {
  const now = 1_700_000_000_000;
  edgeWithRedirect("#access_token=abc123&expires_in=120");

  await withFrozenClock(now, () => getToken(true));
  assert.equal(mock.session.edge_expires, now + 60 * 1000);
});

test("a redirect carrying an error instead of a token is rejected", async () => {
  edgeWithRedirect("#error=access_denied&error_description=user+refused");
  await assert.rejects(() => getToken(true), /Failed to extract OAuth access token/);
  assert.equal(mock.session.edge_token, undefined, "nothing should be cached on failure");
});

test("a cancelled or blocked auth window is reported as such", async () => {
  mock.emulateEdge();
  mock.state.identity.redirectUrl = null; // the harness then reports a refusal
  await assert.rejects(() => getToken(true), /did not approve|cancelled or blocked/);
});

// ---- the session token cache ----------------------------------------------

test("a cached edge token is reused without opening another auth window", async () => {
  mock.emulateEdge();
  mock.seed({ session: { edge_token: "cached-token", edge_expires: Date.now() + 600_000 } });

  assert.equal(await getToken(false), "cached-token");
  assert.deepEqual(mock.records.webAuthFlows, [], "the cache should have short-circuited the flow");
});

test("the cached edge token stops being valid the instant its expiry is reached", async () => {
  const now = 1_700_000_000_000;

  // One millisecond of life left: still usable.
  install();
  mock.emulateEdge();
  mock.seed({ session: { edge_token: "cached-token", edge_expires: now + 1 } });
  assert.equal(await withFrozenClock(now, () => getToken(false)), "cached-token");

  // Expiry exactly now: the comparison is a strict `<`, so this is expired.
  install();
  mock.emulateEdge();
  mock.seed({ session: { edge_token: "cached-token", edge_expires: now } });
  await withFrozenClock(now, () =>
    assert.rejects(() => getToken(false), /Google authentication required/)
  );
});

test("an expired cached token is replaced by a fresh interactive flow", async () => {
  edgeWithRedirect("#access_token=refreshed-token&expires_in=3600");
  mock.seed({ session: { edge_token: "stale-token", edge_expires: Date.now() - 1 } });

  assert.equal(await getToken(true), "refreshed-token");
  assert.equal(mock.session.edge_token, "refreshed-token");
  assert.equal(mock.records.webAuthFlows.length, 1);
});

test("without a cached token a non-interactive call refuses to open an auth window", async () => {
  // Background syncs run non-interactively; popping a consent window out of a
  // timer would be both jarring and blocked by the browser.
  mock.emulateEdge();
  await assert.rejects(() => getToken(false), /Google authentication required/);
  assert.deepEqual(mock.records.webAuthFlows, []);
});

test("the session token cache is ignored while chrome.identity.getAuthToken works", async () => {
  mock.seed({ session: { edge_token: "stale-edge-token", edge_expires: Date.now() + 600_000 } });
  assert.equal(await getToken(false), "test-access-token");
});

// ---- removeCachedToken -----------------------------------------------------

test("removeCachedToken drops both the chrome-cached token and the session copy", async () => {
  mock.seed({ session: { edge_token: "cached-token", edge_expires: Date.now() + 600_000 } });
  await removeCachedToken("cached-token");

  assert.deepEqual(mock.records.removedTokens, ["cached-token"]);
  assert.equal(mock.session.edge_token, undefined);
  assert.equal(mock.session.edge_expires, undefined);
});

test("removeCachedToken still clears the session copy on a browser without removeCachedAuthToken", async () => {
  mock.emulateEdge();
  mock.seed({ session: { edge_token: "cached-token", edge_expires: Date.now() + 600_000 } });

  await removeCachedToken("cached-token");
  assert.equal(mock.session.edge_token, undefined);
});

// ---- driveFetch: auth header and the 401 retry -----------------------------

test("every Drive request carries a bearer Authorization header", async () => {
  net.on(READ_API, { json: { files: [] } });
  await findVaultFile("vault.enc");
  assert.equal(net.lastRequest.headers.authorization, "Bearer test-access-token");
});

test("a 401 drops the stale token and retries once with a fresh one", async () => {
  mock.state.identity.tokenQueue = ["stale-token", "fresh-token"];
  net.queue(READ_API, { status: 401 }, { json: { files: [{ id: "f1", modifiedTime: "t1" }] } });

  const found = await findVaultFile("vault.enc");
  assert.deepEqual(found, { id: "f1", modifiedTime: "t1" });

  assert.equal(net.requests.length, 2, "exactly one retry");
  assert.equal(net.requests[0].headers.authorization, "Bearer stale-token");
  assert.equal(net.requests[1].headers.authorization, "Bearer fresh-token");
  assert.deepEqual(mock.records.removedTokens, ["stale-token"], "the stale token must be evicted");
});

test("a second 401 is surfaced instead of retried, so the retry cannot loop", async () => {
  net.on(READ_API, { status: 401 });
  await assert.rejects(() => findVaultFile("vault.enc"), /Drive search failed: 401/);
  assert.equal(net.requests.length, 2, "one original request plus exactly one retry");
  assert.equal(mock.records.removedTokens.length, 1);
});

test("the retried request keeps the original method, body and headers", async () => {
  mock.state.identity.tokenQueue = ["stale-token", "fresh-token"];
  net.queue(UPLOAD_API, { status: 401 }, { json: { id: "f1", modifiedTime: "t1" } });

  await createVaultFile("vault.enc", { ciphertext: "AAAA" });

  const [first, second] = net.requests;
  assert.equal(second.method, first.method);
  assert.equal(second.body, first.body);
  assert.equal(second.headers["content-type"], first.headers["content-type"]);
  assert.equal(second.headers.authorization, "Bearer fresh-token");
});

test("a non-401 error status is returned without a retry", async () => {
  net.on(READ_API, { status: 500 });
  await assert.rejects(() => findVaultFile("vault.enc"), /Drive search failed: 500/);
  assert.equal(net.requests.length, 1);
  assert.deepEqual(mock.records.removedTokens, []);
});

test("on a browser without getAuthToken a 401 turns into a re-auth error, not a Drive error", async () => {
  // Documents current behaviour: driveFetch evicts the cached Edge token and
  // then asks for a non-interactive one, which the fallback path cannot mint.
  mock.emulateEdge();
  mock.seed({ session: { edge_token: "cached-token", edge_expires: Date.now() + 600_000 } });
  net.on(READ_API, { status: 401 });

  await assert.rejects(() => findVaultFile("vault.enc"), /Google authentication required/);
  assert.equal(net.requests.length, 1, "the retry never got far enough to make a request");
});

// ---- getUserEmail ----------------------------------------------------------

test("getUserEmail asks Drive only for the account's email address", async () => {
  net.on(READ_API, { json: { user: { emailAddress: "zubair@example.com" } } });
  assert.equal(await getUserEmail(), "zubair@example.com");
  assert.equal(net.lastRequest.url, "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)");
});

test("getUserEmail returns null when Drive answers without a user block", async () => {
  net.on(READ_API, { json: {} });
  assert.equal(await getUserEmail(), null);
});

test("getUserEmail throws when the about call fails", async () => {
  net.on(READ_API, { status: 403 });
  await assert.rejects(() => getUserEmail(), /Failed to read account info/);
});

// ---- findVaultFile ---------------------------------------------------------

test("findVaultFile searches by exact name, skips the trash, and takes the newest first", async () => {
  net.on(READ_API, { json: { files: [] } });
  await findVaultFile("vault.enc");

  assert.equal(
    net.lastRequest.url,
    "https://www.googleapis.com/drive/v3/files" +
      "?q=name%3D'vault.enc'%20and%20trashed%3Dfalse" +
      "&spaces=drive&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc"
  );

  const params = new URL(net.lastRequest.url).searchParams;
  assert.equal(params.get("q"), "name='vault.enc' and trashed=false");
  assert.equal(params.get("orderBy"), "modifiedTime desc");
  assert.equal(params.get("spaces"), "drive");
});

test("findVaultFile returns null when Drive finds nothing", async () => {
  net.on(READ_API, { json: { files: [] } });
  assert.equal(await findVaultFile("vault.enc"), null);
});

test("findVaultFile returns null when the response has no files key at all", async () => {
  net.on(READ_API, { json: {} });
  assert.equal(await findVaultFile("vault.enc"), null);
});

test("findVaultFile picks the first match, which orderBy makes the most recently modified", async () => {
  net.on(READ_API, {
    json: {
      files: [
        { id: "newest", name: "vault.enc", modifiedTime: "2024-06-01T00:00:00.000Z" },
        { id: "older", name: "vault.enc", modifiedTime: "2023-01-01T00:00:00.000Z" },
      ],
    },
  });
  assert.deepEqual(await findVaultFile("vault.enc"), {
    id: "newest",
    modifiedTime: "2024-06-01T00:00:00.000Z",
  });
});

test("findVaultFile returns only id and modifiedTime, not the whole Drive record", async () => {
  net.on(READ_API, {
    json: { files: [{ id: "f1", name: "vault.enc", modifiedTime: "t1", owners: ["someone"] }] },
  });
  assert.deepEqual(Object.keys(await findVaultFile("vault.enc")).sort(), ["id", "modifiedTime"]);
});

test("a quote in the file name is interpolated into the Drive query unescaped", async () => {
  // Documents current behaviour. Callers only ever pass the FILE_NAME constant,
  // so nothing reaches this today, but the query is built by raw string
  // concatenation and would break (or change meaning) if that ever changed.
  net.on(READ_API, { json: { files: [] } });
  await findVaultFile("va'ult.enc");
  assert.equal(new URL(net.lastRequest.url).searchParams.get("q"), "name='va'ult.enc' and trashed=false");
});

// ---- getFileMeta -----------------------------------------------------------

test("getFileMeta asks only for id and modifiedTime", async () => {
  net.on(READ_API, { json: { id: "f1", modifiedTime: "2024-06-01T00:00:00.000Z" } });
  const meta = await getFileMeta("f1");
  assert.deepEqual(meta, { id: "f1", modifiedTime: "2024-06-01T00:00:00.000Z" });
  assert.equal(net.lastRequest.url, "https://www.googleapis.com/drive/v3/files/f1?fields=id,modifiedTime");
});

test("getFileMeta reports a deleted or revoked file as null rather than throwing", async () => {
  // The caller uses this to decide whether the remote vault still exists, so a
  // 404 has to be distinguishable from a real failure.
  net.on(READ_API, { status: 404 });
  assert.equal(await getFileMeta("gone"), null);
});

test("getFileMeta throws on any other error status", async () => {
  for (const status of [400, 403, 500]) {
    install();
    net.on(READ_API, { status });
    await assert.rejects(() => getFileMeta("f1"), new RegExp(`Drive metadata fetch failed: ${status}`));
  }
});

// ---- createVaultFile -------------------------------------------------------

const OK_UPLOAD = { json: { id: "new-file-id", modifiedTime: "2024-06-01T00:00:00.000Z" } };

test("createVaultFile uploads as multipart and returns the new file's id and mtime", async () => {
  net.on(UPLOAD_API, OK_UPLOAD);
  const result = await createVaultFile("vault.enc", { ciphertext: "AAAA" });

  assert.deepEqual(result, { id: "new-file-id", modifiedTime: "2024-06-01T00:00:00.000Z" });
  assert.equal(net.lastRequest.method, "POST");
  assert.equal(
    net.lastRequest.url,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime"
  );
});

test("the multipart boundary in the body is the one declared in the Content-Type header", async () => {
  // If these two ever drift apart Drive stores the raw MIME envelope as the
  // file's contents and the vault is unreadable, with no error anywhere.
  net.on(UPLOAD_API, OK_UPLOAD);
  await createVaultFile("vault.enc", { ciphertext: "AAAA" });

  const req = net.lastRequest;
  const boundary = /^multipart\/related; boundary=(.+)$/.exec(req.headers["content-type"])?.[1];
  assert.ok(boundary, `no boundary in Content-Type: ${req.headers["content-type"]}`);
  assert.ok(req.body.startsWith(`--${boundary}\r\n`), "body must open with the boundary");
  assert.ok(req.body.endsWith(`\r\n--${boundary}--`), "body must close with the terminating boundary");
});

test("the multipart body carries a metadata part and a media part with the right Content-Types", async () => {
  net.on(UPLOAD_API, OK_UPLOAD);
  const content = { format: "drivepass-v1", iterations: 310000, ciphertext: "AAAA", iv: "BBBB" };
  await createVaultFile("vault.enc", content);

  const req = net.lastRequest;
  const boundary = /boundary=(.+)$/.exec(req.headers["content-type"])[1];
  const parts = req.body.split(`--${boundary}`);
  // ["", metadata, media, "--"]
  assert.equal(parts.length, 4, "expected exactly two parts between the boundaries");
  assert.equal(parts[3], "--");

  assert.match(parts[1], /^\r\nContent-Type: application\/json; charset=UTF-8\r\n\r\n/);
  assert.deepEqual(JSON.parse(parts[1].split("\r\n\r\n")[1]), {
    name: "vault.enc",
    mimeType: "application/json",
  });

  assert.match(parts[2], /^\r\nContent-Type: application\/json\r\n\r\n/);
  assert.deepEqual(JSON.parse(parts[2].split("\r\n\r\n")[1]), content, "the vault must round-trip verbatim");
});

test("createVaultFile defaults to an interactive token so a first-time upload may prompt", async () => {
  net.on(UPLOAD_API, OK_UPLOAD);
  await createVaultFile("vault.enc", { ciphertext: "AAAA" });
  assert.deepEqual(mock.records.getAuthToken, [{ interactive: true }]);

  install();
  net.on(UPLOAD_API, OK_UPLOAD);
  await createVaultFile("vault.enc", { ciphertext: "AAAA" }, false);
  assert.deepEqual(mock.records.getAuthToken, [{ interactive: false }]);
});

test("the multipart boundary is derived from the file name, so it repeats across uploads", async () => {
  const boundaryOf = (req) => /boundary=(.+)$/.exec(req.headers["content-type"])[1];

  net.on(UPLOAD_API, OK_UPLOAD);
  await createVaultFile("vault.enc", { ciphertext: "AAAA" });
  const first = boundaryOf(net.lastRequest);
  await createVaultFile("vault.enc", { ciphertext: "CCCC" });
  const second = boundaryOf(net.lastRequest);
  await createVaultFile("other-name.enc", { ciphertext: "AAAA" });
  const other = boundaryOf(net.lastRequest);

  assert.equal(second, first, "same name, same boundary — it is a hash, not a nonce");
  assert.notEqual(other, first);
  assert.match(first, /^drivepass\d+$/);
});

test("content containing the boundary string corrupts the multipart body", async () => {
  // Documents current behaviour. The boundary is a deterministic hash of the
  // file name rather than a value checked against the payload, so a payload
  // that happens to contain it splits the envelope in the wrong places.
  net.on(UPLOAD_API, OK_UPLOAD);
  await createVaultFile("vault.enc", { ciphertext: "AAAA" });
  const boundary = /boundary=(.+)$/.exec(net.lastRequest.headers["content-type"])[1];

  await createVaultFile("vault.enc", { ciphertext: `--${boundary}\r\nContent-Type: text/plain\r\n\r\nhi` });
  const parts = net.lastRequest.body.split(`--${boundary}`);
  assert.ok(parts.length > 4, "an extra boundary in the payload adds phantom parts");
});

test("createVaultFile throws with the status when Drive refuses the upload", async () => {
  net.on(UPLOAD_API, { status: 403 });
  await assert.rejects(() => createVaultFile("vault.enc", { ciphertext: "AAAA" }), /Drive create failed: 403/);
});

// ---- updateVaultFile -------------------------------------------------------

test("updateVaultFile PATCHes the file contents as a media upload", async () => {
  net.on(UPLOAD_API, { json: { id: "f1", modifiedTime: "2024-06-02T00:00:00.000Z" } });
  const content = { format: "drivepass-v1", ciphertext: "DDDD" };
  const result = await updateVaultFile("f1", content);

  const req = net.lastRequest;
  assert.equal(req.method, "PATCH");
  assert.equal(
    req.url,
    "https://www.googleapis.com/upload/drive/v3/files/f1?uploadType=media&fields=id,modifiedTime"
  );
  assert.equal(req.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(req.body), content, "an update is a plain body, not a multipart envelope");
  assert.deepEqual(result, { id: "f1", modifiedTime: "2024-06-02T00:00:00.000Z" });
});

test("updateVaultFile requests its token non-interactively", async () => {
  // Saves happen while the user is typing; a consent window here would be a
  // surprise and would probably be blocked.
  net.on(UPLOAD_API, { json: { id: "f1", modifiedTime: "t" } });
  await updateVaultFile("f1", { ciphertext: "DDDD" });
  assert.deepEqual(mock.records.getAuthToken, [{ interactive: false }]);
});

test("updateVaultFile throws with the status when the write is rejected", async () => {
  net.on(UPLOAD_API, { status: 412 });
  await assert.rejects(() => updateVaultFile("f1", { ciphertext: "DDDD" }), /Drive update failed: 412/);
});

// ---- downloadVaultFile -----------------------------------------------------

test("downloadVaultFile fetches the file contents and parses them", async () => {
  const file = { format: "drivepass-v1", salt: "s", iv: "i", ciphertext: "c" };
  net.on(READ_API, { json: file });

  assert.deepEqual(await downloadVaultFile("f1"), file);
  assert.equal(net.lastRequest.method, "GET");
  assert.equal(net.lastRequest.url, "https://www.googleapis.com/drive/v3/files/f1?alt=media");
});

test("downloadVaultFile throws with the status when the file cannot be read", async () => {
  for (const status of [404, 500]) {
    install();
    net.on(READ_API, { status });
    await assert.rejects(() => downloadVaultFile("f1"), new RegExp(`Drive download failed: ${status}`));
  }
});

// ---- signOut ---------------------------------------------------------------

test("signOut revokes the token at Google and then drops it locally", async () => {
  net.on("oauth2.googleapis.com/revoke", { status: 200 });
  await signOut();

  const req = net.lastRequest;
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://oauth2.googleapis.com/revoke?token=test-access-token");
  assert.deepEqual(mock.records.removedTokens, ["test-access-token"]);
});

test("signOut revokes the cached edge token on a browser without getAuthToken", async () => {
  mock.emulateEdge();
  mock.seed({ session: { edge_token: "cached-token", edge_expires: Date.now() + 600_000 } });
  net.on("oauth2.googleapis.com/revoke", { status: 200 });

  await signOut();
  assert.equal(net.lastRequest.url, "https://oauth2.googleapis.com/revoke?token=cached-token");
  assert.equal(mock.session.edge_token, undefined);
});

test("signOut is a no-op when there is no token to revoke", async () => {
  mock.state.identity.error = "OAuth2 not granted or revoked.";
  await signOut();
  assert.deepEqual(net.requests, [], "nothing to revoke, nothing to send");
  assert.deepEqual(net.unmatched, []);
});

test("signOut asks for the token non-interactively, so it never opens a consent window", async () => {
  net.on("oauth2.googleapis.com/revoke", { status: 200 });
  await signOut();
  assert.deepEqual(mock.records.getAuthToken, [{ interactive: false }]);
});

test("a revoke request that fails at the network layer leaves the token cached", async () => {
  // Documents current behaviour, and it is a real gap: the catch-all swallows
  // the failure and skips removeCachedToken, so an offline "Disconnect" reports
  // success while the token stays usable and the Drive grant stays live.
  mock.seed({ session: { edge_token: "cached-token", edge_expires: Date.now() + 600_000 } });
  net.on("oauth2.googleapis.com/revoke", { throws: new TypeError("Failed to fetch") });

  await signOut(); // must not throw
  assert.deepEqual(mock.records.removedTokens, [], "the token was never evicted");
  assert.equal(mock.session.edge_token, "cached-token", "the session copy survived too");
});

test("a revoke that Google answers with an error status still clears the local token", async () => {
  net.on("oauth2.googleapis.com/revoke", { status: 400, json: { error: "invalid_token" } });
  await signOut();
  assert.deepEqual(mock.records.removedTokens, ["test-access-token"]);
});
