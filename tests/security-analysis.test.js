// The Security Center's password-health analysis: the number a user trusts when
// deciding whether their vault needs work. A silent change here (a shifted
// boundary, a mis-weighted issue) doesn't crash anything — it just tells people
// they are safe when they aren't, so the arithmetic deserves pinning.
//
// APPROACH — src/security/security.js is a page script, not a module with
// exports: charsetCount/isWeak/analyze/calculateScore are module-private and
// the file calls applyTheme() and init() on import. Rather than refactor src/
// (forbidden) or paste copies of the functions here (which would silently drift
// the moment someone edits the real ones), this suite CUTS THE REAL FUNCTION
// TEXT out of security.js by brace-matching and evaluates just those
// declarations in a node:vm context. So every assertion below runs the shipped
// code: change a body and these tests change with it. The extractor refuses to
// guess — a rename, a deletion, or text it cannot balance throws, which fails
// the suite loudly instead of letting it test a stale copy.
//
// The vm context also lets us hand `analyze` a fake Date.now(), so the "older
// than a year" boundary is tested exactly instead of approximately, and lets us
// set the module-level `entries` / `health` / `breachedByPassword` that
// calculateScore reads out of closure scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC_PATH = fileURLToPath(new URL("../src/security/security.js", import.meta.url));
const SRC = readFileSync(SRC_PATH, "utf8");

// ---- extracting the real functions ---------------------------------------

// Returns the verbatim text of `function <name>(…) { … }` from security.js.
// Brace counting is deliberately naive: these four bodies contain no braces
// inside strings or regexes today, and if that ever changes the extracted text
// stops parsing and the suite goes red rather than quietly wrong.
function sliceDeclaration(name, src = SRC) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) {
    throw new Error(`security.js no longer declares function ${name}() — update tests/security-analysis.test.js`);
  }
  if (src.indexOf(`function ${name}(`, start + 1) !== -1) {
    throw new Error(`security.js declares function ${name}() more than once — extraction is ambiguous`);
  }
  let depth = 0;
  for (let i = src.indexOf("{", src.indexOf(")", start)); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`could not find the end of ${name}() — unbalanced braces in the extracted range`);
}

function sliceConst(name, src = SRC) {
  const m = src.match(new RegExp(`^const ${name} = .*;$`, "m"));
  if (!m) throw new Error(`security.js no longer declares const ${name} at top level`);
  return m[0];
}

const buildAnalysisSource = (src = SRC) =>
  [
    sliceConst("YEAR_MS", src),
    sliceDeclaration("charsetCount", src),
    sliceDeclaration("isWeak", src),
    sliceDeclaration("analyze", src),
    sliceDeclaration("calculateScore", src),
    // A top-level `const` lives in the context's lexical scope, which is invisible
    // from the sandbox object, so re-publish it for the boundary tests.
    "globalThis.YEAR_MS = YEAR_MS;",
  ].join("\n\n");

const ANALYSIS_SOURCE = buildAnalysisSource();

// A fresh realm per call: `entries` / `health` / `breachedByPassword` are the
// page's module-level state, and tests must not leak them into each other.
function loadAnalysis({ now, source = ANALYSIS_SOURCE } = {}) {
  const sandbox = { entries: [], health: null, breachedByPassword: null };
  vm.createContext(sandbox);
  if (now !== undefined) sandbox.Date = { now: () => now };
  vm.runInContext(source, sandbox, { filename: SRC_PATH });
  return sandbox;
}

const pure = loadAnalysis(); // charsetCount/isWeak never touch the clock or module state
const { charsetCount, isWeak } = pure;
const YEAR_MS = pure.YEAR_MS;

const FIXED_NOW = Date.UTC(2026, 0, 15);

// Healthy by default — 2FA on, updated today, and a strong password that is
// unique per entry so nothing counts as reuse unless a test says so. Each test
// perturbs one dimension and reads the resulting penalty.
const STRONG = "Xk9#mQ2vLp4nR7wZ"; // 16 chars, all four character classes
let seq = 0;
const entry = (over = {}) => {
  const n = ++seq;
  return {
    id: `e${n}`,
    type: "login",
    password: `${STRONG}-${n}`,
    totp: "JBSWY3DPEHPK3PXP",
    updatedAt: FIXED_NOW,
    ...over,
  };
};

const analyzeAt = (list, now = FIXED_NOW) => loadAnalysis({ now }).analyze(list);

// Mirrors what init() does before calling calculateScore(): score only entries
// that have a password, but analyze the whole vault. See the fidelity test below.
function scoreFor(list, { now = FIXED_NOW, breached = null } = {}) {
  const ctx = loadAnalysis({ now });
  ctx.entries = list.filter((e) => e.password);
  ctx.health = ctx.analyze(list);
  if (breached) ctx.breachedByPassword = new Map(Object.entries(breached));
  return ctx.calculateScore();
}

// Arrays built inside the vm come from another realm, so pull them into this
// one before comparing.
const idsOf = (list) => Array.from(list, (e) => e.id);
const sizesOf = (groups) => Array.from(groups, (g) => g.length);

// ---- the extraction itself -------------------------------------------------

test("the extractor refuses to guess, so a rename in security.js fails this suite instead of testing a stale copy", () => {
  assert.throws(() => sliceDeclaration("charsetCounts"), /charsetCounts/);
  assert.throws(() => sliceConst("YEAR_MSS"), /YEAR_MSS/);
});

test("edits to the real function bodies show up here — the behaviour under test is the file's, not a copy", () => {
  // If the extraction ever stopped tracking security.js (a pasted duplicate, a
  // stale build artefact) this would keep reporting the original boundary.
  const mutated = buildAnalysisSource(SRC.replace("pw.length < 8", "pw.length < 9"));
  assert.notEqual(mutated, ANALYSIS_SOURCE, "the mutation must actually apply for this to prove anything");
  assert.equal(isWeak("aB3!efgh"), false, "8 chars, 4 classes passes today");
  assert.equal(
    loadAnalysis({ source: mutated }).isWeak("aB3!efgh"),
    true,
    "and fails once the source says 9"
  );
});

test("init still analyses the whole vault while scoring only entries that have a password", () => {
  // scoreFor() reproduces these two lines; if the wiring moves, the helper lies.
  assert.match(SRC, /entries = allVaultEntries\.filter\(\(e\) => e\.password\)/);
  assert.match(SRC, /health = analyze\(allVaultEntries\)/);
});

// ---- charsetCount ----------------------------------------------------------

test("charsetCount counts lower, upper, digit and symbol once each", () => {
  assert.equal(charsetCount("abcdefgh"), 1);
  assert.equal(charsetCount("ABCDEFGH"), 1);
  assert.equal(charsetCount("12345678"), 1);
  assert.equal(charsetCount("!@#$%^&*"), 1);
  assert.equal(charsetCount("abcABC"), 2);
  assert.equal(charsetCount("abcABC123"), 3);
  assert.equal(charsetCount("abcABC123!"), 4);
  assert.equal(charsetCount("aaaaAAAA1111!!!!"), 4, "repetition does not inflate the class count");
  assert.equal(charsetCount(""), 0);
});

test("charsetCount files every non-ASCII character under the symbol class", () => {
  // The "symbol" test is /[^a-zA-Z0-9]/, so accented and non-Latin letters are
  // credited as punctuation-grade variety even though they are just letters.
  assert.equal(charsetCount("café"), 2, "lowercase + the e-acute counted as a symbol");
  assert.equal(charsetCount("パスワード"), 1, "an all-katakana password looks like one class of symbols");
  assert.equal(charsetCount("ΩΜΕΓΑ"), 1, "Greek capitals are not [A-Z], so they land in the symbol class");
});

// ---- isWeak ----------------------------------------------------------------

test("a password under 8 characters is weak no matter how varied", () => {
  assert.equal(isWeak("aB3!efg"), true, "7 chars using all four classes is still weak");
  assert.equal(isWeak("aB3!"), true);
  assert.equal(isWeak(""), true);
});

test("at exactly 8 characters weakness switches over to character variety", () => {
  assert.equal(isWeak("abcdefgh"), true, "8 chars, 1 class");
  assert.equal(isWeak("abcdEFgh"), true, "8 chars, 2 classes");
  assert.equal(isWeak("abcdEF12"), false, "8 chars, 3 classes clears the bar");
  assert.equal(isWeak("aB3!efgh"), false, "8 chars, 4 classes");
});

test("the variety requirement stops applying at exactly 12 characters", () => {
  assert.equal(isWeak("abcdEFghijk"), true, "11 chars with 2 classes is weak");
  assert.equal(isWeak("abcdEF12ijk"), false, "11 chars with 3 classes is not");
  assert.equal(isWeak("abcdEFghijkl"), false, "the same 2 classes at 12 chars is not weak");
  assert.equal(isWeak("abcdefghijkl"), false, "and neither is 12 chars of one class");
});

test("a long single-class password is never called weak, however guessable", () => {
  // Length alone satisfies isWeak, so nothing here flags a password that is in
  // every breach list. Only the opt-in HIBP check would catch these.
  assert.equal(isWeak("passwordpassword"), false);
  assert.equal(isWeak("aaaaaaaaaaaaaaaaaaaaaaaa"), false);
  assert.equal(isWeak("correcthorsebatterystaple"), false);
});

test("one accented character is enough to promote an 8-character password out of weak", () => {
  // Same length, same real-world guessability; the accent only buys a class
  // because the symbol test is "not ASCII alphanumeric".
  assert.equal(isWeak("cafe1234"), true);
  assert.equal(isWeak("café1234"), false);
});

test("a password that is not a string is treated as strong (current behaviour)", () => {
  // CURRENT BEHAVIOUR, and a defect: a JSON import can carry password: 12345678
  // as a number (newEntry keeps it), and then `pw.length` is undefined, both
  // comparisons are false, and isWeak returns false.
  assert.equal(isWeak(12345678), false);
  assert.equal(charsetCount(12345678), 1, "the regexes still coerce, so only the length checks fail open");
});

// ---- analyze: reuse --------------------------------------------------------

test("only passwords shared by two or more entries form a reuse group", () => {
  const health = analyzeAt([
    entry({ id: "a", password: "shared-by-two-Aa1!" }),
    entry({ id: "b", password: "shared-by-two-Aa1!" }),
    entry({ id: "c", password: STRONG }),
  ]);
  assert.deepEqual(sizesOf(health.reusedGroups), [2]);
  assert.deepEqual(idsOf(health.reusedGroups[0]), ["a", "b"]);
});

test("a vault where every password is unique reports no reuse at all", () => {
  const health = analyzeAt([entry({ password: "Unique-One-1!" }), entry({ password: "Unique-Two-2!" })]);
  assert.deepEqual(sizesOf(health.reusedGroups), []);
});

test("each shared password gets its own group, sized by how many entries use it", () => {
  const health = analyzeAt([
    entry({ password: "Alpha-Aa1!" }),
    entry({ password: "Alpha-Aa1!" }),
    entry({ password: "Alpha-Aa1!" }),
    entry({ password: "Beta-Bb2!" }),
    entry({ password: "Beta-Bb2!" }),
    entry({ password: STRONG }),
  ]);
  assert.deepEqual(sizesOf(health.reusedGroups), [3, 2]);
  assert.equal(health.reusedGroups.flat().length, 5, "the score counts entries, not groups");
});

test("entries with no password never count as reusing each other", () => {
  // Cards and notes both carry password: "" — without the filter they would all
  // look like one enormous reuse group.
  const health = analyzeAt([
    entry({ type: "card", password: "" }),
    entry({ type: "note", password: "" }),
    entry({ type: "login", password: "" }),
  ]);
  assert.deepEqual(sizesOf(health.reusedGroups), []);
  assert.deepEqual(idsOf(health.weak), []);
});

test("reuse is exact, so a password stored as a number does not group with its string twin", () => {
  // CURRENT BEHAVIOUR: the Map keys on the raw value, so an imported numeric
  // password hides the reuse.
  const health = analyzeAt([entry({ password: 12345678 }), entry({ password: "12345678" })]);
  assert.deepEqual(sizesOf(health.reusedGroups), []);
});

// ---- analyze: weak and old -------------------------------------------------

test("analyze flags exactly the entries isWeak rejects, ignoring passwordless ones", () => {
  const health = analyzeAt([
    entry({ id: "weak", password: "abc123" }),
    entry({ id: "strong", password: STRONG }),
    entry({ id: "empty", password: "" }),
  ]);
  assert.deepEqual(idsOf(health.weak), ["weak"]);
});

test("a password is old only once it is strictly more than a year stale", () => {
  const health = analyzeAt([
    entry({ id: "just-under", updatedAt: FIXED_NOW - YEAR_MS + 1 }),
    entry({ id: "exactly-a-year", updatedAt: FIXED_NOW - YEAR_MS }),
    entry({ id: "a-millisecond-over", updatedAt: FIXED_NOW - YEAR_MS - 1 }),
  ]);
  assert.deepEqual(idsOf(health.old), ["a-millisecond-over"]);
});

test("the year boundary follows the clock, not the vault", () => {
  const list = [entry({ id: "x", updatedAt: FIXED_NOW })];
  assert.deepEqual(idsOf(analyzeAt(list, FIXED_NOW + YEAR_MS).old), [], "one year later: still fresh");
  assert.deepEqual(idsOf(analyzeAt(list, FIXED_NOW + YEAR_MS + 1).old), ["x"], "a tick after that: old");
});

test("an entry with no updatedAt is reported as old rather than skipped", () => {
  // `e.updatedAt || 0` dates it to the epoch, so it is always more than a year
  // stale — and the row's tag renders as hundreds of months.
  const health = analyzeAt([entry({ id: "undated", updatedAt: undefined }), entry({ id: "dated" })]);
  assert.deepEqual(idsOf(health.old), ["undated"]);
});

// ---- analyze: missing 2FA --------------------------------------------------

test("missing-2FA covers logins only, and an absent type counts as a login", () => {
  const health = analyzeAt([
    entry({ id: "login-with-totp" }),
    entry({ id: "login-without-totp", totp: "" }),
    entry({ id: "untyped", type: undefined, totp: "" }),
    entry({ id: "card", type: "card", totp: "" }),
    entry({ id: "note", type: "note", totp: "" }),
    entry({ id: "passkey", type: "passkey", totp: "" }),
  ]);
  assert.deepEqual(idsOf(health.missingTotp), ["login-without-totp", "untyped"]);
});

test("any falsy totp counts as missing 2FA", () => {
  const health = analyzeAt([
    entry({ id: "empty-string", totp: "" }),
    entry({ id: "absent", totp: undefined }),
    entry({ id: "null", totp: null }),
    entry({ id: "present" }),
  ]);
  assert.deepEqual(idsOf(health.missingTotp), ["empty-string", "absent", "null"]);
});

test("a login with no password still counts as missing 2FA", () => {
  // Unlike reuse/weak/old, missingTotp is computed over the whole vault, so
  // entries with nothing to protect still show up in the audit.
  const health = analyzeAt([entry({ id: "no-password", password: "", totp: "" })]);
  assert.deepEqual(idsOf(health.missingTotp), ["no-password"]);
  assert.deepEqual(idsOf(health.weak), []);
});

// ---- calculateScore --------------------------------------------------------

test("a vault with no issues scores 100 and cannot exceed it", () => {
  assert.equal(scoreFor([entry(), entry(), entry()]), 100);
});

test("each kind of issue costs its own fixed number of points", () => {
  const breachedEntry = entry();
  assert.equal(scoreFor([entry({ updatedAt: FIXED_NOW - YEAR_MS - 1 })]), 96, "old: 4");
  assert.equal(scoreFor([entry({ totp: "" })]), 98, "missing 2FA: 2");
  assert.equal(scoreFor([entry({ password: "abc123" })]), 88, "weak: 12");
  assert.equal(
    scoreFor([breachedEntry], { breached: { [breachedEntry.password]: 1 } }),
    75,
    "breached: 25"
  );
  assert.equal(
    scoreFor([entry({ password: "Shared-Aa1!x" }), entry({ password: "Shared-Aa1!x" })]),
    84,
    "reused: 8 per entry in a group, not 8 per group"
  );
});

test("penalties from different issues add up on the same entry", () => {
  // One entry, three findings: 12 (weak) + 4 (old) + 2 (no 2FA).
  assert.equal(scoreFor([entry({ password: "abc123", totp: "", updatedAt: 0 })]), 82);
});

test("one weak password shared by two logins is charged as both weak and reused", () => {
  // CURRENT BEHAVIOUR, and arguably a defect: a single root cause (one bad
  // password) is billed twice per entry — 8 for reuse plus 12 for weakness.
  assert.equal(scoreFor([entry({ password: "abc123" }), entry({ password: "abc123" })]), 60);
});

test("a breached password shared by three logins is charged per entry on both counts", () => {
  // 3 x 8 (reuse) + 3 x 25 (breach) = 99, from a single compromised secret.
  const list = [entry({ password: STRONG }), entry({ password: STRONG }), entry({ password: STRONG })];
  assert.equal(scoreFor(list, { breached: { [STRONG]: 4200 } }), 1);
});

test("the score floors at 0 instead of going negative", () => {
  const shared = "abc123";
  const list = [entry({ password: shared }), entry({ password: shared }), entry({ password: shared })];
  assert.equal(scoreFor(list, { breached: { [shared]: 9 } }), 0);
});

test("a breach map that does not list a password leaves that entry unpenalised", () => {
  const e = entry();
  assert.equal(scoreFor([e], { breached: { "some-other-password": 5 } }), 100);
  assert.equal(scoreFor([e], { breached: { [e.password]: 0 } }), 100, "a zero count is not a breach");
});

test("an empty vault scores 100", () => {
  assert.equal(scoreFor([]), 100);
});

test("a vault of passwordless logins scores 100 even though the 2FA audit is full of them", () => {
  // CURRENT BEHAVIOUR, and a defect: the `!entries.length` short-circuit looks
  // at entries WITH passwords, so these three findings are never priced in.
  const list = [
    entry({ password: "", totp: "" }),
    entry({ password: "", totp: "" }),
    entry({ password: "", totp: "" }),
  ];
  assert.equal(analyzeAt(list).missingTotp.length, 3);
  assert.equal(scoreFor(list), 100);
});

test("but passwordless logins do drag the score down as soon as one real password exists", () => {
  // The same three entries cost 6 points here purely because a fourth entry
  // unlocked the scoring path — the score depends on unrelated vault contents.
  const list = [
    entry(),
    entry({ password: "", totp: "" }),
    entry({ password: "", totp: "" }),
    entry({ password: "", totp: "" }),
  ];
  assert.equal(scoreFor(list), 94);
});
