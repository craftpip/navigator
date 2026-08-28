import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/browser.js", () => ({ getBrowserManager: vi.fn() }));
vi.mock("../src/vnc-manager.js", () => {
  const fakeVnc = {
    display: ":99",
    status: "stopped",
    steps: [],
    lastError: null,
    ownedPids: new Map(),
    start: vi.fn().mockResolvedValue({ ok: true }),
    stop: vi.fn().mockResolvedValue({ ok: true }),
    getStatus: vi.fn().mockResolvedValue({ running: false }),
  };
  return { VncManager: vi.fn(), vncManager: fakeVnc };
});
vi.mock("../src/search.js", () => ({
  browserSearch: vi.fn(),
  browserOpenAndExtract: vi.fn(),
  browserCaptureScreenshot: vi.fn(),
  getSearchBackendHealth: vi.fn().mockReturnValue([]),
  getActivityCounters: vi.fn().mockReturnValue({ searches: 0, searchResults: 0, fetches: 0, screenshots: 0, botBlocks: 0 }),
  getEngineAttemptStats: vi.fn().mockReturnValue({ total: 0, ok: 0, fail: 0, skip: 0, byEngine: {}, recentFailures: [] }),
  getEngineProfiles: vi.fn().mockReturnValue([]),
}));
vi.mock("../src/devtools.js", () => ({
  devtoolsToolDefinitions: [],
  formatDevtoolsToolResponse: vi.fn(),
  handleDevtoolsToolCall: vi.fn(),
  captureTargetScreenshot: vi.fn(),
  getDevtoolsCounters: vi.fn().mockReturnValue({ targetsCreated: 0, targetsClosed: 0, targetsInactivityClosed: 0 }),
}));
vi.mock("cloakbrowser", () => ({}));
vi.mock("cloakbrowser/puppeteer", () => ({ launch: vi.fn() }));

const MCP_PORT = 18992;
const MCP_BASE = `http://localhost:${MCP_PORT}`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hints-api-"));
const hintsPath = path.join(tmpDir, "domain-hints.json");

function makeMockManager(overrides = {}) {
  return {
    config: {
      chromePath: "/usr/bin/chrome",
      chromeUserDataDir: "/tmp/chrome-test",
      chromeProfileDir: "Default",
      defaultBackend: "cloakbrowser",
      devtoolsBackend: "cloakbrowser",
      browserOpTimeoutMs: 60000,
      headless: true,
      userAgent: "test-agent",
      navWaitUntil: "domcontentloaded",
      mcpApiPort: MCP_PORT,
      mcpApiHost: "http://localhost",
      enableHttpHealth: true,
      enableHttpMcp: true,
      enableStdioMcp: false,
      enableDevtoolsMcp: false,
      searchKeepMinWorkingWindows: 2,
      searchMaxWorkingWindows: 10,
      searchRouteCircuitOpenMs: 300000,
      openPageMaxParallel: 6,
      maxConcurrentPageOps: 30,
      prelaunchBrowser: false,
      enableHangRestart: false,
      searchRouteWarmupEngines: [],
      searchEnabledEngines: null,
      screenshotPathPrefix: null,
      enableScreenshotDownloadLink: false,
      enableWebConsole: true,
      domainHintsPath: hintsPath,
      vncEnabled: false,
      vncPort: 1995,
      novncPort: 1996,
      debug: false,
      logToolErrors: true,
      ...overrides,
    },
    getHealth: vi.fn().mockResolvedValue({ ok: true, browserConnected: true, openPageSlots: { used: 0, max: 10 }, pageLimiter: { inUse: 0 } }),
    getInstanceStats: vi.fn().mockResolvedValue([]),
    _effectiveAddOns: vi.fn().mockReturnValue([]),
    shutdown: vi.fn().mockResolvedValue(undefined),
    prelaunchIfConfigured: vi.fn().mockResolvedValue(undefined),
    relaunchDefaultBackend: vi.fn().mockResolvedValue({ ok: true }),
  };
}

async function waitForServer(url, maxRetries = 20) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

async function jsonRequest(pathname, options = {}) {
  const res = await fetch(`${MCP_BASE}${pathname}`, {
    cache: "no-store",
    headers: { "content-type": "application/json" },
    ...options,
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

describe("domain hints API", () => {
  let browserMod;
  let searchMod;
  let manager;

  beforeAll(async () => {
    fs.writeFileSync(hintsPath, JSON.stringify([
      { domain: "github.com", pathPattern: "/*", pageType: "profile", comment: "user profile", testUrls: ["https://github.com/craftpip"] },
      { domain: "github.com", pathPattern: "/*/*", pageType: "repo", comment: "repo landing", testUrls: ["https://github.com/craftpip/navigator"] },
    ], null, 2) + "\n");

    browserMod = await import("../src/browser.js");
    searchMod = await import("../src/search.js");
    manager = makeMockManager();
    browserMod.getBrowserManager.mockResolvedValue(manager);

    await import("../src/mcp-server.js");
    await waitForServer(`${MCP_BASE}/health`);
  }, 15000);

  afterAll(() => {
    process.emit("SIGTERM");
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("GET /console/api/hints", () => {
    it("returns the ordered hint list from the configured file", async () => {
      const { status, body } = await jsonRequest("/console/api/hints");
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.hintsPath).toBe(hintsPath);
      expect(body.count).toBe(3);
      expect(body.hints[0].domain).toBe("*");
      expect(body.hints.map((h) => h.pageType)).toEqual(["default", "profile", "repo"]);
    });
  });

  describe("POST /console/api/hints/validate", () => {
    it("validates a correct hint", async () => {
      const { status, body } = await jsonRequest("/console/api/hints/validate", {
        method: "POST",
        body: JSON.stringify({ hint: { domain: "example.com", pathPattern: "/**", pageType: "page", comment: "test" } }),
      });
      expect(status).toBe(200);
      expect(body.valid).toBe(true);
      expect(body.errors).toEqual([]);
    });

    it("reports field errors for an invalid hint", async () => {
      const { status, body } = await jsonRequest("/console/api/hints/validate", {
        method: "POST",
        body: JSON.stringify({ hint: { domain: "X", pathPattern: "no-slash", waitForSelector: "a[" } }),
      });
      expect(status).toBe(200);
      expect(body.valid).toBe(false);
      const fields = body.errors.map((e) => e.field);
      expect(fields).toContain("domain");
      expect(fields).toContain("pathPattern");
      expect(fields).toContain("waitForSelector");
    });

    it("test scope allows omitting domain and pathPattern", async () => {
      const { status, body } = await jsonRequest("/console/api/hints/validate", {
        method: "POST",
        body: JSON.stringify({ scope: "test", hint: { default: { waitForSelector: "main p" } } }),
      });
      expect(status).toBe(200);
      expect(body.valid).toBe(true);
    });
  });

  describe("POST /console/api/hints (create)", () => {
    it("appends a valid hint to the file", async () => {
      const { status, body } = await jsonRequest("/console/api/hints", {
        method: "POST",
        body: JSON.stringify({ hint: { domain: "example.com", pathPattern: "/**", pageType: "page", comment: "test hint", testUrls: ["https://example.com"] } }),
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.index).toBe(2);
      expect(body.hint.domain).toBe("example.com");

      const fileHints = JSON.parse(fs.readFileSync(hintsPath, "utf8"));
      expect(fileHints).toHaveLength(3);
      expect(fileHints[2].domain).toBe("example.com");
    });

    it("rejects a duplicate domain+pathPattern with a 400 naming the collision", async () => {
      const { status, body } = await jsonRequest("/console/api/hints", {
        method: "POST",
        body: JSON.stringify({ hint: { domain: "github.com", pathPattern: "/*", pageType: "profile", comment: "dup" } }),
      });
      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/collides with #0/);
      expect(body.validation.errors[0].field).toBe("pathPattern");
    });

    it("rejects an invalid selector with validation errors", async () => {
      const { status, body } = await jsonRequest("/console/api/hints", {
        method: "POST",
        body: JSON.stringify({ hint: { domain: "example.com", pathPattern: "/**", pageType: "page", comment: "x", waitForSelector: "div[" } }),
      });
      expect(status).toBe(400);
      expect(body.validation.errors.map((e) => e.field)).toContain("waitForSelector");
    });

    it("defaults a missing pathPattern to /**", async () => {
      const { status, body } = await jsonRequest("/console/api/hints", {
        method: "POST",
        body: JSON.stringify({ hint: { domain: "example.org", pageType: "page", comment: "no pattern" } }),
      });
      expect(status).toBe(200);
      expect(body.hint.pathPattern).toBe("/**");
    });
  });

  describe("PUT /console/api/hints/:index (update)", () => {
    it("replaces the hint in place", async () => {
      const { status, body } = await jsonRequest("/console/api/hints/0", {
        method: "PUT",
        body: JSON.stringify({ hint: { domain: "github.com", pathPattern: "/*", pageType: "profile", comment: "updated comment" } }),
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.index).toBe(0);
      expect(body.hint.comment).toBe("updated comment");

      const fileHints = JSON.parse(fs.readFileSync(hintsPath, "utf8"));
      expect(fileHints[0].comment).toBe("updated comment");
      expect(fileHints).toHaveLength(4);
    });

    it("rejects an out-of-range index", async () => {
      const { status, body } = await jsonRequest("/console/api/hints/99", {
        method: "PUT",
        body: JSON.stringify({ hint: { domain: "github.com", pathPattern: "/*", pageType: "profile", comment: "x" } }),
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/out of range/);
    });
  });

  describe("GET /extract hint override", () => {
    it("rejects an invalid candidate with 400 before navigating", async () => {
      searchMod.browserOpenAndExtract.mockClear();
      const badHint = { waitForSelector: "a[" };
      const { status, body } = await jsonRequest(`/extract?url=https://example.com&hint=${encodeURIComponent(JSON.stringify(badHint))}`);
      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error).toBe("invalid hint");
      expect(searchMod.browserOpenAndExtract).not.toHaveBeenCalled();
    });

    it("passes a valid candidate through as hintOverride", async () => {
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValue({
        title: "Example",
        url: "https://example.com",
        text: "Hello world",
        links: [],
        tables: [],
      });
      const candidate = {
        flow: [{ action: "extract", label: "Stage", content: { blocks: [{ selector: "main p", label: "Main", priority: "high", format: "text" }] } }]
      };
      const { status } = await jsonRequest(`/extract?url=https://example.com&hint=${encodeURIComponent(JSON.stringify(candidate))}`);
      expect(status).toBe(200);
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(1);
      expect(searchMod.browserOpenAndExtract.mock.calls[0][0].hintOverride).toEqual(candidate);
    });

    it("calls without hintOverride when no hint param is given", async () => {
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValue({
        title: "Example",
        url: "https://example.com",
        text: "Hello world",
        links: [],
        tables: [],
      });
      const { status } = await jsonRequest("/extract?url=https://example.com");
      expect(status).toBe(200);
      expect(searchMod.browserOpenAndExtract.mock.calls[0][0].hintOverride).toBeNull();
    });
  });

  describe("GET /extract cacheHtml", () => {
    const PAGE = { title: "Example", url: "https://example.com", text: "Hello world", html: "<html><body>Hello world</body></html>", links: [], tables: [] };

    it("first cacheHtml=1 call captures html into the cache", async () => {
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValue({ ...PAGE });
      const { status } = await jsonRequest("/extract?url=https://example.com&cacheHtml=1");
      expect(status).toBe(200);
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(1);
      expect(searchMod.browserOpenAndExtract.mock.calls[0][0].captureHtml).toBe(true);
      expect(searchMod.browserOpenAndExtract.mock.calls[0][0].cachedHtml).toBeNull();
    });

    it("second cacheHtml=1 call reuses the cached html (no browser fetch)", async () => {
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValue({ ...PAGE });
      const { status } = await jsonRequest("/extract?url=https://example.com&cacheHtml=1");
      expect(status).toBe(200);
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(1);
      expect(searchMod.browserOpenAndExtract.mock.calls[0][0].cachedHtml).toContain("Hello world");
      expect(searchMod.browserOpenAndExtract.mock.calls[0][0].captureHtml).toBe(true);
    });

    it("cacheHtml=0 clears the cached entry and fetches live", async () => {
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValue({ ...PAGE });
      const { status } = await jsonRequest("/extract?url=https://example.com&cacheHtml=0");
      expect(status).toBe(200);
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(1);
      expect(searchMod.browserOpenAndExtract.mock.calls[0][0].cachedHtml).toBeNull();
      expect(searchMod.browserOpenAndExtract.mock.calls[0][0].captureHtml).toBe(false);
    });

    it("cacheHtml=refresh forces a live fetch and refreshes the cache", async () => {
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValue({ ...PAGE, html: "<html><body>Fresh</body></html>" });
      const { status } = await jsonRequest("/extract?url=https://example.com&cacheHtml=refresh");
      expect(status).toBe(200);
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(1);
      expect(searchMod.browserOpenAndExtract.mock.calls[0][0].cachedHtml).toBeNull();
      expect(searchMod.browserOpenAndExtract.mock.calls[0][0].captureHtml).toBe(true);
      const again = await jsonRequest("/extract?url=https://example.com&cacheHtml=1");
      expect(again.status).toBe(200);
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(2);
      expect(searchMod.browserOpenAndExtract.mock.calls[1][0].cachedHtml).toContain("Fresh");
    });
  });

  describe("requireSelector identity", () => {
    it("allows two hints with the same domain+path when requireSelector differs", async () => {
      const { status, body } = await jsonRequest("/console/api/hints", {
        method: "POST",
        body: JSON.stringify({ hint: { domain: "example.com", pathPattern: "/**", requireSelector: ".profile-banner", pageType: "profile-page", comment: "selector-split" } }),
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it("still rejects exact duplicates including requireSelector", async () => {
      const { status, body } = await jsonRequest("/console/api/hints", {
        method: "POST",
        body: JSON.stringify({ hint: { domain: "example.com", pathPattern: "/**", requireSelector: ".profile-banner", pageType: "profile-page", comment: "dup" } }),
      });
      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/collides with/);
    });
  });
});
