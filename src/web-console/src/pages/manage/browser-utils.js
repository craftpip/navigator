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
      prompt: typeof e.prompt === "string" ? e.prompt : "",
    })) : [];
}

export function serializeBrowsersEntries(entries) {
  return JSON.stringify(entries.map((e, i) => {
    const out = { name: e.name, role: e.role, index: i, type: e.type || normalizeBrowserType(e) };
    if (out.type === "cdp" && e.cdpUrl) out.cdpUrl = e.cdpUrl;
    if (out.type === "navigator-cdp" && e.plugin && e.plugin !== "auto") out.plugin = e.plugin;
    if (out.type !== "inbuilt" && e.prompt) out.prompt = e.prompt;
    return out;
  }), null, 2);
}

/**
 * The built-in Chromium has no editable prompt — the agent is told where it
 * sits in the execution order instead (kept in sync with
 * builtinBrowserPrompt() in src/browser.js). `index` is the entry's position
 * in the BROWSERS array (all entries, add-ons included).
 */
export function builtinBrowserPrompt(entries, index) {
  const total = entries.length;
  if (total <= 1) {
    return "Built-in Chromium — the only configured browser; always used for every role.";
  }
  const position = index + 1;
  if (position === 1) {
    return "Built-in Chromium — listed first in the execution order (primary). The add-ons after it are fallbacks for the roles they cover.";
  }
  return (
    `Built-in Chromium — browser #${position} of ${total} in the execution order. ` +
    `The ${position - 1} browser(s) listed before it are preferred and tried first; ` +
    "the built-in is used only when those are unavailable."
  );
}