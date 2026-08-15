// CSV/JSON import from other managers, and export escaping.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAndImportFile,
  detectAndImportCSV,
  detectAndImportJSON,
  exportToCSV,
} from "../src/lib/importer.js";

// ---- CSV import ----------------------------------------------------------

test("imports a Chrome password export", () => {
  const csv = "name,url,username,password\nGitHub,https://github.com,alice,pw1\n";
  const [e] = detectAndImportCSV(csv);
  assert.equal(e.name, "GitHub");
  assert.equal(e.url, "https://github.com");
  assert.equal(e.username, "alice");
  assert.equal(e.password, "pw1");
});

test("imports LastPass column names", () => {
  const csv = "url,username,password,extra,name\nhttps://x.com,bob,pw2,a note,X\n";
  const [e] = detectAndImportCSV(csv);
  assert.equal(e.username, "bob");
  assert.equal(e.notes, "a note");
  assert.equal(e.name, "X");
});

test("handles quoted fields containing commas, quotes and newlines", () => {
  const csv = 'name,password,notes\n"Corp, Inc","a""b","line1\nline2"\n';
  const [e] = detectAndImportCSV(csv);
  assert.equal(e.name, "Corp, Inc");
  assert.equal(e.password, 'a"b');
  assert.equal(e.notes, "line1\nline2");
});

test("accepts CRLF line endings", () => {
  const rows = detectAndImportCSV("name,password\r\nA,1\r\nB,2\r\n");
  assert.deepEqual(rows.map((e) => e.name), ["A", "B"]);
});

test("skips blank rows and rows with nothing usable", () => {
  const rows = detectAndImportCSV("name,url,username,password\nA,,,pw\n\n,,,\n");
  assert.equal(rows.length, 1);
});

test("a header-only or empty file imports nothing", () => {
  assert.deepEqual(detectAndImportCSV("name,url,username,password\n"), []);
  assert.deepEqual(detectAndImportCSV(""), []);
});

test("column order does not matter", () => {
  const [e] = detectAndImportCSV("password,name,username\npw,N,u\n");
  assert.equal(e.name, "N");
  assert.equal(e.username, "u");
  assert.equal(e.password, "pw");
});

test("a TOTP column is carried over", () => {
  const [e] = detectAndImportCSV("name,password,totp\nA,pw,JBSWY3DPEHPK3PXP\n");
  assert.equal(e.totp, "JBSWY3DPEHPK3PXP");
});

// ---- JSON import ---------------------------------------------------------

test("imports a Bitwarden JSON export", () => {
  const json = JSON.stringify({
    items: [
      {
        type: 1,
        name: "Bank",
        notes: "n",
        login: { username: "carol", password: "pw3", totp: "ABCD", uris: [{ uri: "https://bank.example" }] },
      },
    ],
  });
  const [e] = detectAndImportJSON(json);
  assert.equal(e.name, "Bank");
  assert.equal(e.url, "https://bank.example");
  assert.equal(e.username, "carol");
  assert.equal(e.password, "pw3");
  assert.equal(e.totp, "ABCD");
  assert.equal(e.type, "login");
});

test("maps Bitwarden card and note item types", () => {
  const json = JSON.stringify({
    items: [
      { type: 2, name: "Visa", card: { cardholderName: "A B", number: "4111", code: "123" } },
      { type: 3, name: "Note", notes: "secret text" },
    ],
  });
  const [card, note] = detectAndImportJSON(json);
  assert.equal(card.type, "card");
  assert.equal(card.card.number, "4111");
  assert.equal(card.card.cvv, "123");
  assert.equal(note.type, "note");
  assert.equal(note.notes, "secret text");
});

test("imports a bare array of objects", () => {
  const [e] = detectAndImportJSON(JSON.stringify([{ title: "T", website: "x.com", user: "u", password: "p" }]));
  assert.equal(e.name, "T");
  assert.equal(e.url, "x.com");
  assert.equal(e.username, "u");
});

test("imports a DrivePass backup shape", () => {
  const [e] = detectAndImportJSON(JSON.stringify({ entries: [{ name: "Kept", password: "p" }] }));
  assert.equal(e.name, "Kept");
});

test("detectAndImportFile picks the format and falls back to CSV", () => {
  assert.equal(detectAndImportFile('[{"name":"J","password":"p"}]')[0].name, "J");
  assert.equal(detectAndImportFile("name,password\nC,p\n")[0].name, "C");
  // Looks like JSON but isn't — must not throw, should try CSV instead.
  assert.deepEqual(detectAndImportFile("{not json at all"), []);
});

test("every imported entry gets its own id", () => {
  const rows = detectAndImportCSV("name,password\nA,1\nB,2\nC,3\n");
  assert.equal(new Set(rows.map((e) => e.id)).size, 3);
});

// ---- export --------------------------------------------------------------

test("exported CSV round-trips back through the importer", () => {
  const original = [
    { name: "Corp, Inc", url: "https://x.com", username: "u", password: 'a"b', totp: "", notes: "line1\nline2", type: "login" },
  ];
  const [e] = detectAndImportCSV(exportToCSV(original));
  assert.equal(e.name, "Corp, Inc");
  assert.equal(e.password, 'a"b');
  assert.equal(e.notes, "line1\nline2");
});

test("export neutralizes spreadsheet formula injection", () => {
  // A name like this can arrive from a page title via the save prompt.
  const csv = exportToCSV([
    { name: "=HYPERLINK(\"http://evil\",\"click\")", password: "+1+1", username: "-2", notes: "@SUM(A1)" },
  ]);
  assert.ok(csv.includes(`"'=HYPERLINK`), "leading = must be quoted off");
  assert.ok(csv.includes(`"'+1+1"`), "leading + must be quoted off");
  assert.ok(csv.includes(`"'-2"`), "leading - must be quoted off");
  assert.ok(csv.includes(`"'@SUM(A1)"`), "leading @ must be quoted off");
});

test("export leaves ordinary values untouched", () => {
  const csv = exportToCSV([{ name: "GitHub", url: "https://github.com", username: "a", password: "p" }]);
  assert.ok(csv.includes('"GitHub"'));
  assert.ok(!csv.includes("'GitHub"));
});

test("export writes a header row and one line per entry", () => {
  const lines = exportToCSV([{ name: "A" }, { name: "B" }]).split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "name,url,username,password,totp,notes,type");
});

test("export handles missing fields without writing 'undefined'", () => {
  const csv = exportToCSV([{ name: "OnlyName" }]);
  assert.ok(!csv.includes("undefined"), csv);
  assert.ok(csv.includes('"login"'), "type should default");
});
