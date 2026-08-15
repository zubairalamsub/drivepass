// The icon sprite is inlined into the HTML pages so icons are painted on the
// first frame, but src/lib/icons.js is the source of truth. Nothing stops the
// two copies drifting except this test — and a drifted <use> renders as an
// invisible gap, not an error, so it would ship unnoticed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { SPRITE, iconHTML } from "../src/lib/icons.js";

const PAGES = ["src/popup/popup.html"];

const symbolIds = (markup) =>
  new Set([...markup.matchAll(/<symbol\s+id="([^"]+)"/g)].map((m) => m[1]));

const usedIds = (markup) =>
  new Set([...markup.matchAll(/<use\s+href="#([^"]+)"/g)].map((m) => m[1]));

const canonical = symbolIds(SPRITE);

test("the canonical sprite defines symbols", () => {
  assert.ok(canonical.size >= 20, `only ${canonical.size} symbols defined`);
  for (const id of canonical) {
    assert.match(id, /^i-[a-z0-9-]+$/, `symbol id "${id}" breaks the i-* convention`);
  }
});

test("every symbol has a 24x24 viewBox", () => {
  // Mixed viewBoxes make stroke weights inconsistent between icons.
  const symbols = [...SPRITE.matchAll(/<symbol\s+id="([^"]+)"\s+viewBox="([^"]+)"/g)];
  assert.equal(symbols.length, canonical.size, "a symbol is missing its viewBox");
  for (const [, id, box] of symbols) {
    assert.equal(box, "0 0 24 24", `${id} uses viewBox "${box}"`);
  }
});

for (const page of PAGES) {
  test(`${page} inlines exactly the canonical symbol set`, () => {
    assert.ok(existsSync(page), `${page} not found`);
    const html = readFileSync(page, "utf8");
    const inlined = symbolIds(html);

    const missing = [...canonical].filter((id) => !inlined.has(id));
    const extra = [...inlined].filter((id) => !canonical.has(id));

    assert.deepEqual(missing, [], `${page} is missing symbols from icons.js`);
    assert.deepEqual(extra, [], `${page} defines symbols that icons.js does not`);
  });

  test(`${page} only references icons that exist`, () => {
    const html = readFileSync(page, "utf8");
    const undefinedRefs = [...usedIds(html)].filter((id) => !canonical.has(id));
    assert.deepEqual(undefinedRefs, [], `<use> points at symbols that are not defined`);
  });
}

test("icons built from script reference real symbols", () => {
  // Names passed to iconHTML are strings, so a typo is invisible until render.
  const js = readFileSync("src/popup/popup.js", "utf8");
  const names = [...js.matchAll(/iconHTML\(\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0, "expected popup.js to build some icons");
  for (const name of new Set(names)) {
    assert.ok(canonical.has(`i-${name}`), `iconHTML("${name}") has no matching symbol`);
  }
});

test("iconHTML emits a use reference to the named symbol", () => {
  const html = iconHTML("key");
  assert.match(html, /<svg class="icon"/);
  assert.match(html, /href="#i-key"/);
  assert.match(html, /aria-hidden="true"/);
});

test("icons are decorative and hidden from assistive tech", () => {
  // Every icon sits next to a text label or a titled/aria-labelled control, so
  // exposing them to a screen reader would just duplicate the label.
  const html = readFileSync("src/popup/popup.html", "utf8");
  const svgs = [...html.matchAll(/<svg class="icon"[^>]*>/g)].map((m) => m[0]);
  assert.ok(svgs.length > 0);
  for (const svg of svgs) {
    assert.match(svg, /aria-hidden="true"/, `icon missing aria-hidden: ${svg}`);
  }
});

test("icon-only buttons carry an accessible name", () => {
  const html = readFileSync("src/popup/popup.html", "utf8");
  // <button ...>…</button> blocks whose content is only an svg + whitespace.
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
  const iconOnly = buttons.filter((b) => {
    const inner = b.replace(/^<button\b[^>]*>/, "").replace(/<\/button>$/, "");
    return /<svg/.test(inner) && !/<span|[A-Za-z0-9](?![^<]*>)/.test(inner.replace(/<svg[\s\S]*?<\/svg>/g, ""));
  });
  assert.ok(iconOnly.length > 0, "expected some icon-only buttons");
  for (const b of iconOnly) {
    const openTag = b.match(/^<button\b[^>]*>/)[0];
    assert.match(openTag, /aria-label="|title="/, `icon-only button has no name: ${openTag}`);
  }
});
