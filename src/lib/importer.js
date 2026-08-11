// importer.js — CSV import / export parser for Bitwarden, LastPass, Chrome, 1Password.
import { newEntry } from "./vault.js";

function parseCSV(text) {
  const lines = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && next === "\n") i++;
        row.push(cell);
        if (row.some((c) => c.trim().length > 0)) lines.push(row);
        row = [];
        cell = "";
      } else {
        cell += ch;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((c) => c.trim().length > 0)) lines.push(row);
  }
  return lines;
}

export function detectAndImportFile(fileContent) {
  const trimmed = fileContent.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return detectAndImportJSON(trimmed);
    } catch {
      /* fall back to CSV if JSON parse fails */
    }
  }
  return detectAndImportCSV(fileContent);
}

export function detectAndImportJSON(jsonContent) {
  const parsed = JSON.parse(jsonContent);
  const imported = [];

  // Case 1: DrivePass backup ({ format, entries: [...] })
  if (parsed && Array.isArray(parsed.entries)) {
    return parsed.entries.map((e) => newEntry(e));
  }

  // Case 2: Bitwarden JSON export ({ items: [...] })
  if (parsed && Array.isArray(parsed.items)) {
    for (const item of parsed.items) {
      if (!item) continue;
      const login = item.login || {};
      const card = item.card || {};
      const uri = (login.uris && login.uris[0] && login.uris[0].uri) || item.uri || "";
      
      let type = "login";
      if (item.type === 2) type = "card";
      else if (item.type === 3) type = "note";

      imported.push(
        newEntry({
          type,
          name: item.name || uri || login.username || "Bitwarden Import",
          url: uri,
          username: login.username || "",
          password: login.password || "",
          totp: login.totp || "",
          notes: item.notes || "",
          card: {
            holder: card.cardholderName || "",
            number: card.number || "",
            expMonth: card.expMonth || "",
            expYear: card.expYear || "",
            cvv: card.code || "",
          },
        })
      );
    }
    return imported;
  }

  // Case 3: Array of objects ([ { name, url, username, password, ... } ])
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of list) {
    if (typeof item !== "object" || !item) continue;
    const name = item.name || item.title || item.name || "";
    const url = item.url || item.website || item.uri || "";
    const username = item.username || item.login_username || item.user || "";
    const password = item.password || item.login_password || "";

    if (!name && !url && !username && !password) continue;

    imported.push(
      newEntry({
        type: item.type || "login",
        name: name || url || username || "Imported Item",
        url,
        username,
        password,
        totp: item.totp || item.login_totp || "",
        notes: item.notes || item.extra || "",
        card: item.card || { number: "", expMonth: "", expYear: "", cvv: "", holder: "" },
      })
    );
  }

  return imported;
}

export function detectAndImportCSV(csvContent) {
  const rows = parseCSV(csvContent);
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const dataRows = rows.slice(1);
  const imported = [];

  const findCol = (...names) => {
    for (const name of names) {
      const idx = headers.indexOf(name.toLowerCase());
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const idxName = findCol("name", "title", "login_name");
  const idxUrl = findCol("url", "login_uri", "website", "uri");
  const idxUser = findCol("username", "login_username", "login_user", "email");
  const idxPass = findCol("password", "login_password");
  const idxNotes = findCol("notes", "extra", "note", "comment");
  const idxTotp = findCol("login_totp", "totp", "2fa");
  const idxType = findCol("type");

  for (const row of dataRows) {
    const name = idxName !== -1 ? row[idxName] : "";
    const url = idxUrl !== -1 ? row[idxUrl] : "";
    const username = idxUser !== -1 ? row[idxUser] : "";
    const password = idxPass !== -1 ? row[idxPass] : "";
    const notes = idxNotes !== -1 ? row[idxNotes] : "";
    const totp = idxTotp !== -1 ? row[idxTotp] : "";
    const typeVal = idxType !== -1 ? row[idxType] : "";

    if (!name && !url && !username && !password) continue;

    let type = "login";
    if (typeVal.toLowerCase().includes("note") || (!username && !password && notes)) {
      type = notes ? "note" : "login";
    }

    const entry = newEntry({
      name: name || url || username || "Imported Login",
      url,
      username,
      password,
      notes,
      type,
    });
    if (totp) entry.totp = totp;
    imported.push(entry);
  }

  return imported;
}

export function exportToCSV(entries) {
  const headers = ["name", "url", "username", "password", "totp", "notes", "type"];
  const rows = [headers.join(",")];

  for (const e of entries) {
    const fields = [
      e.name || "",
      e.url || "",
      e.username || "",
      e.password || "",
      e.totp || "",
      e.notes || "",
      e.type || "login",
    ];
    const escaped = fields.map((f) => `"${String(f).replace(/"/g, '""')}"`);
    rows.push(escaped.join(","));
  }

  return rows.join("\n");
}
