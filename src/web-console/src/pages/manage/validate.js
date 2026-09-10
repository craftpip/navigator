export function validateEntryValue(entry, value, engineIds) {
  const raw = String(value ?? "");
  const type = entry.type || "string";
  if (raw === "") {
    const enumAllowsEmpty = (entry.values || []).includes("");
    if ((type === "enum" && !enumAllowsEmpty) || type === "boolean") {
      return { ok: false, message: "Choose a value." };
    }
    return { ok: true };
  }
  switch (type) {
    case "boolean":
      return raw === "true" || raw === "false" || raw === "1" || raw === "0"
        ? { ok: true }
        : { ok: false, message: "Must be true or false." };
    case "number":
      return Number.isFinite(Number(raw))
        ? { ok: true }
        : { ok: false, message: "Must be a number." };
    case "integer":
      return Number.isInteger(Number(raw))
        ? { ok: true }
        : { ok: false, message: "Must be a whole number." };
    case "enum": {
      const allowed = entry.values || [];
      return allowed.includes(raw)
        ? { ok: true }
        : { ok: false, message: `Must be one of: ${allowed.join(", ")}.` };
    }
    case "engines": {
      const unknown = raw
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .filter((token) => !engineIds.has(token));
      return unknown.length
        ? { ok: false, message: `Unknown engine${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` }
        : { ok: true };
    }
    default:
      return { ok: true };
  }
}

export function normalizeDraftValue(entry, value) {
  if (entry.type === "boolean") {
    const raw = String(value).trim().toLowerCase();
    if (raw === "1" || raw === "true") return "true";
    if (raw === "0" || raw === "false") return "false";
    return String(value);
  }
  if (entry.type === "json") {
    if (Array.isArray(value)) return JSON.stringify(value, null, 2);
    if (typeof value === "object" && value !== null) return JSON.stringify(value, null, 2);
    return String(value ?? "");
  }
  return Array.isArray(value) ? value.join(",") : String(value ?? "");
}

export function compareDraftValue(entry, a, b) {
  if (entry.type === "engines") {
    const tokens = (value) =>
      (value || "")
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .sort()
        .join(",");
    return tokens(a) === tokens(b);
  }
  return a === b;
}
