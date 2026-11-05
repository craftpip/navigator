/**
 * URL policy for every URL a client can make a browser open.
 *
 * file:// URLs are blocked: browser-initiated navigation (page.goto,
 * Page.navigate, Target.createTarget) can open them, and they read files on
 * the machine running the browser — for the built-in Chromium that is the
 * navigator container itself (/app/.env, the API key database, ...).
 * Pages cannot navigate themselves to file: (Chromium blocks that), so
 * checking the URLs clients pass in is sufficient.
 *
 * Normalization mirrors how Chromium parses a URL string: leading C0
 * controls/spaces are stripped, tab/CR/LF are removed anywhere, the scheme is
 * case-insensitive, and view-source: wraps another URL.
 *
 * Set ALLOW_FILE_URLS=1 to permit them (e.g. local testing).
 */

export function isFileUrl(url) {
  let s = String(url ?? "")
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000- ]+/, "")
    .toLowerCase();
  while (s.startsWith("view-source:")) s = s.slice("view-source:".length).replace(/^[\u0000- ]+/, "");
  return s.startsWith("file:") || s.startsWith("filesystem:file:");
}

export function fileUrlsAllowed(env = process.env) {
  return String(env.ALLOW_FILE_URLS || "").trim() === "1";
}

export function assertAllowedUrl(url, field = "url", env = process.env) {
  if (fileUrlsAllowed(env)) return url;
  if (isFileUrl(url)) {
    throw new Error(`Invalid input: ${field} — file:// URLs are blocked (they would read files on the navigator server). Use an http(s) URL.`);
  }
  return url;
}

export function assertAllowedUrls(urls, field = "urls[]", env = process.env) {
  for (const url of urls || []) assertAllowedUrl(url, field, env);
  return urls;
}

/** Raw CDP params (Target.sendCommand): check any top-level url-ish string. */
export function assertAllowedCdpParams(params, env = process.env) {
  if (!params || typeof params !== "object") return params;
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && /url$/i.test(key)) assertAllowedUrl(value, `params.${key}`, env);
  }
  return params;
}
