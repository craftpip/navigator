import { BROWSER_TYPES } from "./constants.js";

export function normalizeBrowserType(e) {
  const t = typeof e.type === "string" ? e.type.trim().toLowerCase() : "";
  if (t) return BROWSER_TYPES.some((x) => x.value === t) ? t : "cdp";
  return e.name === "chromium" ? "inbuilt" : "cdp";
}

export function parseBrowsersEntries(rawValue) {
  let parsed;
  try {
    parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
  } catch { return []; }
  return Array.isArray(parsed) ? parsed.map((e) => ({
      name: e.name || "",
      role: Array.isArray(e.role) ? e.role : [],
      index: typeof e.index === "number" ? e.index : 0,
      type: normalizeBrowserType(e),
      cdpUrl: e.cdpUrl || "",
      plugin: typeof e.plugin === "string" && e.plugin ? e.plugin : "auto",
    })) : [];
}

export function serializeBrowsersEntries(entries) {
  return JSON.stringify(entries.map((e, i) => {
    const out = { name: e.name, role: e.role, index: i, type: e.type || normalizeBrowserType(e) };
    if (out.type === "cdp" && e.cdpUrl) out.cdpUrl = e.cdpUrl;
    if (out.type === "navigator-cdp" && e.plugin && e.plugin !== "auto") out.plugin = e.plugin;
    return out;
  }), null, 2);
}