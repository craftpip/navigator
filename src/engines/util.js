export function cleanWhitespace(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

// Convert an error into a human-readable message. AggregateError instances
// (e.g. from Promise.any when every selector wait times out) only expose the
// generic "All promises were rejected" as their message; the real reasons live
// in error.errors. Unwrap those so circuit breakers, attempt logs, and the
// console show what actually failed instead of the cryptic AggregateError text.
export function readableErrorMessage(error, maxLen = 300) {
  if (error && typeof error === "object" && Array.isArray(error.errors)) {
    const reasons = error.errors
      .map((reason) => readableErrorMessage(reason, maxLen))
      .map((message) => String(message).trim())
      .filter((message) => message && message !== "All promises were rejected");
    const unique = [...new Set(reasons)];
    if (unique.length) {
      return unique.join("; ").slice(0, maxLen);
    }
  }
  return String(error?.message || error || "").slice(0, maxLen);
}

const WRAPPING_QUOTE_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"]
];

/**
 * Canonical form of a search query: trimmed, whitespace collapsed, and quotes
 * that wrap the WHOLE query removed (an LLM quoting its own query string).
 * Everything else is the user's search syntax and is passed through as-is:
 * case, operators (site:, filetype:, -term, OR), inner "phrase" quotes,
 * apostrophes, URLs, paths, `::` and punctuation.
 */
export function normalizeQueryText(input) {
  let text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  let changed = true;
  while (changed && text.length > 1) {
    changed = false;
    for (const [open, close] of WRAPPING_QUOTE_PAIRS) {
      if (text.length <= open.length + close.length || !text.startsWith(open) || !text.endsWith(close)) continue;
      const inner = text.slice(open.length, text.length - close.length);
      // `"a" OR "b"` starts and ends with a quote but is two phrases, not one
      // wrapped query: only unwrap when the inner text has no further quote of
      // the same kind.
      if (inner.includes(open) || inner.includes(close)) continue;
      text = inner.trim();
      changed = true;
    }
  }

  return text;
}

function decodeBingRedirectUrl(u) {
  for (const candidate of [u, u.replace(/^a\d+/, "")]) {
    for (let depth = 1; depth <= 2; depth += 1) {
      try {
        let decoded = candidate;
        for (let i = 0; i < depth; i += 1) {
          decoded = Buffer.from(decoded, "base64").toString("utf8");
        }
        if (/^https?:\/\//.test(decoded)) return decoded;
      } catch {
        // try the next candidate/depth
      }
    }
  }
  return null;
}

export function normalizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (isGoogleHostname(parsed.hostname) && (parsed.pathname === "/url" || parsed.pathname === "/goto")) {
      // `/url?q=<target>` (and `/url?url=<target>`) carry the target in
      // clear; `/goto?url=<token>` carries an opaque token the Google driver
      // resolves over HTTP — only unwrap when the parameter is a real URL.
      for (const param of ["q", "url"]) {
        const redirect = parsed.searchParams.get(param);
        if (redirect && /^https?:\/\//i.test(redirect)) return redirect;
      }
    }
    if (parsed.hostname.includes("duckduckgo.") && parsed.pathname === "/l/") {
      const redirect = parsed.searchParams.get("uddg");
      if (redirect) return redirect;
    }
    if (parsed.hostname.includes("bing.") && parsed.pathname === "/ck/a") {
      const u = parsed.searchParams.get("u");
      if (u) {
        const redirect = decodeBingRedirectUrl(u);
        if (redirect) return redirect;
      }
    }
    if (parsed.hostname === "r.search.yahoo.com") {
      const ru = parsed.pathname.split("/").find((seg) => seg.startsWith("RU="));
      if (ru) {
        const decoded = Buffer.from(ru.slice(3), "base64url").toString("utf8");
        if (/^https?:\/\//.test(decoded)) return decoded;
      }
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function isGoogleHostname(hostname) {
  return /(^|\.)google\.[a-z.]+$/i.test(String(hostname || ""));
}

/** True for any google.* host (www.google.com, google.co.uk, …). */
export function isGoogleHost(rawUrl) {
  try {
    return isGoogleHostname(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

export function buildLlmText(result) {
  return cleanWhitespace(`${result.title}\n${result.snippet}`);
}

export function dedupeDirectAnswers(answers, maxItems = 10) {
  const byKey = new Map();

  for (const item of answers) {
    const text = cleanWhitespace(item?.text);
    if (!text) continue;

    const source = cleanWhitespace(item?.source || "answer").toLowerCase();
    const key = `${source}|${text.toLowerCase()}`;
    const queryVariants = Array.isArray(item?.queryVariants)
      ? item.queryVariants.map((q) => cleanWhitespace(q)).filter(Boolean)
      : [cleanWhitespace(item?.queryVariant)].filter(Boolean);

    if (!byKey.has(key)) {
      byKey.set(key, {
        source,
        text,
        url: cleanWhitespace(item?.url || ""),
        ...(queryVariants.length ? { queryVariants } : {})
      });
      continue;
    }

    if (queryVariants.length) {
      const existing = byKey.get(key);
      const merged = [...new Set([...(existing.queryVariants || []), ...queryVariants])];
      if (merged.length) {
        existing.queryVariants = merged;
      }
    }
  }

  return [...byKey.values()].slice(0, maxItems);
}

export function cleanAndTruncateText(text, maxChars) {
  return String(text || "").replace(/[^\S\n]+/g, " ").trim().slice(0, maxChars);
}

export async function fetchTextWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 160)}`);
    }
    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}
