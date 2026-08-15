// Which entries an origin is allowed to see is a security boundary: match too
// broadly and the vault offers a password to a site that did not earn it. These
// cases are the ones that decide that boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchEntriesForHost } from "../src/lib/vault.js";

const entry = (url) => ({ id: url, url, name: url, deletedAt: null });
const vault = (...urls) => ({ entries: urls.map(entry) });
const names = (data, host) => matchEntriesForHost(data, host).map((e) => e.url).sort();

test("matches the exact host", () => {
  assert.deepEqual(names(vault("example.com"), "example.com"), ["example.com"]);
});

test("ignores a leading www on either side", () => {
  assert.deepEqual(names(vault("www.example.com"), "example.com"), ["www.example.com"]);
  assert.deepEqual(names(vault("example.com"), "www.example.com"), ["example.com"]);
});

test("a site entry fills on its own subdomains", () => {
  assert.deepEqual(names(vault("example.com"), "login.example.com"), ["example.com"]);
  assert.deepEqual(names(vault("example.com"), "a.b.example.com"), ["example.com"]);
});

test("a subdomain entry does NOT fill on the parent domain", () => {
  // mail.example.com and example.com can be unrelated applications.
  assert.deepEqual(names(vault("mail.example.com"), "example.com"), []);
});

test("a subdomain entry does NOT fill on a sibling subdomain", () => {
  assert.deepEqual(names(vault("mail.example.com"), "chat.example.com"), []);
});

test("does not match on a shared prefix or suffix of the label", () => {
  assert.deepEqual(names(vault("example.com"), "evil-example.com"), []);
  assert.deepEqual(names(vault("example.com"), "exampleXcom"), []);
  assert.deepEqual(names(vault("example.com"), "notexample.com"), []);
});

test("does not leak across a shared public suffix", () => {
  // alice and bob are different people who happen to share a host.
  const data = vault("alice.github.io");
  assert.deepEqual(names(data, "bob.github.io"), []);
  assert.deepEqual(names(data, "alice.github.io"), ["alice.github.io"]);
});

test("an entry saved for a bare public suffix matches nothing under it", () => {
  // The dangerous case: one entry that would otherwise claim every site there.
  assert.deepEqual(names(vault("github.io"), "anyone.github.io"), []);
  assert.deepEqual(names(vault("co.uk"), "somebank.co.uk"), []);
  assert.deepEqual(names(vault("com"), "example.com"), []);
});

test("the bare-public-suffix guard only holds for suffixes on the embedded list", () => {
  // CURRENT BEHAVIOUR, and the limit of the test above. vault.js ships an
  // abridged public-suffix list, and registrableDomain() falls back to "last two
  // labels" for anything not on it. So an entry stored for an *unlisted* suffix
  // does become a wildcard over everything beneath it — exactly what the listed
  // cases are guarded against. Documented, not fixed; reported as a defect.
  for (const suffix of ["com.pt", "com.ug", "co.at", "fastly.net"]) {
    assert.deepEqual(
      names(vault(suffix), `bank.${suffix}`),
      [suffix],
      `${suffix} is absent from MULTI_LABEL_SUFFIXES, so it still matches as a site`
    );
  }
});

test("country-code second-level domains are treated as suffixes", () => {
  assert.deepEqual(names(vault("example.co.uk"), "login.example.co.uk"), ["example.co.uk"]);
  assert.deepEqual(names(vault("example.co.uk"), "other.co.uk"), []);
});

test("accepts entries stored with a scheme, a path, or a port", () => {
  assert.deepEqual(names(vault("https://example.com/login?x=1"), "example.com"), [
    "https://example.com/login?x=1",
  ]);
  assert.deepEqual(names(vault("https://example.com:8443"), "example.com"), [
    "https://example.com:8443",
  ]);
});

test("skips entries with no or unusable URL", () => {
  assert.deepEqual(names({ entries: [entry(""), entry("   "), { id: "x", deletedAt: null }] }, "example.com"), []);
});

test("returns nothing for a missing hostname", () => {
  const data = vault("example.com");
  assert.deepEqual(matchEntriesForHost(data, ""), []);
  assert.deepEqual(matchEntriesForHost(data, null), []);
  assert.deepEqual(matchEntriesForHost(data, undefined), []);
});

test("excludes soft-deleted entries", () => {
  const data = { entries: [{ ...entry("example.com"), deletedAt: Date.now() }] };
  assert.deepEqual(names(data, "example.com"), []);
});

test("is case-insensitive", () => {
  assert.deepEqual(names(vault("EXAMPLE.com"), "example.COM"), ["EXAMPLE.com"]);
});
