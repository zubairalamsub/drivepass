// icons.js — the DrivePass icon set as one inline SVG sprite.
//
// Why not emoji: emoji are drawn by the OS, so the "same" icon is a different
// shape, weight and colour on Windows, macOS and Linux, can't inherit the text
// colour, and reads as informal in a security product. Why not an icon font or
// a CDN: both are network requests, and this extension deliberately makes none.
//
// Each symbol is a 24x24 outline drawn with stroke=currentColor (see .icon in
// common.css), so an icon always matches the colour of the text beside it and
// works in either theme with no per-theme assets.
//
// Usage in markup:  <svg class="icon"><use href="#i-key"></use></svg>
// The sprite must exist in the document first — call injectSprite() before the
// first paint that needs icons, or inline SPRITE directly into the HTML.

export const SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
  <symbol id="i-key" viewBox="0 0 24 24">
    <circle cx="8" cy="8" r="4.25"/><path d="M11 11l8.5 8.5M16 16l2.25-2.25M18.5 18.5L21 16"/>
  </symbol>
  <symbol id="i-lock" viewBox="0 0 24 24">
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>
  </symbol>
  <symbol id="i-unlock" viewBox="0 0 24 24">
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 7.7-1.5"/>
  </symbol>
  <symbol id="i-shield" viewBox="0 0 24 24">
    <path d="M12 3l7 3v5.5c0 4.4-3 8.2-7 9.5-4-1.3-7-5.1-7-9.5V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>
  </symbol>
  <symbol id="i-settings" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>
  </symbol>
  <symbol id="i-vault" viewBox="0 0 24 24">
    <rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="11" cy="12" r="3.5"/><path d="M11 8.5v-1M11 16.5v1M18 9.5v5"/>
  </symbol>
  <symbol id="i-clock" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>
  </symbol>
  <symbol id="i-dice" viewBox="0 0 24 24">
    <rect x="4" y="4" width="16" height="16" rx="3.5"/>
    <circle cx="9" cy="9" r="1.15" class="dot"/><circle cx="15" cy="15" r="1.15" class="dot"/><circle cx="15" cy="9" r="1.15" class="dot"/><circle cx="9" cy="15" r="1.15" class="dot"/>
  </symbol>
  <symbol id="i-card" viewBox="0 0 24 24">
    <rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h3"/>
  </symbol>
  <symbol id="i-note" viewBox="0 0 24 24">
    <path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h5M9 12.5h6M9 16h4"/>
  </symbol>
  <symbol id="i-passkey" viewBox="0 0 24 24">
    <circle cx="9.5" cy="8" r="3.75"/><path d="M3.5 20c0-3.3 2.7-5.5 6-5.5 1 0 2 .2 2.8.6"/><path d="M15.5 15.5h5.5M18 13v5"/>
  </symbol>
  <symbol id="i-search" viewBox="0 0 24 24">
    <circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8L20.5 20.5"/>
  </symbol>
  <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></symbol>
  <symbol id="i-copy" viewBox="0 0 24 24">
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>
  </symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></symbol>
  <symbol id="i-star" viewBox="0 0 24 24">
    <path d="M12 3.75l2.6 5.28 5.83.85-4.22 4.11 1 5.81L12 17.05l-5.21 2.75 1-5.81-4.22-4.11 5.83-.85z"/>
  </symbol>
  <symbol id="i-eye" viewBox="0 0 24 24">
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>
  </symbol>
  <symbol id="i-eye-off" viewBox="0 0 24 24">
    <path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.3 4.1M6.3 7.9A17 17 0 0 0 2.5 12S6 18.5 12 18.5c1.3 0 2.4-.3 3.4-.7"/>
    <path d="M10 10a2.8 2.8 0 0 0 4 4M3.5 3.5l17 17"/>
  </symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24">
    <path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>
  </symbol>
  <symbol id="i-cloud-ok" viewBox="0 0 24 24">
    <path d="M7 18.5a4.25 4.25 0 0 1-.4-8.48 5.5 5.5 0 0 1 10.6-1.4A4.25 4.25 0 0 1 17.5 18.5z"/><path d="M9.5 14l2 2 3.5-3.8"/>
  </symbol>
  <symbol id="i-cloud-off" viewBox="0 0 24 24">
    <path d="M7 18.5a4.25 4.25 0 0 1-.4-8.48 5.5 5.5 0 0 1 10.6-1.4A4.25 4.25 0 0 1 17.5 18.5z"/><path d="M3.5 3.5l17 17"/>
  </symbol>
  <symbol id="i-trash" viewBox="0 0 24 24">
    <path d="M4.5 7h15M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7"/>
    <path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12"/>
  </symbol>
  <symbol id="i-camera" viewBox="0 0 24 24">
    <path d="M3.5 8.5h3L8 6h8l1.5 2.5h3v11h-17z"/><circle cx="12" cy="13.5" r="3.5"/>
  </symbol>
  <symbol id="i-image" viewBox="0 0 24 24">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.75"/><path d="M4 17l4.5-4.5 3.5 3.5 3-2.5 5 4.5"/>
  </symbol>
  <symbol id="i-chat" viewBox="0 0 24 24">
    <path d="M20.5 12.5c0 3.9-3.8 7-8.5 7-1 0-2-.15-2.9-.42L4 20.5l1.5-3.6A6.7 6.7 0 0 1 3.5 12.5c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7z"/>
  </symbol>
  <symbol id="i-back" viewBox="0 0 24 24"><path d="M14.5 5.5L8 12l6.5 6.5"/></symbol>
  <symbol id="i-close" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
  <symbol id="i-chevron" viewBox="0 0 24 24"><path d="M8.5 5.5L15 12l-6.5 6.5"/></symbol>
  <symbol id="i-alert" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="8.5"/><path d="M12 7.75v5M12 16.1v.05"/>
  </symbol>
</svg>`;

// Put the sprite in the document so `<use href="#i-...">` resolves. Idempotent.
export function injectSprite(doc = document) {
  if (doc.getElementById("dp-icon-sprite")) return;
  const host = doc.createElement("div");
  host.id = "dp-icon-sprite";
  host.style.display = "none";
  host.innerHTML = SPRITE;
  doc.body.insertBefore(host, doc.body.firstChild);
}

// Build an <svg class="icon"><use/></svg> for icons created from script.
export function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

// Same thing as a markup string, for the innerHTML templates in the UI.
export function iconHTML(name, className = "icon") {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}
