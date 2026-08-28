import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/browser.js", () => ({
  getBrowserManager: vi.fn(),
  resolveBrowserParam: async ({ browser = "" } = {}, config = null, manager = null) => {
    const mgr = manager || (await getBrowserManager());
    const page = await mgr.newPage({ browser });
    return { page, browser: browser || config?.defaultBackend || "chromium", rollbackNotes: [] };
  }
}));
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
  resetSearchEngine: vi.fn().mockReturnValue(true),
}));
vi.mock("../src/devtools.js", () => ({
  devtoolsToolDefinitions: [{ name: "Target.createTarget" }, { name: "Runtime.evaluate" }],
  formatDevtoolsToolResponse: vi.fn(),
  handleDevtoolsToolCall: vi.fn(),
  captureTargetScreenshot: vi.fn(),
  getDevtoolsCounters: vi.fn().mockReturnValue({ targetsCreated: 0, targetsClosed: 0, targetsInactivityClosed: 0 }),
}));
vi.mock("cloakbrowser", () => ({}));
vi.mock("cloakbrowser/puppeteer", () => ({ launch: vi.fn() }));

const MCP_PORT = 18990;
const MCP_BASE = `http://localhost:${MCP_PORT}`;

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
      searchQueueMinIntervalMs: 300000,
      searchQueueMaxIntervalMs: 3600000,
      searchQueueEscalationFactor: 2,
      searchQueueReadyIntervalMs: 10000,
      searchQueueExplorationEvery: 5,
      searchQueueLatencySamples: 20,
      openPageMaxParallel: 6,
      maxConcurrentPageOps: 30,
      humanTypingDelay: 15,
      prelaunchBrowser: false,
      enableHangRestart: false,
      hangRestartTimeoutMs: 120000,
      startupUrl: "about:blank",
      searchRouteWarmupEngines: [],
      searchEnabledEngines: null,
      screenshotPathPrefix: null,
      enableScreenshotDownloadLink: false,
      enableWebConsole: true,
      vncEnabled: false,
      vncPort: 1995,
      novncPort: 1996,
      debug: false,
      logToolErrors: true,
      ...overrides,
    },
    getHealth: vi.fn().mockResolvedValue({
      ok: true,
      browserConnected: true,
      openPageSlots: { used: 0, max: 10 },
      pageLimiter: { inUse: 0 },
    }),
    getInstanceStats: vi.fn().mockResolvedValue([
      { backend: "chromium", connected: false, tabs: 0, pid: null, spawns: 0 },
      { backend: "cloakbrowser", connected: true, tabs: 2, pid: 42, spawns: 1 },
    ]),
    getRelaySummary: vi.fn().mockReturnValue([]),
    shutdown: vi.fn().mockResolvedValue(undefined),
    prelaunchIfConfigured: vi.fn().mockResolvedValue(undefined),
    relaunchDefaultBackend: vi.fn().mockImplementation(async (headless) => ({ ok: true, backend: "cloakbrowser", relaunched: true, headless: Boolean(headless) })),
  };
}

async function mcpPost(body, extraHeaders = {}) {
  const res = await fetch(`${MCP_BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, body: data };
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

function makeMockSearchPayload(overrides = {}) {
  return {
    query: "test query",
    queries: [],
    results: overrides.results ?? [
      {
        title: "Test Result",
        url: "https://example.com/test",
        snippet: "This is a test snippet",
      },
    ],
    errors: [],
    directAnswers: [],
    ...overrides,
  };
}

describe("mcp-server HTTP endpoints", () => {
  beforeAll(async () => {
    const browserMod = await import("../src/browser.js");
    browserMod.getBrowserManager.mockResolvedValue(makeMockManager());

    // Trigger top-level code by importing mcp-server
    await import("../src/mcp-server.js");

    await waitForServer(`${MCP_BASE}/health`);
  }, 15000);

  afterAll(() => {
    // Clean shutdown
    process.emit("SIGTERM");
  });

  describe("GET /health", () => {
    it("returns 200 with health info", async () => {
      const res = await fetch(`${MCP_BASE}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body).toHaveProperty("browserConnected");
      expect(body).toHaveProperty("searchRouteCircuitBreakers");
    });

    it("GET / serves console when web console enabled", async () => {
      const res = await fetch(`${MCP_BASE}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<title>Navigator Console</title>");
    });
  });

  describe("GET /stats", () => {
    it("returns 200 with instance stats", async () => {
      const res = await fetch(`${MCP_BASE}/stats`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body).toHaveProperty("uptimeSeconds");
      expect(body).toHaveProperty("memory.rss");
      expect(body).toHaveProperty("memory.heapUsed");
      expect(body).toHaveProperty("sessions");
      expect(body).toHaveProperty("cache");
      expect(body.instances).toHaveLength(2);
      const cloak = body.instances.find((i) => i.backend === "cloakbrowser");
      expect(cloak).toMatchObject({ connected: true, tabs: 2, pid: 42, spawns: 1 });
    });

    it("includes activity and devtools counters", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.getActivityCounters.mockReturnValue({
        searches: 5, searchResults: 19, fetches: 3, screenshots: 1, botBlocks: 2,
      });
      const devtoolsMod = await import("../src/devtools.js");
      devtoolsMod.getDevtoolsCounters.mockReturnValue({
        targetsCreated: 7, targetsClosed: 4, targetsInactivityClosed: 1,
      });

      const res = await fetch(`${MCP_BASE}/stats`);
      const body = await res.json();
      expect(body.counters).toMatchObject({
        searches: 5, searchResults: 19, fetches: 3, screenshots: 1, botBlocks: 2,
        targetsCreated: 7, targetsClosed: 4, targetsInactivityClosed: 1,
      });
      expect(body.counters).toHaveProperty("cacheHits");
      expect(body.counters).toHaveProperty("cacheMisses");
    });

    it("includes requests and engineAttempts telemetry", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.getEngineAttemptStats.mockReturnValue({
        total: 4, ok: 3, fail: 1, skip: 0,
        byEngine: { bing: { total: 1, ok: 0, fail: 1, skip: 0 } },
        recentFailures: [{ minutesAgo: 0, engine: "bing", error: "captcha detected" }],
      });

      const res = await fetch(`${MCP_BASE}/stats`);
      const body = await res.json();
      expect(body).toHaveProperty("requests");
      expect(body.requests).toHaveProperty("byPeriod");
      expect(body.requests).toHaveProperty("byTool");
      expect(body.engineAttempts).toMatchObject({
        total: 4, ok: 3, fail: 1, skip: 0,
        recentFailures: [{ minutesAgo: 0, engine: "bing", error: "captcha detected" }],
      });
      expect(body.engineProfiles).toEqual([]);
    });
  });

  describe("POST /engines/reset", () => {
    it("resets one scheduler profile", async () => {
      const searchMod = await import("../src/search.js");
      const res = await fetch(`${MCP_BASE}/engines/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "bing" }) });
      expect(res.status).toBe(200);
      expect(searchMod.resetSearchEngine).toHaveBeenCalledWith("bing");
    });

    it("resets every scheduler profile through the all endpoint", async () => {
      const searchMod = await import("../src/search.js");
      const res = await fetch(`${MCP_BASE}/engines/reset/all`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(searchMod.resetSearchEngine).toHaveBeenCalledWith("all");
    });
  });

  describe("GET /health.vnc", () => {
    it("includes a vnc object with running/enabled/headed/novncPort", async () => {
      const res = await fetch(`${MCP_BASE}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.vnc).toMatchObject({
        enabled: false,
        headed: false,
        novncPort: 1996,
      });
      expect(typeof body.vnc.running).toBe("boolean");
    });
  });

  describe("GET /console", () => {
    it("serves the web console HTML page", async () => {
      const res = await fetch(`${MCP_BASE}/console`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("<title>Navigator Console</title>");
      expect(html).toContain('src="/console/assets/');
    });

    it("serves legacy console aliases and routes through the SPA", async () => {
      for (const p of ["/console/api", "/ui", "/dashboard"]) {
        const res = await fetch(`${MCP_BASE}${p}`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("<title>Navigator Console</title>");
      }
    });
  });

  describe("GET /console/config", () => {
    it("returns config, env subset, engine registry, package, schema and envPath", async () => {
      const res = await fetch(`${MCP_BASE}/console/config`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config).toMatchObject({ enableWebConsole: true, novncPort: 1996 });
      expect(body.engines.length).toBeGreaterThan(0);
      expect(body.availableEngines.length).toBeGreaterThanOrEqual(body.engines.length);
      const ddgApi = body.engines.find((e) => e.id === "duckduckgo_api");
      expect(ddgApi).toMatchObject({ isBrowser: false });
      expect(body.tools).toContain("web_search");
      expect(body.tools).toContain("Target.createTarget");
      expect(body.package).toMatchObject({ name: "navigator-mcp" });
      expect(Array.isArray(body.schema)).toBe(true);
      expect(body.schema.length).toBeGreaterThan(30);
      const schemaKeys = body.schema.map((e) => e.key);
      expect(schemaKeys).toContain("HEADLESS");
      expect(schemaKeys).toContain("ENABLE_VNC");
      expect(schemaKeys).toContain("NOVNC_PORT");
      expect(schemaKeys).toContain("SEARCH_QUEUE_MIN_INTERVAL_MS");
      expect(schemaKeys).toContain("SEARCH_QUEUE_W_RECOVERY");
      expect(typeof body.env).toBe("object");
      expect(typeof body.envPath).toBe("string");
    });
  });

  describe("console MCP tools proxy", () => {
    it("does not expose the internal console key and lists MCP tools", async () => {
      const keys = await fetch(`${MCP_BASE}/console/api-keys`);
      expect(keys.status).toBe(200);
      expect(await keys.json()).not.toHaveProperty("consoleKey");

      const response = await fetch(`${MCP_BASE}/console/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).result.tools.length).toBeGreaterThan(0);
    });

    it("creates named API keys with a creation timestamp", async () => {
      const created = await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create", name: "Console test key", allowedTools: ["web_search"] }),
      });
      const payload = await created.json();
      expect(created.status).toBe(200);
      expect(payload.key).toMatch(/^nvg_/);
      const key = payload.keys.find((entry) => entry.preview === `${payload.key.slice(0, 12)}...${payload.key.slice(-12)}`);
      expect(key).toMatchObject({ name: "Console test key", preview: expect.any(String), createdAt: expect.any(Number), allowedTools: ["web_search"] });

      const tools = await mcpPost(
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { authorization: `Bearer ${payload.key}` },
      );
      expect(tools.body.result.tools.map((tool) => tool.name)).toEqual(["web_search"]);

      const revoked = await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke", id: key.id }),
      });
      expect(revoked.status).toBe(200);
    });
  });

  describe("PUT /console/config — config manager", () => {
    let envDir;
    let envFile;

    beforeEach(() => {
      envDir = fs.mkdtempSync(path.join(os.tmpdir(), "navigator-console-env-"));
      envFile = path.join(envDir, ".env");
      fs.writeFileSync(envFile, "# test env\nMAX_CONCURRENT_PAGE_OPS=30\nHEADLESS=true\n");
      process.env.NAVIGATOR_ENV_FILE = envFile;
    });

    afterEach(() => {
      delete process.env.NAVIGATOR_ENV_FILE;
      try { fs.rmSync(envDir, { recursive: true, force: true }); } catch {}
    });

    it("hot-applies a valid update and persists to .env with backup", async () => {
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { MAX_CONCURRENT_PAGE_OPS: 40 } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.hotApplied).toContain("MAX_CONCURRENT_PAGE_OPS");
      expect(body.envWritten).toBe(true);
      expect(typeof body.backup).toBe("string");

      const after = fs.readFileSync(envFile, "utf8");
      expect(after).toContain("# test env");
      expect(after).toContain("MAX_CONCURRENT_PAGE_OPS=40");
      expect(fs.readdirSync(envDir).some((f) => f.includes(".env.backup-"))).toBe(true);
    });

    it("hot-applies scheduler settings", async () => {
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { SEARCH_QUEUE_ESCALATION_FACTOR: 3 } }),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.hotApplied).toContain("SEARCH_QUEUE_ESCALATION_FACTOR");
      expect(fs.readFileSync(envFile, "utf8")).toContain("SEARCH_QUEUE_ESCALATION_FACTOR=3");
    });

    it("returns restartRequired for recreate-apply keys", async () => {
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { CHROME_PATH: "/usr/bin/chromium" } }),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.restartRequired).toContain("CHROME_PATH");
      expect(body.hotApplied).not.toContain("CHROME_PATH");
    });

    it("rejects unknown variables and invalid values", async () => {
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { NOT_A_REAL_VAR: "1", MAX_CONCURRENT_PAGE_OPS: "not-a-number" } }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.invalid.length).toBe(2);
    });

    it("reset removes a key from .env and returns hot-applied default", async () => {
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reset: ["MAX_CONCURRENT_PAGE_OPS"] }),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.hotApplied.some((k) => k.startsWith("MAX_CONCURRENT_PAGE_OPS"))).toBe(true);
      const after = fs.readFileSync(envFile, "utf8");
      expect(after).not.toContain("MAX_CONCURRENT_PAGE_OPS=");
    });

    it("revert restores the previous .env", async () => {
      await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { MAX_CONCURRENT_PAGE_OPS: 40 } }),
      });
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revert: true }),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.reverted).toBe(true);
      const after = fs.readFileSync(envFile, "utf8");
      expect(after).toContain("MAX_CONCURRENT_PAGE_OPS=30");
    });

    it("GET /console/config exposes envFile info and change history", async () => {
      const res = await fetch(`${MCP_BASE}/console/config`);
      const body = await res.json();
      expect(body.envFile).toMatchObject({ path: envFile });
      expect(Array.isArray(body.changeHistory)).toBe(true);
    });
  });

  describe("POST /console/vnc", () => {
    let envDir;
    let envFile;

    beforeEach(async () => {
      envDir = fs.mkdtempSync(path.join(os.tmpdir(), "navigator-console-vnc-"));
      envFile = path.join(envDir, ".env");
      fs.writeFileSync(envFile, "HEADLESS=true\nENABLE_VNC=0\n");
      process.env.NAVIGATOR_ENV_FILE = envFile;
      const vncMod = await import("../src/vnc-manager.js");
      vncMod.vncManager.steps = [];
      vncMod.vncManager.status = "stopped";
      vncMod.vncManager.start.mockClear();
      vncMod.vncManager.stop.mockClear();
    });

    afterEach(() => {
      delete process.env.NAVIGATOR_ENV_FILE;
      try { fs.rmSync(envDir, { recursive: true, force: true }); } catch {}
    });

    it("enable spawns the stack, relaunches headed and persists ENABLE_VNC=1", async () => {
      const res = await fetch(`${MCP_BASE}/console/vnc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "enable" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.running).toBe(true);
      expect(body.relaunch.headless).toBe(false);

      const vncMod = await import("../src/vnc-manager.js");
      expect(vncMod.vncManager.start).toHaveBeenCalled();

      const after = fs.readFileSync(envFile, "utf8");
      expect(after).toContain("ENABLE_VNC=1");
      expect(after).toContain("HEADLESS=false");
    });

    it("disable stops the stack and restores headless mode", async () => {
      const res = await fetch(`${MCP_BASE}/console/vnc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "disable" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.running).toBe(false);
      expect(body.relaunch.headless).toBe(true);

      const vncMod = await import("../src/vnc-manager.js");
      expect(vncMod.vncManager.stop).toHaveBeenCalled();

      const after = fs.readFileSync(envFile, "utf8");
      expect(after).toContain("ENABLE_VNC=0");
      expect(after).toContain("HEADLESS=true");
    });

    it("rejects unknown actions", async () => {
      const res = await fetch(`${MCP_BASE}/console/vnc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "nuke" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  describe("GET /console/logs", () => {
    it("returns a log tail with tool error entries", async () => {
      const res = await fetch(`${MCP_BASE}/console/logs?n=5`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.entries)).toBe(true);
    });
  });

  describe("GET /search", () => {
    it("returns 400 when no query param", async () => {
      const res = await fetch(`${MCP_BASE}/search`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/missing/i);
    });

    it("returns markdown results for a single query", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "hello world",
      }));

      const res = await fetch(`${MCP_BASE}/search?q=hello+world`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/markdown/);
      const text = await res.text();
      expect(text).toContain("Test Result");
    });

    it("sends markdown content-type", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload());

      const res = await fetch(`${MCP_BASE}/search?q=test`);
      expect(res.headers.get("content-type")).toMatch(/markdown/);
    });

    it("handles queries parameter with || separator", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        queries: ["a", "b"],
      }));

      const res = await fetch(`${MCP_BASE}/search?queries=hello||world`);
      expect(res.status).toBe(200);
    });

    it("handles multiple q parameters", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload());

      const res = await fetch(`${MCP_BASE}/search?q=hello&q=world`);
      expect(res.status).toBe(200);
    });
  });

  describe("GET /extract", () => {
    it("returns 400 when no url param", async () => {
      const res = await fetch(`${MCP_BASE}/extract`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });

    it("calls browserOpenAndExtract with url param", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract.mockResolvedValueOnce({
        text: "extracted content",
        title: "Extracted Page",
      });

      const res = await fetch(`${MCP_BASE}/extract?url=https://example.com`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Extracted Page");
    });
  });

  describe("GET /screenshot", () => {
    it("returns 400 when no url param", async () => {
      const res = await fetch(`${MCP_BASE}/screenshot`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });

    it("calls browserCaptureScreenshot with url param", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserCaptureScreenshot.mockResolvedValueOnce({
        screenshotBase64: "fakebase64",
        contentType: "image/png",
        format: "png",
        title: "Screenshot",
      });

      const res = await fetch(`${MCP_BASE}/screenshot?url=https://example.com`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Screenshot");
    });
  });

  describe("GET 404", () => {
    it("returns 404 for unknown paths", async () => {
      const res = await fetch(`${MCP_BASE}/nonexistent`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  describe("POST /mcp — stateless JSON-RPC", () => {
    it("responds to tools/list", async () => {
      const { status, body } = await mcpPost({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });

      expect(status).toBe(200);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(1);
      expect(body.result.tools).toBeDefined();
      const names = body.result.tools.map((t) => t.name);
      expect(names).toContain("web_search");
      expect(names).toContain("web_fetch");
      expect(names).toContain("web_page_screenshot");
      expect(names).toContain("web_page_svg");
    });

    it("publishes the documented web_fetch input contract", async () => {
      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 56, method: "tools/list"
      });

      expect(status).toBe(200);
      const webFetch = body.result.tools.find((tool) => tool.name === "web_fetch");
      expect(webFetch.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(webFetch.inputSchema.properties).sort()).toEqual([
        "browser", "bypassCache", "maxChars", "ref_ids", "urls"
      ]);
    });

    it("advertises plural-only inputs for web_search, web_page_screenshot, and web_page_links", async () => {
      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 58, method: "tools/list"
      });

      expect(status).toBe(200);
      const tools = body.result.tools;

      const webSearch = tools.find((tool) => tool.name === "web_search");
      const searchProps = Object.keys(webSearch.inputSchema.properties);
      expect(searchProps).toContain("queries");
      expect(searchProps).not.toContain("query");

      const screenshot = tools.find((tool) => tool.name === "web_page_screenshot");
      const screenshotProps = Object.keys(screenshot.inputSchema.properties);
      expect(screenshotProps).toContain("urls");
      expect(screenshotProps).toContain("ref_ids");
      expect(screenshotProps).not.toContain("url");
      expect(screenshotProps).not.toContain("ref_id");

      const links = tools.find((tool) => tool.name === "web_page_links");
      const linksProps = Object.keys(links.inputSchema.properties);
      expect(linksProps).toEqual(["ref_ids"]);
    });

    it("advertises web_page_svg with urls/ref_ids/targetId and svg options (no singular url/ref_id)", async () => {
      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 59, method: "tools/list"
      });
      expect(status).toBe(200);
      const svg = body.result.tools.find((tool) => tool.name === "web_page_svg");
      expect(svg).toBeDefined();
      const props = Object.keys(svg.inputSchema.properties);
      expect(props).not.toContain("url");
      expect(props).toContain("urls");
      expect(props).not.toContain("ref_id");
      expect(props).toContain("ref_ids");
      expect(props).toContain("targetId");
      expect(props).toContain("fullPage");
      expect(props).toContain("elementLimit");
      expect(props).toContain("viewport");
      expect(props).toContain("output");
      expect(svg.inputSchema.additionalProperties).toBe(false);
    });

    it("advertises only the singular engine param for web_search", async () => {
      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 57, method: "tools/list"
      });

      expect(status).toBe(200);
      const webSearch = body.result.tools.find((tool) => tool.name === "web_search");
      expect(webSearch.inputSchema.properties.engine.enum).toBeUndefined();
      expect(webSearch.inputSchema.properties.engines).toBeUndefined();
    });

    it("responds to initialize via session transport with SSE stream", async () => {
      const res = await fetch(`${MCP_BASE}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      expect(res.headers.get("mcp-session-id")).toBeDefined();
    });

    it("returns error for unknown method", async () => {
      const { status, body } = await mcpPost({
        jsonrpc: "2.0",
        id: 3,
        method: "unknown_method",
      });

      expect(status).toBe(200);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32601);
    });

    it("handles web_search with queries array", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "multi",
        queries: ["first query", "second query"],
        results: [
          { title: "Multi Result", url: "https://multi.example.com", snippet: "multi snippet" },
        ],
      }));

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 14, method: "tools/call",
        params: {
          name: "web_search",
          arguments: { query: "multi", queries: ["first query", "second query"] },
        },
      });

      expect(status).toBe(200);
      const text = body.result.content[0].text;
      expect(text).toContain("Multi Result");
    });

    it("renders per-query sections when multiple queries are searched", async () => {
      const searchMod = await import("../src/search.js");
      const makeResults = (prefix, count) =>
        Array.from({ length: count }, (_, i) => ({
          title: `${prefix} Result ${i + 1}`,
          url: `https://example.com/${prefix.replace(/\s+/g, "-")}-${i + 1}`,
          snippet: `snippet ${i + 1} for ${prefix}`,
        }));

      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "god of war",
        queries: ["god of war", "life of pi"],
        queryCount: 2,
        results: makeResults("god of war", 5),
        queryResults: [
          {
            query: "god of war",
            resultCount: 5,
            results: makeResults("god of war", 5),
            directAnswers: [],
            directAnswerCount: 0,
            errors: [],
          },
          {
            query: "life of pi",
            resultCount: 5,
            results: makeResults("life of pi", 5),
            directAnswers: [],
            directAnswerCount: 0,
            errors: [],
          },
        ],
      }));

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 17, method: "tools/call",
        params: {
          name: "web_search",
          arguments: { query: "god of war", queries: ["god of war", "life of pi"], limit: 5 },
        },
      });

      expect(status).toBe(200);
      const text = body.result.content[0].text;
      expect(text).toContain("**Queries:** god of war");
      expect(text).toContain("**Results (5):**");
      expect(text).toContain("god of war Result 1");
      expect(text).toContain("_(queries: god of war)_");
      expect(text).toContain("**Queries:** life of pi");
      expect(text).toContain("life of pi Result 5");
      expect(text).toContain("_(queries: life of pi)_");
    });

    it("renders a single Instant Answer before Results", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "answer to everything",
        results: [
          { title: "Result One", url: "https://example.com/result-one", snippet: "snippet one" },
        ],
        directAnswers: [
          { source: "instant_answer", text: "42 is the answer", url: "https://example.com/answer" },
        ],
        directAnswerCount: 1,
      }));

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 18, method: "tools/call",
        params: { name: "web_search", arguments: { query: "answer to everything" } },
      });

      expect(status).toBe(200);
      const text = body.result.content[0].text;
      const answerIdx = text.indexOf("**Instant Answer:**");
      const resultIdx = text.indexOf("**Results (");
      expect(answerIdx).toBeGreaterThan(-1);
      expect(resultIdx).toBeGreaterThan(answerIdx);
      expect(text).toContain("42 is the answer");
      expect(text).not.toContain("**Direct Answers:**");
    });

    it("handles web_search with limit parameter", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "limited search",
        results: [
          { title: "Limited Result", url: "https://limited.example.com", snippet: "limited" },
        ],
      }));

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 15, method: "tools/call",
        params: {
          name: "web_search",
          arguments: { query: "limited search", limit: 3 },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain("Limited Result");
      expect(searchMod.browserSearch).toHaveBeenCalledWith(
        expect.objectContaining({ queries: ["limited search"], limit: 3 })
      );
    });

    it("handles web_search with singular engine parameter", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "engine test",
        results: [
          { title: "Engine Result", url: "https://engine.example.com", snippet: "engine" },
        ],
      }));

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 16, method: "tools/call",
        params: {
          name: "web_search",
          arguments: {
            query: "engine test",
            engine: "duckduckgo_api",
          },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain("Engine Result");
      expect(searchMod.browserSearch).toHaveBeenCalledWith(
        expect.objectContaining({ engines: ["duckduckgo_api"] })
      );
    });

    it("forwards an explicitly requested route without advertising it", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "explicit route",
        results: [{ title: "Explicit Result", url: "https://explicit.example.com", snippet: "explicit" }],
      }));

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 160, method: "tools/call",
        params: {
          name: "web_search",
          arguments: { query: "explicit route", engine: "duckduckgo" },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain("Explicit Result");
      expect(searchMod.browserSearch).toHaveBeenCalledWith(
        expect.objectContaining({ engines: ["duckduckgo"] })
      );
    });

    it("handles web_search", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "vitest testing",
        results: [
          {
            title: "Vitest Guide",
            url: "https://vitest.dev/guide",
            snippet: "Vitest is a testing framework",
          },
        ],
      }));

      const { status, body } = await mcpPost({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "web_search", arguments: { query: "vitest testing" } },
      });

      expect(status).toBe(200);
      expect(body.result).toBeDefined();
      expect(body.result.content).toBeDefined();
      const text = body.result.content[0].text;
      expect(text).toContain("Vitest Guide");
      expect(text).toMatch(/- \*\*Vitest Guide\*\* \[vitest\.dev\]\(\d+\)/);
      expect(text).not.toContain("https://vitest.dev/guide");
      expect(text).toContain("*Link destinations in parentheses are ref_ids.*");
    });

    it("handles web_fetch with url", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract.mockResolvedValueOnce({
        text: "page content here",
        title: "Example Page",
        url: "https://example.com",
      });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 5, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { url: "https://example.com", maxChars: 500 },
        },
      });

      expect(status).toBe(200);
      const text = body.result.content[0].text;
      expect(text).toContain("Example Page");
      expect(text).toMatch(/### \[Example Page\]\(\d+\)/);
      expect(text).toContain("page content here");
      expect(text).not.toContain("  - page content here");
    });

    it("forwards normalized extraction limits to the page extractor", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValueOnce({
        text: "limited page",
        title: "Limited Page",
        url: "https://limits.example.com"
      });

      const { status } = await mcpPost({
        jsonrpc: "2.0", id: 51, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: {
            url: "https://limits.example.com",
            maxChars: 999999
          }
        }
      });

      expect(status).toBe(200);
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledWith({
        url: "https://limits.example.com",
        includeSeoAnalysis: true,
        hintOverride: null,
        cachedHtml: null,
        captureHtml: false,
        browser: ""
      });
    });

    it("preserves requested order and returns partial extraction failures", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockImplementation(async ({ url }) => {
        if (url === "https://slow.example.com") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { text: "slow content", title: "Slow Page", url };
        }
        if (url === "https://broken.example.com") {
          throw new Error("upstream navigation failed");
        }
        return { text: "fast content", title: "Fast Page", url };
      });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 53, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: {
            urls: ["https://slow.example.com", "https://broken.example.com", "https://fast.example.com"]
          }
        }
      });

      expect(status).toBe(200);
      const text = body.result.content[0].text;
      expect(text).toContain("Processed 3 page(s); 2 succeeded.");
      expect(text.indexOf("Slow Page")).toBeLessThan(text.indexOf("https://broken.example.com"));
      expect(text.indexOf("https://broken.example.com")).toBeLessThan(text.indexOf("Fast Page"));
      expect(text).toContain("Status: Failed");
      expect(text).toContain("upstream navigation failed");
    });

    it("registers extracted links and rewrites matching markdown links to references", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValueOnce({
        text: "Read the [documentation](https://docs.example.com/guide).",
        title: "Documentation Index",
        url: "https://links.example.com",
        links: [{ href: "https://docs.example.com/guide", text: "documentation" }]
      });

      const fetchResponse = await mcpPost({
        jsonrpc: "2.0", id: 54, method: "tools/call",
        params: { name: "web_fetch", arguments: { url: "https://links.example.com" } }
      });

      expect(fetchResponse.status).toBe(200);
      const text = fetchResponse.body.result.content[0].text;
      const linkRef = text.match(/\[documentation\]\((\d+)\)/)?.[1];
      expect(linkRef).toBeTruthy();
      expect(text).not.toContain("[documentation](https://docs.example.com/guide)");

      const linksResponse = await mcpPost({
        jsonrpc: "2.0", id: 55, method: "tools/call",
        params: { name: "web_page_links", arguments: { ref_id: Number(linkRef) } }
      });
      expect(linksResponse.status).toBe(200);
      expect(linksResponse.body.result.content[0].text).toContain(`- (${linkRef}): https://docs.example.com/guide`);
    });

    it("handles web_fetch with urls array", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract
        .mockResolvedValueOnce({ text: "page A", title: "Page A", url: "https://a.example.com" })
        .mockResolvedValueOnce({ text: "page B", title: "Page B", url: "https://b.example.com" });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 17, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { urls: ["https://a.example.com", "https://b.example.com"], maxChars: 300 },
        },
      });

      expect(status).toBe(200);
      const text = body.result.content[0].text;
      expect(text).toContain("Processed 2 page(s)");
      expect(text).toContain("Page A");
      expect(text).toContain("Page B");
    });

    it("handles web_fetch with extractLinks", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract.mockResolvedValueOnce({
        text: "page with links",
        title: "Linked Page",
        url: "https://links.example.com",
        links: [{ href: "https://example.com/link", text: "Example Link" }],
      });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 18, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { url: "https://links.example.com", extractLinks: true },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain("Linked Page");
    });

    it("handles web_fetch with maxTableRows", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract.mockResolvedValueOnce({
        text: "page with tables",
        title: "Table Page",
        url: "https://tables.example.com",
        tables: [{ rows: 5 }],
      });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 19, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { url: "https://tables.example.com", maxTableRows: 10 },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain("Table Page");
    });

    it("handles web_fetch with includeTables", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract.mockResolvedValueOnce({
        text: "page with tables",
        title: "Table Page",
        url: "https://tables.example.com",
        tables: [{ rows: 3 }],
      });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 22, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { url: "https://tables.example.com", includeTables: true },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain("Table Page");
    });

    it("handles web_fetch with ref_ids array", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "fetch targets",
        results: [
          { title: "Fetch 1", url: "https://f1.example.com", snippet: "one" },
          { title: "Fetch 2", url: "https://f2.example.com", snippet: "two" },
        ],
      }));
      await mcpPost({
        jsonrpc: "2.0", id: 27, method: "tools/call",
        params: { name: "web_search", arguments: { query: "fetch targets" } },
      });

      searchMod.browserOpenAndExtract
        .mockResolvedValueOnce({ text: "fetch one", title: "Fetch 1 Page", url: "https://f1.example.com" })
        .mockResolvedValueOnce({ text: "fetch two", title: "Fetch 2 Page", url: "https://f2.example.com" });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 28, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { ref_ids: [1, 2], maxChars: 400 },
        },
      });

      expect(status).toBe(200);
      const text = body.result.content[0].text;
      expect(text).toContain("Fetch 1 Page");
      expect(text).toContain("Fetch 2 Page");
    });

    it("resolves a web_fetch ref_id from the preceding search result", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockReset();
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "single fetch target",
        results: [{ title: "Single Fetch", url: "https://single-fetch.example.com", snippet: "target" }]
      }));

      const searchResponse = await mcpPost({
        jsonrpc: "2.0", id: 57, method: "tools/call",
        params: { name: "web_search", arguments: { query: "single fetch target" } }
      });
      const refId = Number(searchResponse.body.result.content[0].text.match(/\[[^\]]+\]\((\d+)\)/)?.[1]);
      expect(refId).toBeGreaterThan(0);

      searchMod.browserOpenAndExtract.mockResolvedValueOnce({
        text: "single target content",
        title: "Single Fetch Page",
        url: "https://single-fetch.example.com"
      });
      const fetchResponse = await mcpPost({
        jsonrpc: "2.0", id: 58, method: "tools/call",
        params: { name: "web_fetch", arguments: { ref_id: refId } }
      });

      expect(fetchResponse.status).toBe(200);
      expect(fetchResponse.body.result.content[0].text).toContain("Single Fetch Page");
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledWith(expect.objectContaining({
        url: "https://single-fetch.example.com"
      }));
    });

    it("handles web_fetch with ref alias (deprecated)", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "ref alias target",
        results: [{ title: "Ref Alias", url: "https://refalias.example.com", snippet: "alias" }],
      }));
      await mcpPost({
        jsonrpc: "2.0", id: 29, method: "tools/call",
        params: { name: "web_search", arguments: { query: "ref alias target" } },
      });

      searchMod.browserOpenAndExtract.mockResolvedValueOnce({
        text: "ref alias content",
        title: "Ref Alias Page",
        url: "https://refalias.example.com",
      });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 30, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { ref: 1 },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain("Ref Alias Page");
    });

    it("handles web_fetch with refs alias (deprecated)", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "refs alias targets",
        results: [
          { title: "Refs 1", url: "https://refs1.example.com", snippet: "r1" },
          { title: "Refs 2", url: "https://refs2.example.com", snippet: "r2" },
        ],
      }));
      await mcpPost({
        jsonrpc: "2.0", id: 31, method: "tools/call",
        params: { name: "web_search", arguments: { query: "refs alias targets" } },
      });

      searchMod.browserOpenAndExtract
        .mockResolvedValueOnce({ text: "refs one", title: "Refs 1 Page", url: "https://refs1.example.com" })
        .mockResolvedValueOnce({ text: "refs two", title: "Refs 2 Page", url: "https://refs2.example.com" });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 32, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { refs: [1, 2] },
        },
      });

      expect(status).toBe(200);
      const text = body.result.content[0].text;
      expect(text).toContain("Refs 1 Page");
      expect(text).toContain("Refs 2 Page");
    });

    it("handles web_page_screenshot with url", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserCaptureScreenshot.mockResolvedValueOnce({
        screenshotBase64: "dGVzdA==",
        contentType: "image/png",
        format: "png",
        title: "Screenshot Page",
        url: "https://screenshot.example.com",
      });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 7, method: "tools/call",
        params: {
          name: "web_page_screenshot",
          arguments: { url: "https://screenshot.example.com" },
        },
      });

      expect(status).toBe(200);
      const text = body.result.content[0].text;
      expect(text).toContain("Screenshot Page");
      expect(text).toContain("Captured 1 screenshot");
    });

    it("handles web_page_screenshot with urls array", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserCaptureScreenshot
        .mockResolvedValueOnce({ screenshotBase64: "YQ==", title: "SS A", url: "https://a.example.com" })
        .mockResolvedValueOnce({ screenshotBase64: "Yg==", title: "SS B", url: "https://b.example.com" });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 8, method: "tools/call",
        params: {
          name: "web_page_screenshot",
          arguments: { urls: ["https://a.example.com", "https://b.example.com"] },
        },
      });

      expect(status).toBe(200);
      const text = body.result.content[0].text;
      expect(text).toContain("Captured 2 screenshot(s)");
      expect(text).toContain("SS A");
      expect(text).toContain("SS B");
    });

    it("handles web_page_screenshot with fullPage: false", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserCaptureScreenshot.mockResolvedValueOnce({
        screenshotBase64: "dGVzdA==",
        title: "Viewport Screenshot",
        url: "https://viewport.example.com",
      });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 9, method: "tools/call",
        params: {
          name: "web_page_screenshot",
          arguments: { url: "https://viewport.example.com", fullPage: false },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain("Viewport Screenshot");
      expect(searchMod.browserCaptureScreenshot).toHaveBeenCalledWith(
        expect.objectContaining({ fullPage: false })
      );
    });

    it("handles web_page_screenshot with jpeg format and quality", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserCaptureScreenshot.mockResolvedValueOnce({
        screenshotBase64: "and=",
        title: "JPEG Screenshot",
        url: "https://jpeg.example.com",
        contentType: "image/jpeg",
        format: "jpeg",
      });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 13, method: "tools/call",
        params: {
          name: "web_page_screenshot",
          arguments: { url: "https://jpeg.example.com", format: "jpeg", quality: 85 },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain("JPEG Screenshot");
      expect(body.result.content[0].text).toContain("Content-Type: image/jpeg");
    });

    it("handles web_page_screenshot with ref_id", async () => {
      // First, create a remembered link via web_search
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "screenshot target",
        results: [{ title: "Screen Target", url: "https://screen.example.com", snippet: "target" }],
      }));
      await mcpPost({
        jsonrpc: "2.0", id: 23, method: "tools/call",
        params: { name: "web_search", arguments: { query: "screenshot target" } },
      });

      // Now try screenshot with ref_id 1 (first result from web_search gets ref 1)
      searchMod.browserCaptureScreenshot.mockResolvedValueOnce({
        screenshotBase64: "dGVzdA==",
        title: "Screen Page",
        url: "https://screen.example.com",
      });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 24, method: "tools/call",
        params: {
          name: "web_page_screenshot",
          arguments: { ref_id: 1 },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain("Screen Page");
    });

    it("handles web_page_screenshot with ref_ids array", async () => {
      const searchMod = await import("../src/search.js");
      // Create 2 remembered links via search
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "targets",
        results: [
          { title: "Target 1", url: "https://t1.example.com", snippet: "one" },
          { title: "Target 2", url: "https://t2.example.com", snippet: "two" },
        ],
      }));
      await mcpPost({
        jsonrpc: "2.0", id: 25, method: "tools/call",
        params: { name: "web_search", arguments: { query: "targets" } },
      });

      // Screenshot with ref_ids — after search ref 1 = t1, ref 2 = t2
      searchMod.browserCaptureScreenshot
        .mockResolvedValueOnce({ screenshotBase64: "MQ==", title: "Target 1 Page", url: "https://t1.example.com" })
        .mockResolvedValueOnce({ screenshotBase64: "Mg==", title: "Target 2 Page", url: "https://t2.example.com" });

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 26, method: "tools/call",
        params: {
          name: "web_page_screenshot",
          arguments: { ref_ids: [1, 2] },
        },
      });

      expect(status).toBe(200);
      const text = body.result.content[0].text;
      expect(text).toContain("Target 1 Page");
      expect(text).toContain("Target 2 Page");
    });

    it("returns an MCP tool error for failures in stateless mode", async () => {
      const res = await fetch(`${MCP_BASE}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "nonexistent_tool", arguments: {} },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toMatch(/Unknown tool/);
    });

    it("returns an actionable error for an unknown screenshot ref_id", async () => {
      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 7, method: "tools/call",
        params: {
          name: "web_page_screenshot",
          arguments: { ref_id: 999999 },
        },
      });

      expect(status).toBe(200);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toBe(
        "Error calling web_page_screenshot: No link found in memory for ref 999999"
      );
    });

    it("returns 204 for notifications", async () => {
      const res = await fetch(`${MCP_BASE}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
      expect(res.status).toBe(204);
    });

    it("handles web_fetch with ref_id after web_search creates link memory", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "find page",
        results: [
          {
            title: "Found Page",
            url: "https://found.example.com/page",
            snippet: "found content",
          },
        ],
      }));

      const searchResp = await mcpPost({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "web_search", arguments: { query: "find page" } },
      });
      expect(searchResp.status).toBe(200);

      // Now try web_fetch with url directly
      searchMod.browserOpenAndExtract.mockResolvedValueOnce({
        text: "found page content",
        title: "Found Page",
        url: "https://found.example.com/page",
      });

      const fetchResp = await mcpPost({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { url: "https://found.example.com/page", maxChars: 500 },
        },
      });

      expect(fetchResp.status).toBe(200);
      expect(fetchResp.body.result.content[0].text).toContain("Found Page");
    });

    it("web_fetch returns an MCP tool error on invalid ref_id in stateless mode", async () => {
      const res = await fetch(`${MCP_BASE}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 12,
          method: "tools/call",
          params: {
            name: "web_fetch",
            arguments: { ref_id: 99999 },
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toMatch(/No link found/);
    });

    it("caches search results by argument key", async () => {
      const searchMod = await import("../src/search.js");
      const query = `cached query ${Date.now()}`;
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query,
        results: [{ title: "Cached Result", url: "https://cached.example.com", snippet: "cached" }],
      }));

      const r1 = await mcpPost({
        jsonrpc: "2.0", id: 20, method: "tools/call",
        params: { name: "web_search", arguments: { query } },
      });
      expect(r1.status).toBe(200);

      searchMod.browserSearch.mockReset();

      const r2 = await mcpPost({
        jsonrpc: "2.0", id: 21, method: "tools/call",
        params: { name: "web_search", arguments: { query } },
      });
      expect(r2.status).toBe(200);
      expect(r2.body.result.content[0].text).toContain("Cached Result");
      expect(searchMod.browserSearch).not.toHaveBeenCalled();
    });

    it("bypasses cached search and fetch responses then refreshes them", async () => {
      const searchMod = await import("../src/search.js");
      const query = `bypass cache ${Date.now()}`;
      const url = `https://bypass-${Date.now()}.example.com`;

      searchMod.browserSearch.mockReset();
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query,
        results: [{ title: "Cached Search", url, snippet: "cached" }]
      }));
      await mcpPost({
        jsonrpc: "2.0", id: 59, method: "tools/call",
        params: { name: "web_search", arguments: { query } }
      });

      searchMod.browserSearch.mockReset();
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query,
        results: [{ title: "Fresh Search", url, snippet: "fresh" }]
      }));
      const bypassSearch = await mcpPost({
        jsonrpc: "2.0", id: 60, method: "tools/call",
        params: { name: "web_search", arguments: { query, bypassCache: true } }
      });
      expect(bypassSearch.body.result.content[0].text).toContain("Fresh Search");

      searchMod.browserSearch.mockReset();
      const cachedSearch = await mcpPost({
        jsonrpc: "2.0", id: 61, method: "tools/call",
        params: { name: "web_search", arguments: { query } }
      });
      expect(cachedSearch.body.result.content[0].text).toContain("Fresh Search");
      expect(searchMod.browserSearch).not.toHaveBeenCalled();

      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValueOnce({ text: "cached page", title: "Cached Page", url });
      await mcpPost({
        jsonrpc: "2.0", id: 62, method: "tools/call",
        params: { name: "web_fetch", arguments: { url } }
      });

      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValueOnce({ text: "fresh page", title: "Fresh Page", url });
      const bypassFetch = await mcpPost({
        jsonrpc: "2.0", id: 63, method: "tools/call",
        params: { name: "web_fetch", arguments: { url, bypassCache: true } }
      });
      expect(bypassFetch.body.result.content[0].text).toContain("Fresh Page");

      searchMod.browserOpenAndExtract.mockReset();
      const cachedFetch = await mcpPost({
        jsonrpc: "2.0", id: 64, method: "tools/call",
        params: { name: "web_fetch", arguments: { url } }
      });
      expect(cachedFetch.body.result.content[0].text).toContain("Fresh Page");
      expect(searchMod.browserOpenAndExtract).not.toHaveBeenCalled();
    });

    it("uses the web_fetch result cache normally for post-processor hints (no longer skips)", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ai-cache-"));
      const hintsPath = path.join(tempDir, "domain-hints.json");
      fs.writeFileSync(hintsPath, JSON.stringify([{
        domain: "ai.example.com",
        pathPattern: "/**",
        default: { format: "reader_lm" }
      }]));

      const browserMod = await import("../src/browser.js");
      browserMod.getBrowserManager.mockResolvedValue(makeMockManager({
        domainHintsPath: hintsPath,
        postProcessorModels: [{ id: "reader_lm", label: "Reader LM", model: "reader-lm:0.5b", baseUrl: "http://localhost:9999" }]
      }));

      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValue({ text: "ai extracted", title: "AI Page", url: "https://ai.example.com/page" });

      try {
        const url = `https://ai.example.com/page-${Date.now()}`;
        for (let i = 0; i < 2; i += 1) {
          const res = await mcpPost({
            jsonrpc: "2.0", id: 70 + i, method: "tools/call",
            params: { name: "web_fetch", arguments: { url } }
          });
          expect(res.status).toBe(200);
          expect(res.body.result.content[0].text).toContain("ai extracted");
        }
        expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(1);
      } finally {
        browserMod.getBrowserManager.mockResolvedValue(makeMockManager());
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("POST /mcp — session-based", () => {
    it("creates a session via initialize request and returns SSE stream with sessionId header", async () => {
      const res = await fetch(`${MCP_BASE}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 100,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "session-test", version: "1.0" },
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      expect(res.headers.get("mcp-session-id")).toBeDefined();
      expect(res.headers.get("mcp-session-id").length).toBeGreaterThan(0);
    });
  });

  describe("tools/list with devtools disabled", () => {
    it("does not include devtools tools when enableDevtoolsMcp is false", async () => {
      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 50, method: "tools/list",
      });

      expect(status).toBe(200);
      const names = body.result.tools.map((t) => t.name);
      expect(names).not.toContain("Target.createTarget");
      expect(names).not.toContain("Runtime.evaluate");
      expect(names).not.toContain("DOM.querySelector");
    });

    it("returns the seven public search, page, and browser tools (including web_page_svg and list_browsers)", async () => {
      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 51, method: "tools/list",
      });

      expect(status).toBe(200);
      const names = body.result.tools.map((t) => t.name);
      expect(names).toEqual([
        "web_search",
        "web_fetch",
        "web_page_screenshot",
        "web_page_links",
        "web_page_ascii",
        "web_page_svg",
        "list_browsers",
      ]);
    });
  });

  describe("HTTP method handling", () => {
    it("returns 405 for POST on /health", async () => {
      const res = await fetch(`${MCP_BASE}/health`, { method: "POST" });
      expect(res.status).toBe(405);
    });

    it("returns 405 for PUT on /mcp", async () => {
      const res = await fetch(`${MCP_BASE}/mcp`, { method: "PUT" });
      expect(res.status).toBe(405);
    });

    it("returns 405 for DELETE on /health", async () => {
      const res = await fetch(`${MCP_BASE}/health`, { method: "DELETE" });
      expect(res.status).toBe(405);
    });
  });

  describe("GET /screenshot with format and quality params", () => {
    it("passes format and quality options", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserCaptureScreenshot.mockResolvedValueOnce({
        screenshotBase64: "fakebase64",
        contentType: "image/jpeg",
        format: "jpeg",
        title: "JPEG Screenshot",
      });

      const res = await fetch(
        `${MCP_BASE}/screenshot?url=https://example.com&format=jpeg&quality=80`
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("JPEG Screenshot");
    });
  });

  describe("GET /search with engine param", () => {
    it("passes engine to browserSearch", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "engine test",
      }));

      const res = await fetch(
        `${MCP_BASE}/search?q=engine+test&engine=duckduckgo_api`
      );
      expect(res.status).toBe(200);
    });
  });
});

describe("logToolError", () => {
  let tmpDir;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-err-"));
  });

  it("does nothing when logToolErrors is false", async () => {
    const { logToolError } = await import("../src/mcp-server.js");
    const logPath = path.join(tmpDir, "tool-errors.log");
    await logToolError({
      tool: "web_fetch",
      args: { url: "https://example.com" },
      error: new Error("boom"),
      transport: "mcp",
      logToolErrors: false,
      logPath,
    });
    await expect(fs.promises.access(logPath)).rejects.toThrow();
  });

  it("writes a JSON line when logToolErrors is on", async () => {
    const { logToolError } = await import("../src/mcp-server.js");
    const logPath = path.join(tmpDir, "tool-errors.log");
    await logToolError({
      tool: "web_fetch",
      args: { url: "https://example.com/a/b" },
      error: new Error("boom"),
      ms: 12,
      transport: "mcp",
      logToolErrors: true,
      logPath,
    });
    const content = await fs.promises.readFile(logPath, "utf8");
    const line = JSON.parse(content.trim());
    expect(line.level).toBe("tool_error");
    expect(line.tool).toBe("web_fetch");
    expect(line.error).toBe("boom");
    expect(line.ms).toBe(12);
    expect(line.transport).toBe("mcp");
    expect(line.ts).toBeDefined();
  });

  it("writes by default when the manager config has logToolErrors enabled", async () => {
    const { logToolError } = await import("../src/mcp-server.js");
    const logPath = path.join(tmpDir, "tool-errors.log");
    await logToolError({
      tool: "web_search",
      args: { query: "hello world" },
      error: new Error("route down"),
      transport: "stateless",
      logPath,
    });
    const content = await fs.promises.readFile(logPath, "utf8");
    expect(content).toContain('"tool":"web_search"');
  });

  it("redacts insertText text and sensitive keys", async () => {
    const { logToolError } = await import("../src/mcp-server.js");
    const logPath = path.join(tmpDir, "tool-errors.log");
    await logToolError({
      tool: "Input.insertText",
      args: { targetId: "t1", selector: "input[type='password']", text: "hunter2" },
      error: new Error("Could not resolve element for Input.insertText"),
      transport: "stateless",
      logToolErrors: true,
      logPath,
    });
    await logToolError({
      tool: "some_tool",
      args: { apiKey: "abc123", url: "https://example.com" },
      error: new Error("boom"),
      transport: "stateless",
      logToolErrors: true,
      logPath,
    });
    const content = await fs.promises.readFile(logPath, "utf8");
    expect(content).not.toContain("hunter2");
    expect(content).not.toContain("abc123");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].args.text).toBe("<7 chars>");
    expect(lines[1].args.apiKey).toBe("[REDACTED]");
  });

  it("rotates to a .1 backup past maxBytes", async () => {
    const { logToolError } = await import("../src/mcp-server.js");
    const logPath = path.join(tmpDir, "tool-errors.log");
    await logToolError({ tool: "a", args: {}, error: new Error("x"), transport: "mcp", logToolErrors: true, logPath, maxBytes: 1 });
    await logToolError({ tool: "b", args: {}, error: new Error("y"), transport: "mcp", logToolErrors: true, logPath, maxBytes: 1 });
    const backup = await fs.promises.readFile(`${logPath}.1`, "utf8");
    expect(backup).toContain('"tool":"a"');
    const current = await fs.promises.readFile(logPath, "utf8");
    expect(current).toContain('"tool":"b"');
  });
});

describe("DISABLE_TOOLS env filtering", () => {
  const DISABLED_PORT = MCP_PORT + 1;
  const DISABLED_BASE = `http://localhost:${DISABLED_PORT}`;

  beforeAll(async () => {
    vi.resetModules();
    const browserMod = await import("../src/browser.js");
    browserMod.getBrowserManager.mockResolvedValue(
      makeMockManager({
        mcpApiPort: DISABLED_PORT,
        disableTools: ["web_page_ascii"],
      })
    );
    await import("../src/mcp-server.js");
    await waitForServer(`${DISABLED_BASE}/health`);
  }, 15000);

  it("hides a disabled tool from tools/list", async () => {
    const { status, body } = await mcpPostWithBase(DISABLED_BASE, {
      jsonrpc: "2.0", id: 60, method: "tools/list",
    });
    expect(status).toBe(200);
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).not.toContain("web_page_ascii");
  });

  it("rejects calls to a disabled tool", async () => {
    const { status, body } = await mcpPostWithBase(DISABLED_BASE, {
      jsonrpc: "2.0",
      id: 61,
      method: "tools/call",
      params: { name: "web_page_ascii", arguments: { url: "https://example.com" } },
    });
    expect(status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("disabled");
    expect(body.result.content[0].text).toContain("DISABLE_TOOLS");
  });
});

async function mcpPostWithBase(base, body, extraHeaders = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, body: data };
}
