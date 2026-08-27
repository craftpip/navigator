export const WEB_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "web_page_screenshot",
  "http:/search",
  "http:/extract",
  "http:/screenshot",
]);

export const EXPECTED_INPUT_ERROR =
  /No link found in memory|Invalid input:|Provide one of:|Missing q|Unknown targetId|No target found|selector matched nothing|requires a targetId|ref_id/i;

export function list(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function classifyError(entry) {
  const tool = String(entry?.tool || "");
  const expected = EXPECTED_INPUT_ERROR.test(
    String(entry?.error || entry?.message || ""),
  );
  const family = WEB_TOOLS.has(tool)
    ? "Web Browsing"
    : ["Target.", "Page.", "Runtime.", "DOM.", "Input."].some((prefix) =>
          tool.startsWith(prefix),
        )
      ? "DevTools"
      : "System";
  return { family, expected, critical: !expected && family === "System" };
}

export function errorLogKey(entry) {
  const firstLine = String(entry?.error || entry?.message || "")
    .split("\n")[0]
    .slice(0, 120);
  return `${entry?.tool || ""}\u0000${firstLine}`;
}

export function mergeErrorLogs(fileLogs, recentErrors) {
  const seen = new Set(fileLogs.map(errorLogKey));
  const requestErrors = (recentErrors || []).map((entry) => ({
    ts: new Date(Date.now() - (entry.minutesAgo || 0) * 60000).toISOString(),
    level: "request_error",
    transport: "requestLog",
    tool: entry.tool,
    error: entry.error,
  }));
  return [...fileLogs, ...requestErrors.filter((entry) => !seen.has(errorLogKey(entry)))].sort(
    (a, b) => String(b.ts).localeCompare(String(a.ts)),
  );
}

export async function request(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || "Request failed");
    if (data.validation) error.validation = data.validation;
    throw error;
  }
  return data;
}
