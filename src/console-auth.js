/**
 * Web console login (CONSOLE_PASSWORD).
 *
 * When CONSOLE_PASSWORD is set, every HTTP surface that only the web console
 * uses (/, /console*, /ui, /dashboard, /stats*, /search, /extract, /screenshot,
 * /engines/reset*, /debug/*) requires a signed session cookie obtained from
 * /console/login. MCP (/mcp, its own API keys), the CDP/relay sockets, /cdp
 * discovery (its own key), /health (extension probe; keys redacted for
 * anonymous callers), /docs and /download/* stay exactly as they were.
 *
 * When CONSOLE_PASSWORD is unset, nothing is gated (legacy behavior).
 *
 * The cookie is stateless — `<expiry>.<HMAC(password, expiry)>` — so it
 * survives restarts and is invalidated by changing the password. It slides:
 * any authenticated request in the second half of its lifetime gets a fresh one.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const CONSOLE_COOKIE_NAME = "nav_console";
export const CONSOLE_SESSION_MAX_AGE_S = 30 * 24 * 3600;
export const CONSOLE_PASSWORD_HEADER = "x-console-password";

const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // ip -> { count, firstAt }

export function getConsolePassword(env = process.env) {
  return String(env.CONSOLE_PASSWORD || "");
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

// Constant-time compare that does not leak length (both sides hashed first).
export function safeEqual(a, b) {
  return timingSafeEqual(digest(a), digest(b));
}

function sign(password, exp) {
  return createHmac("sha256", `navigator-console:${password}`).update(String(exp)).digest("base64url");
}

export function issueConsoleToken(password, now = Date.now()) {
  const exp = Math.floor(now / 1000) + CONSOLE_SESSION_MAX_AGE_S;
  return `${exp}.${sign(password, exp)}`;
}

/** Returns the token's expiry (epoch seconds) when valid, else 0. */
export function verifyConsoleToken(token, password, now = Date.now()) {
  if (!password || !token) return 0;
  const [expRaw, sig] = String(token).split(".");
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || !sig || exp * 1000 <= now) return 0;
  return safeEqual(sig, sign(password, exp)) ? exp : 0;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key || Object.hasOwn(out, key)) continue;
    try { out[key] = decodeURIComponent(part.slice(idx + 1).trim()); } catch { out[key] = part.slice(idx + 1).trim(); }
  }
  return out;
}

export function consoleCookieHeader(token) {
  return `${CONSOLE_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${CONSOLE_SESSION_MAX_AGE_S}`;
}

export function clearConsoleCookieHeader() {
  return `${CONSOLE_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * Is this request logged in to the console? Accepts the session cookie, or the
 * password itself in the X-Console-Password header (used by ./navigator.js).
 * Returns { ok, exp } — exp is the cookie expiry (0 for header auth).
 */
export function checkConsoleAuth(req, password, now = Date.now()) {
  if (!password) return { ok: true, exp: 0 };
  const headerPassword = req.headers?.[CONSOLE_PASSWORD_HEADER];
  if (typeof headerPassword === "string" && headerPassword && safeEqual(headerPassword, password)) {
    return { ok: true, exp: 0 };
  }
  const exp = verifyConsoleToken(parseCookies(req.headers?.cookie)[CONSOLE_COOKIE_NAME], password, now);
  return { ok: exp > 0, exp };
}

/** Sliding renewal: reissue when less than half the lifetime remains. */
export function shouldRenewConsoleToken(exp, now = Date.now()) {
  return exp > 0 && exp * 1000 - now < (CONSOLE_SESSION_MAX_AGE_S * 1000) / 2;
}

// Paths that never require the console login. Everything else does.
export function isConsolePublicPath(pathname) {
  return (
    pathname === "/mcp" ||
    pathname === "/health" ||
    pathname === "/cdp" ||
    pathname === "/console/login" ||
    pathname === "/console/logout" ||
    pathname === "/docs" ||
    pathname.startsWith("/docs/") ||
    pathname.startsWith("/download/") ||
    // WebSocket upgrade paths are handled by the relay / cdp-share upgrade
    // handlers with their own key checks; plain HTTP hits on them 404 anyway.
    pathname === "/relay" ||
    pathname.startsWith("/browser/") ||
    pathname.startsWith("/cdp/")
  );
}

export function loginRateLimited(ip, now = Date.now()) {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

export function recordLoginFailure(ip, now = Date.now()) {
  const entry = loginFailures.get(ip);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) loginFailures.set(ip, { count: 1, firstAt: now });
  else entry.count += 1;
}

export function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

export function resetLoginRateLimits() {
  loginFailures.clear();
}

/** Only same-origin absolute paths are allowed as post-login redirects. */
export function safeNextPath(value) {
  const next = String(value || "");
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/console";
  if (next.startsWith("/console/login") || next.startsWith("/console/logout")) return "/console";
  return next;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function renderLoginPage({ next = "/console", error = "" } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Navigator Login</title>
<style>
  :root { --bg:#f6f7f9; --card:#ffffff; --fg:#1c1f24; --muted:#5d6470; --border:#d9dde3; --accent:#2f6f4f; --err:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121417; --card:#1b1e23; --fg:#e8eaed; --muted:#9aa1ab; --border:#2c3138; --accent:#5fb98a; --err:#f97066; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; padding:16px; }
  form { width:100%; max-width:340px; background:var(--card); border:1px solid var(--border); border-radius:10px; padding:28px 24px; }
  h1 { margin:0 0 4px; font-size:20px; }
  p { margin:0 0 20px; color:var(--muted); font-size:14px; }
  label { display:block; font-size:13px; margin-bottom:6px; color:var(--muted); }
  input { width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--fg); font-size:15px; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { margin-top:16px; width:100%; padding:10px; border:0; border-radius:6px; background:var(--accent); color:#fff; font-size:15px; font-weight:600; cursor:pointer; }
  .err { color:var(--err); font-size:13px; margin:12px 0 0; }
</style>
</head>
<body>
<form method="post" action="/console/login">
  <h1>Navigator</h1>
  <p>Sign in to the web console.</p>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <button type="submit">Sign in</button>
  ${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ""}
</form>
</body>
</html>`;
}

/** Replace `key=<secret>` query values in any string inside a JSON-able value. */
export function redactUrlKeys(value) {
  if (typeof value === "string") return value.replace(/([?&]key=)[^&#\s"]+/g, "$1<redacted>");
  if (Array.isArray(value)) return value.map(redactUrlKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactUrlKeys(v);
    return out;
  }
  return value;
}
