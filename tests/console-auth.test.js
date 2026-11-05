import { describe, it, expect, beforeEach } from "vitest";
import {
  CONSOLE_COOKIE_NAME,
  CONSOLE_SESSION_MAX_AGE_S,
  checkConsoleAuth,
  issueConsoleToken,
  verifyConsoleToken,
  shouldRenewConsoleToken,
  isConsolePublicPath,
  loginRateLimited,
  recordLoginFailure,
  clearLoginFailures,
  resetLoginRateLimits,
  safeNextPath,
  parseCookies,
  renderLoginPage,
  redactUrlKeys,
  getConsolePassword,
} from "../src/console-auth.js";

const PW = "correct horse battery staple";
const req = (headers = {}) => ({ headers });

describe("console-auth tokens", () => {
  it("issues a token that verifies only with the same password", () => {
    const token = issueConsoleToken(PW);
    expect(verifyConsoleToken(token, PW)).toBeGreaterThan(0);
    expect(verifyConsoleToken(token, "other")).toBe(0);
  });

  it("rejects expired, tampered and malformed tokens", () => {
    const now = Date.now();
    const token = issueConsoleToken(PW, now);
    expect(verifyConsoleToken(token, PW, now + (CONSOLE_SESSION_MAX_AGE_S + 1) * 1000)).toBe(0);
    const [exp, sig] = token.split(".");
    expect(verifyConsoleToken(`${Number(exp) + 99999}.${sig}`, PW, now)).toBe(0);
    expect(verifyConsoleToken(`${exp}.${sig}x`, PW, now)).toBe(0);
    for (const bad of ["", "abc", "1.", ".sig", "1.2.3", null, undefined]) expect(verifyConsoleToken(bad, PW, now)).toBe(0);
  });

  it("renews only in the second half of the lifetime", () => {
    const now = Date.now();
    const exp = verifyConsoleToken(issueConsoleToken(PW, now), PW, now);
    expect(shouldRenewConsoleToken(exp, now)).toBe(false);
    expect(shouldRenewConsoleToken(exp, now + (CONSOLE_SESSION_MAX_AGE_S * 1000 * 0.6))).toBe(true);
    expect(shouldRenewConsoleToken(0, now)).toBe(false);
  });
});

describe("checkConsoleAuth", () => {
  it("is open when no password is configured (legacy behavior)", () => {
    expect(checkConsoleAuth(req(), "").ok).toBe(true);
  });

  it("accepts a valid session cookie among other cookies", () => {
    const cookie = `a=1; ${CONSOLE_COOKIE_NAME}=${issueConsoleToken(PW)}; b=2`;
    expect(checkConsoleAuth(req({ cookie }), PW).ok).toBe(true);
  });

  it("accepts the X-Console-Password header (navigator.js CLI)", () => {
    expect(checkConsoleAuth(req({ "x-console-password": PW }), PW).ok).toBe(true);
    expect(checkConsoleAuth(req({ "x-console-password": "nope" }), PW).ok).toBe(false);
  });

  it("rejects missing, wrong-password and API-key-only requests", () => {
    expect(checkConsoleAuth(req(), PW).ok).toBe(false);
    expect(checkConsoleAuth(req({ cookie: `${CONSOLE_COOKIE_NAME}=${issueConsoleToken("other")}` }), PW).ok).toBe(false);
    expect(checkConsoleAuth(req({ authorization: "Bearer nvg_something" }), PW).ok).toBe(false);
  });
});

describe("isConsolePublicPath", () => {
  it("keeps MCP, health, docs, downloads, login and CDP/relay paths public", () => {
    for (const p of ["/mcp", "/health", "/cdp", "/cdp/Chrome", "/relay", "/browser/Chrome131", "/docs", "/docs/guide/", "/download/abc.jpg", "/console/login", "/console/login/logo.png", "/console/logout"]) {
      expect(isConsolePublicPath(p), p).toBe(true);
    }
  });

  it("gates the console, its API and the console-only HTTP endpoints", () => {
    for (const p of ["/", "/console", "/console/", "/console/mcp-client-key", "/console/api-keys", "/console/config", "/console/api/tabs", "/console/assets/index.js", "/ui", "/dashboard", "/stats", "/stats/activity", "/search", "/extract", "/screenshot", "/engines/reset", "/debug/detach_all", "/mcpx", "/healthz", "/docsx"]) {
      expect(isConsolePublicPath(p), p).toBe(false);
    }
  });
});

describe("login rate limiting", () => {
  beforeEach(() => resetLoginRateLimits());

  it("blocks an IP after 10 failures within the window and recovers after it", () => {
    const now = Date.now();
    for (let i = 0; i < 9; i++) recordLoginFailure("1.2.3.4", now);
    expect(loginRateLimited("1.2.3.4", now)).toBe(false);
    recordLoginFailure("1.2.3.4", now);
    expect(loginRateLimited("1.2.3.4", now)).toBe(true);
    expect(loginRateLimited("5.6.7.8", now)).toBe(false);
    expect(loginRateLimited("1.2.3.4", now + 16 * 60 * 1000)).toBe(false);
  });

  it("clears on successful login", () => {
    for (let i = 0; i < 10; i++) recordLoginFailure("9.9.9.9");
    clearLoginFailures("9.9.9.9");
    expect(loginRateLimited("9.9.9.9")).toBe(false);
  });
});

describe("helpers", () => {
  it("safeNextPath only allows same-origin paths", () => {
    expect(safeNextPath("/console/keys?x=1")).toBe("/console/keys?x=1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "javascript:alert(1)", "", null, "/console/login?next=/x", "/console/logout"]) {
      expect(safeNextPath(bad), String(bad)).toBe("/console");
    }
  });

  it("parseCookies handles spacing, encoding and duplicates (first wins)", () => {
    expect(parseCookies("a=1; b=x%20y;c=3; a=9")).toEqual({ a: "1", b: "x y", c: "3" });
    expect(parseCookies(undefined)).toEqual({});
  });

  it("renderLoginPage escapes next and error", () => {
    const html = renderLoginPage({ next: '/x"><script>', error: "<b>bad</b>" });
    expect(html).not.toContain('/x"><script>');
    expect(html).toContain('value="/x&quot;&gt;&lt;script&gt;"');
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
    expect(html).toContain('action="/console/login"');
    expect(html).toContain('src="/console/login/logo.png"');
    expect(html).toContain("navigator-theme");
  });

  it("redactUrlKeys strips key= values anywhere in a nested payload", () => {
    const health = {
      ok: true,
      browsers: [
        { name: "Chrome131", cdpUrl: "ws://10.0.0.1:1994/browser/Chrome131?key=nvg_console_SECRET", relayWsUrl: "ws://h/relay?x=1&key=abc#frag" },
        { name: "cloakbrowser", cdpUrl: "http://cloak-browser:9222" },
      ],
      n: 5,
      nothing: null,
    };
    const out = redactUrlKeys(health);
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(out.browsers[0].cdpUrl).toBe("ws://10.0.0.1:1994/browser/Chrome131?key=<redacted>");
    expect(out.browsers[0].relayWsUrl).toBe("ws://h/relay?x=1&key=<redacted>#frag");
    expect(out.browsers[1].cdpUrl).toBe("http://cloak-browser:9222");
    expect(out.n).toBe(5);
    expect(out.nothing).toBe(null);
    expect(health.browsers[0].cdpUrl).toContain("SECRET"); // input untouched
  });

  it("getConsolePassword reads CONSOLE_PASSWORD", () => {
    expect(getConsolePassword({ CONSOLE_PASSWORD: "x" })).toBe("x");
    expect(getConsolePassword({})).toBe("");
  });
});
