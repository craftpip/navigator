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
    pathname === CONSOLE_LOGIN_LOGO_PATH ||
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

export const CONSOLE_LOGIN_LOGO_PATH = "/console/login/logo.png";

// Same tokens, font and header treatment as the React console
// (src/web-console/src/style.css + components/Layout.jsx), inlined because the
// console bundle itself is behind the login.
export function renderLoginPage({ next = "/console", error = "" } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Navigator Console — Sign in</title>
<link rel="icon" type="image/png" href="${CONSOLE_LOGIN_LOGO_PATH}">
<script>
  try {
    var t = localStorage.getItem("navigator-theme") ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = t;
  } catch (e) {}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f3f4f6; --panel: #fff; --panel2: #f8f9fa; --line: #d6d9de; --line2: #e7e9ec;
    --text: #202124; --muted: #68707c; --blue: #2563eb; --blue-bg: #dbeafe;
    --red: #b91c1c; --red-bg: #fee2e2;
    --sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  }
  html[data-theme="dark"] {
    --bg: #101217; --panel: #191c24; --panel2: #1f232c; --line: #303541; --line2: #262b35;
    --text: #e6e9ef; --muted: #9aa3b2; --blue: #7aa2ff; --blue-bg: #22304a;
    --red: #f07178; --red-bg: #3a1c20;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); }
  button, input { font: inherit; }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
  .login { width: 100%; max-width: 360px; }
  .logo { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 18px;
    color: var(--text); font: 700 14px var(--sans); letter-spacing: 0.6px; white-space: nowrap; }
  .logo img { width: 64px; height: 64px; display: block; }
  .logo span { color: var(--muted); }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 18px; }
  h2 { margin: 0 0 4px; font: 700 12px var(--sans); letter-spacing: 0.4px; text-transform: uppercase; color: var(--text); }
  .sub { margin: 0 0 16px; font: 400 12px/1.5 var(--sans); color: var(--muted); }
  label { display: block; margin-bottom: 6px; font: 500 10px var(--sans); letter-spacing: 0.5px; text-transform: uppercase; color: var(--muted); }
  input[type="password"] { width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: 6px;
    background: var(--panel); color: var(--text); font-size: 13px; }
  input[type="password"]:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px var(--blue-bg); }
  .button { display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 34px; margin-top: 14px;
    padding: 0 10px; border: 1px solid #2563eb; border-radius: 6px; background: #2563eb; color: #fff;
    font: 700 12px var(--sans); letter-spacing: 0.2px; cursor: pointer; }
  .button:hover { background: #1d4ed8; border-color: #1d4ed8; }
  .button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--blue-bg); }
  .error { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; padding: 8px 10px; border-radius: 6px;
    background: var(--red-bg); color: var(--red); font: 600 12px var(--sans); }
  .foot { margin: 12px 0 0; text-align: center; font: 400 11px var(--sans); color: var(--muted); }
</style>
</head>
<body>
<main class="login">
  <div class="logo">
    <img src="${CONSOLE_LOGIN_LOGO_PATH}" alt="Navigator alligator logo" width="64" height="64">
    NAVIGATOR <span>CONSOLE</span>
  </div>
  <form class="panel" method="post" action="/console/login">
    <h2>Sign in</h2>
    <p class="sub">Enter the console password to continue.</p>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <button class="button" type="submit">Sign in</button>
  </form>
  <p class="foot">Set with CONSOLE_PASSWORD in the server's .env</p>
</main>
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
