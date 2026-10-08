import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/browser.js", () => ({
  getBrowserManager: vi.fn(),
  // list_browsers renders an ownership column from this; a relay (navigator-cdp)
  // browser is the user's real window, everything else is agent-owned.
  browserOwnership: (type) => (type === "navigator-cdp" ? "user" : "agent"),
  // The inbuilt row never takes a configured prompt — it gets this instead.
  builtinBrowserPrompt: (position, total) =>
    `Built-in Chromium — browser #${position} of ${total} in the execution order.`,
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
  purgeEngineRuntimeState: vi.fn().mockReturnValue(true),
  reconfigureEngineScheduler: vi.fn(),
}));
vi.mock("../src/devtools.js", () => ({
  devtoolsToolDefinitions: [{ name: "Target.createTarget" }, { name: "Runtime.evaluate" }],
  formatDevtoolsToolResponse: vi.fn(),
  handleDevtoolsToolCall: vi.fn(),
  captureTargetScreenshot: vi.fn(),
  getDevtoolsCounters: vi.fn().mockReturnValue({ targetsCreated: 0, targetsClosed: 0, targetsInactivityClosed: 0 }),
  releaseTargetsByBackend: vi.fn().mockReturnValue([]),
}));
vi.mock("cloakbrowser", () => ({}));
vi.mock("cloakbrowser/puppeteer", () => ({ launch: vi.fn() }));
vi.mock("../src/env-file.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, writeEnvFile: vi.fn((...args) => actual.writeEnvFile(...args)) };
});

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
      browsers: [
        { name: "chromium", role: ["default"], type: "inbuilt", addOn: false },
        { name: "cloakbrowser", role: ["default"], type: "cdp", cdpUrl: "http://cloak:9222", addOn: true },
      ],
      ...overrides,
    },
    _effectiveAddOns: () => [
      { name: "cloakbrowser", type: "cdp", role: ["default"], cdpUrl: "http://cloak:9222", status: "available", configured: true },
    ],
    getHealth: vi.fn().mockResolvedValue({
      ok: true,
      browserConnected: true,
      openPageSlots: { used: 0, max: 10 },
      pageLimiter: { inUse: 0 },
      browsers: [
        { name: "chromium", type: "inbuilt", role: ["default"], status: "disconnected", connected: false },
        { name: "cloakbrowser", type: "cdp", role: ["default"], status: "available", connected: false },
      ],
    }),
    getInstanceStats: vi.fn().mockResolvedValue([
      { backend: "chromium", connected: false, tabs: 0, pid: null, type: "inbuilt" },
      { backend: "cloakbrowser", connected: true, tabs: 2, pid: 42, type: "cdp" },
    ]),
    getRelaySummary: vi.fn().mockReturnValue([]),
    shutdown: vi.fn().mockResolvedValue(undefined),
    prelaunchIfConfigured: vi.fn().mockResolvedValue(undefined),
    relaunchDefaultBackend: vi.fn().mockImplementation(async (headless) => ({ ok: true, backend: "cloakbrowser", relaunched: true, headless: Boolean(headless) })),
    invalidateAddOn: vi.fn().mockReturnValue([]),
    applyWarmupListChange: vi.fn().mockResolvedValue(undefined),
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
      expect(cloak).toMatchObject({ connected: true, tabs: 2, pid: 42, type: "cdp" });
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

  describe("GET /stats/activity-trend", () => {
    it("returns 400 for an unsupported range", async () => {
      const res = await fetch(`${MCP_BASE}/stats/activity-trend?range=year`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/Unsupported activity trend range/);
    });

    it("returns 400 for an unknown engine", async () => {
      const res = await fetch(`${MCP_BASE}/stats/activity-trend?engine=bogus_engine`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/Unknown search engine/);
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

      const clientKey = await fetch(`${MCP_BASE}/console/mcp-client-key`);
      const client = await clientKey.json();
      expect(client.ok).toBe(true);

      const response = await fetch(`${MCP_BASE}/console/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${client.key}` },
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

    it("lists browsers and per-key browser access in the keys payload (plan 55)", async () => {
      const res = await fetch(`${MCP_BASE}/console/api-keys`);
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.browsers.map((b) => b.name)).toEqual(
        expect.arrayContaining(["chromium", "cloakbrowser"])
      );
      expect(payload.browsers[0]).toMatchObject({
        name: expect.any(String),
        type: expect.any(String),
        connected: expect.any(Boolean),
      });
      expect(payload).toHaveProperty("cdpBase");
      expect(payload).toHaveProperty("cdpPort");
    });

    it("creates keys with browser access, replaces it via set_browsers, drops unknown names (plan 55)", async () => {
      const created = await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name: "CDP scoped key",
          allowedTools: ["web_search"],
          allowedBrowsers: ["cloakbrowser", "no-such-browser"],
        }),
      });
      const payload = await created.json();
      expect(created.status).toBe(200);
      const key = payload.keys.find((entry) => entry.preview === `${payload.key.slice(0, 12)}...${payload.key.slice(-12)}`);
      // Unknown browser names are dropped on create.
      expect(key).toMatchObject({ name: "CDP scoped key", allowedBrowsers: ["cloakbrowser"] });

      const replaced = await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set_browsers", id: key.id, allowedBrowsers: ["chromium"] }),
      });
      const after = await replaced.json();
      expect(replaced.status).toBe(200);
      expect(after.keys.find((entry) => entry.id === key.id)).toMatchObject({
        allowedBrowsers: ["chromium"],
      });

      const revoked = await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke", id: key.id }),
      });
      expect(revoked.status).toBe(200);
    });

    it("carries allowedMcpBrowsers per key, creates and replaces it independently of CDP (plan 57)", async () => {
      const created = await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name: "MCP scoped key",
          allowedTools: ["web_search"],
          // The two lists are independent: MCP gets cloakbrowser, CDP gets chromium.
          allowedMcpBrowsers: ["cloakbrowser", "no-such-browser"],
          allowedBrowsers: ["chromium"],
        }),
      });
      const payload = await created.json();
      expect(created.status).toBe(200);
      const key = payload.keys.find((entry) => entry.preview === `${payload.key.slice(0, 12)}...${payload.key.slice(-12)}`);
      // Unknown names are dropped, and allowedBrowsers is untouched by the MCP list.
      expect(key).toMatchObject({
        name: "MCP scoped key",
        allowedMcpBrowsers: ["cloakbrowser"],
        allowedBrowsers: ["chromium"],
      });

      const replaced = await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set_mcp_browsers", id: key.id, allowedMcpBrowsers: ["cloakbrowser", "chromium"] }),
      });
      const after = await replaced.json();
      expect(replaced.status).toBe(200);
      const updated = after.keys.find((entry) => entry.id === key.id);
      expect(updated.allowedMcpBrowsers).toEqual(["cloakbrowser", "chromium"]);
      // set_mcp_browsers must not touch the CDP list (plan 57 §2.2).
      expect(updated.allowedBrowsers).toEqual(["chromium"]);

      // An empty list stays [] (deny everything) rather than silently widening
      // back to "all browsers".
      const emptied = await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set_mcp_browsers", id: key.id, allowedMcpBrowsers: [] }),
      });
      const emptyPayload = await emptied.json();
      expect(emptyPayload.keys.find((entry) => entry.id === key.id).allowedMcpBrowsers).toEqual([]);

      const revoked = await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke", id: key.id }),
      });
      expect(revoked.status).toBe(200);
    });

    it("leaves legacy keys unrestricted (allowedMcpBrowsers === null) (plan 57)", async () => {
      // A key created before the migration has no allowed_mcp_browsers value,
      // which must mean "unrestricted", not "no browsers".
      const dbMod = await import("../src/db.js");
      const { randomBytes } = await import("node:crypto");
      const secret = `nvg_${randomBytes(32).toString("base64url")}`;
      dbMod.createMcpApiKey({ name: "Legacy key", secret, allowedTools: ["web_search"] });

      const res = await fetch(`${MCP_BASE}/console/api-keys`);
      const payload = await res.json();
      expect(payload.keys.find((entry) => entry.name === "Legacy key").allowedMcpBrowsers).toBeNull();
    });

    it("GET /cdp requires a key and lists shareable browsers (plan 55)", async () => {
      const anon = await fetch(`${MCP_BASE}/cdp`);
      expect(anon.status).toBe(401);

      const created = await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create", name: "CDP discovery key" }),
      });
      const payload = await created.json();
      const authed = await fetch(`${MCP_BASE}/cdp`, {
        headers: { authorization: `Bearer ${payload.key}` },
      });
      expect(authed.status).toBe(200);
      const body = await authed.json();
      expect(body.ok).toBe(true);
      expect(body.browsers.map((b) => b.name)).toEqual(
        expect.arrayContaining(["chromium", "cloakbrowser"])
      );
      const cloak = body.browsers.find((b) => b.name === "cloakbrowser");
      expect(cloak.cdpUrl).toContain("/cdp/cloakbrowser?key=<your key>");

      const key = payload.keys.find((entry) => entry.preview === `${payload.key.slice(0, 12)}...${payload.key.slice(-12)}`);
      await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke", id: key.id }),
      });
    });
  });

  describe("MCP API key authority (plan 60 K1)", () => {
    // K1: the api_keys table is the single live authority for MCP keys; the
    // MCP_API_KEYS value is a first-boot seed only. syncMcpApiKeys mirrors the
    // DB into the runtime config so live auth and a restart-boot agree, and a
    // later env edit can never resurrect or alter live keys.
    let dbApi, syncMcpApiKeys, tmpDir;

    beforeAll(async () => {
      dbApi = await import("../src/db.js");
      ({ syncMcpApiKeys } = await import("../src/mcp-server.js"));
    });

    afterAll(async () => {
      // Restore the shared bootstrap DB so later suites keep working.
      dbApi.initDb();
    });

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "k1-authority-"));
      dbApi.closeDb();
      dbApi.initDb(tmpDir);
    });

    afterEach(() => {
      dbApi.closeDb();
      delete process.env.MCP_API_KEYS;
    });

    it("imports the env seed once and mirrors those rows into the runtime config", async () => {
      process.env.MCP_API_KEYS = "seed-a, seed-b, seed-a";
      const manager = { config: {} };
      syncMcpApiKeys(manager);
      expect([...manager.config.mcpApiKeys].sort()).toEqual(["seed-a", "seed-b"]);
      expect(dbApi.listMcpApiKeys().map((key) => key.secret).sort()).toEqual(["seed-a", "seed-b"]);
    });

    it("a later env edit cannot change live keys — the DB wins after first boot", async () => {
      process.env.MCP_API_KEYS = "original-only";
      const manager = { config: {} };
      syncMcpApiKeys(manager);
      expect(manager.config.mcpApiKeys).toEqual(["original-only"]);

      const created = dbApi.createMcpApiKey({ name: "console key", secret: "nvg_console_added" });
      syncMcpApiKeys(manager);
      expect([...manager.config.mcpApiKeys].sort()).toEqual(["nvg_console_added", "original-only"]);

      process.env.MCP_API_KEYS = "later-env-edit";
      syncMcpApiKeys(manager);
      expect([...manager.config.mcpApiKeys].sort()).toEqual(["nvg_console_added", "original-only"]);
      expect(dbApi.listMcpApiKeys().some((key) => key.secret === "later-env-edit")).toBe(false);
      dbApi.revokeMcpApiKey(created.id);
    });

    it("revoke drops the key from the runtime mirror", async () => {
      process.env.MCP_API_KEYS = "revoke-me";
      const manager = { config: {} };
      syncMcpApiKeys(manager);
      const row = dbApi.createMcpApiKey({ name: "temp", secret: "nvg_tmp_key" });
      syncMcpApiKeys(manager);
      expect(manager.config.mcpApiKeys).toContain("nvg_tmp_key");
      dbApi.revokeMcpApiKey(row.id);
      syncMcpApiKeys(manager);
      expect(manager.config.mcpApiKeys).toEqual(["revoke-me"]);
    });
  });

  describe("MCP session permission re-resolution (plan 60 K2)", () => {
    // K2: persistent MCP sessions used to capture allowedTools at initialize
    // and hold it forever — set_tools/mcp_browsers updated the DB but not
    // live sessions. The session now binds a per-request resolver that reads
    // the current DB row, so every tools/list and tools/call sees fresh
    // permissions, and a revoked key denies everything (empty sets) instead
    // of silently widening to unrestricted.
    let dbApi, createSessionPermissionResolver, tmpDir;

    beforeAll(async () => {
      dbApi = await import("../src/db.js");
      ({ createSessionPermissionResolver } = await import("../src/mcp-server.js"));
    });

    afterAll(async () => {
      dbApi.initDb();
    });

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "k2-perm-"));
      dbApi.closeDb();
      dbApi.initDb(tmpDir);
    });

    it("re-resolves allowedTools live after set_tools (no captured snapshot)", async () => {
      const created = dbApi.createMcpApiKey({ name: "k2 key", secret: "nvg_k2key", allowedTools: ["web_search"] });
      const resolver = createSessionPermissionResolver(created.id);

      expect([...resolver().allowedTools]).toEqual(["web_search"]);
      expect(resolver().allowedMcpBrowsers).toBeNull();

      dbApi.setMcpApiKeyTools(created.id, ["web_search", "web_page_svg"]);
      expect([...resolver().allowedTools]).toEqual(["web_search", "web_page_svg"]);

      dbApi.setMcpApiKeyMcpBrowsers(created.id, ["chromium", "cloakbrowser"]);
      expect([...resolver().allowedMcpBrowsers].sort()).toEqual(["chromium", "cloakbrowser"]);

      dbApi.revokeMcpApiKey(created.id);
    });

    it("a revoked key denies everything instead of reverting to unrestricted", async () => {
      const created = dbApi.createMcpApiKey({ name: "k2 revoke", secret: "nvg_k2revoke", allowedTools: ["web_search"] });
      const resolver = createSessionPermissionResolver(created.id);
      expect([...resolver().allowedTools]).toEqual(["web_search"]);

      dbApi.revokeMcpApiKey(created.id);
      const denied = resolver();
      expect(denied.allowedTools).not.toBeNull();
      expect(denied.allowedTools.size).toBe(0);
      expect(denied.allowedMcpBrowsers.size).toBe(0);
    });

    it("a keyless/console session stays unrestricted", async () => {
      const resolver = createSessionPermissionResolver(null);
      expect(resolver().allowedTools).toBeNull();
      expect(resolver().allowedMcpBrowsers).toBeNull();
    });
  });

  describe("CDP pipe live re-authorization (plan 60 K3)", () => {
    // K3: the /cdp gate runs once at upgrade; a revoked key, a narrowed
    // allowed_browsers, or a removed browser must close established pipes, not
    // let them forward forever. recheckCdpPipes re-runs the gate's browser +
    // key + access checks against the live DB/config for every registered pipe.
    let dbApi, cdpShare, tmpDir, manager;

    beforeAll(async () => {
      dbApi = await import("../src/db.js");
      cdpShare = await import("../src/cdp-share.js");
    });

    afterAll(async () => {
      dbApi.initDb();
    });

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "k3-pipe-"));
      dbApi.closeDb();
      dbApi.initDb(tmpDir);
      manager = {
        config: {
          browsers: [{ name: "chromium", type: "inbuilt", role: ["default"], addOn: false }],
          mcpApiKeys: [],
        },
        _effectiveAddOns: () => [],
      };
    });

    function fakeWs(open = true) {
      const ws = {
        readyState: open ? 1 : 3,
        close: vi.fn(),
        once: vi.fn(),
      };
      return ws;
    }

    it("keeps a pipe whose key, browser, and access are all still valid", async () => {
      const key = "nvg_k3_alive";
      const created = dbApi.createMcpApiKey({ name: "k3 alive", secret: key, allowedBrowsers: ["chromium"] });
      manager.config.mcpApiKeys = [key];
      const ws = fakeWs();
      cdpShare.registerCdpPipe(ws, key, "chromium");

      expect(cdpShare.recheckCdpPipes(manager)).toBe(1);
      expect(ws.close).not.toHaveBeenCalled();
      dbApi.revokeMcpApiKey(created.id);
    });

    it("closes a pipe when the key is revoked", async () => {
      const key = "nvg_k3_revoked";
      const created = dbApi.createMcpApiKey({ name: "k3 revoked", secret: key, allowedBrowsers: ["chromium"] });
      manager.config.mcpApiKeys = [key];
      const ws = fakeWs();
      cdpShare.registerCdpPipe(ws, key, "chromium");

      dbApi.revokeMcpApiKey(created.id);
      manager.config.mcpApiKeys = []; // syncMcpApiKeys mirror drops the secret
      expect(cdpShare.recheckCdpPipes(manager)).toBe(0);
      expect(ws.close).toHaveBeenCalledWith(4003, expect.stringContaining("revoked"));
    });

    it("closes a pipe when allowed_browsers stops granting that browser", async () => {
      const key = "nvg_k3_narrowed";
      const created = dbApi.createMcpApiKey({ name: "k3 narrowed", secret: key, allowedBrowsers: ["chromium"] });
      manager.config.mcpApiKeys = [key];
      const ws = fakeWs();
      cdpShare.registerCdpPipe(ws, key, "chromium");

      dbApi.setMcpApiKeyBrowsers(created.id, []);
      expect(cdpShare.recheckCdpPipes(manager)).toBe(0);
      expect(ws.close).toHaveBeenCalledWith(4003, expect.stringContaining("revoked"));
    });

    it("closes a pipe when the browser no longer resolves", async () => {
      const key = "nvg_k3_gonebrowser";
      const created = dbApi.createMcpApiKey({ name: "k3 gone", secret: key, allowedBrowsers: ["chromium"] });
      manager.config.mcpApiKeys = [key];
      const ws = fakeWs();
      cdpShare.registerCdpPipe(ws, key, "chromium");

      manager.config.browsers = [];
      expect(cdpShare.recheckCdpPipes(manager)).toBe(0);
      expect(ws.close).toHaveBeenCalledWith(4003, expect.stringContaining("no longer exists"));
    });

    it("drops dead sockets from the registry without closing twice", async () => {
      const key = "nvg_k3_dead";
      dbApi.createMcpApiKey({ name: "k3 dead", secret: key, allowedBrowsers: ["chromium"] });
      manager.config.mcpApiKeys = [key];
      const ws = fakeWs(false); // readyState !== OPEN
      cdpShare.registerCdpPipe(ws, key, "chromium");

      expect(cdpShare.recheckCdpPipes(manager)).toBe(0);
      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  describe("CDP pipe teardown on BROWSERS removal (plan 60 K4/B9-deep)", () => {
    // K4: removing a browser through the config funnel must close the external
    // /cdp/<name> proxy pipe immediately — reconcileBrowserChanges runs
    // recheckCdpPipes after every BROWSERS mutation, so a pipe does not linger
    // until the 15s sweep. (Add-on state + devtools handles were covered by
    // B3/B8/B9; this is the raw upstream proxy registry half.)
    let dbApi, cdpShare, browserMod;

    beforeAll(async () => {
      dbApi = await import("../src/db.js");
      cdpShare = await import("../src/cdp-share.js");
      browserMod = await import("../src/browser.js");
    });

    afterAll(async () => {
      dbApi.initDb();
    });

    beforeEach(async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "k4-pipe-"));
      dbApi.closeDb();
      dbApi.initDb(tmpDir);
    });

    function fakeWs(open = true) {
      return { readyState: open ? 1 : 3, close: vi.fn(), once: vi.fn() };
    }

    it("closes an established /cdp pipe when its browser is removed via PUT /console/config", async () => {
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const originalBrowsers = manager.config.browsers;
      const removedName = "k4-removed-cdp";
      const key = "nvg_k4_gone";
      dbApi.createMcpApiKey({ name: "k4 gone", secret: key, allowedBrowsers: [removedName] });
      const removed = { name: removedName, role: ["default"], type: "cdp", cdpUrl: "http://removed:9222", addOn: true };
      manager.config.browsers = [...originalBrowsers, removed];
      manager.config.mcpApiKeys = [key];
      const ws = fakeWs();
      cdpShare.registerCdpPipe(ws, key, removedName);

      try {
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { BROWSERS: JSON.stringify(originalBrowsers) } }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        // reconcileBrowserChanges ran the pipe recheck: the removed browser no
        // longer resolves, so the external pipe is closed with a 4003 naming
        // the missing browser (not left to the 15s sweep).
        expect(ws.close).toHaveBeenCalledWith(4003, expect.stringContaining("no longer exists"));
      } finally {
        manager.config.browsers = originalBrowsers;
        delete manager.config.mcpApiKeys;
      }
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

    it("does not apply anything to runtime when the .env write fails (plan 60 S5)", async () => {
      const envFileMod = await import("../src/env-file.js");
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const before = manager.config.maxConcurrentPageOps;
      envFileMod.writeEnvFile.mockRejectedValueOnce(new Error("simulated disk failure"));
      try {
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { MAX_CONCURRENT_PAGE_OPS: 7 } }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toContain("failed to persist .env");
        expect(body.error).toContain("simulated disk failure");
        expect(body.envWritten).toBe(false);
        // runtime untouched — the hot applier never ran
        expect(manager.config.maxConcurrentPageOps).toBe(before);
        // canonical file untouched too
        expect(fs.readFileSync(envFile, "utf8")).not.toContain("MAX_CONCURRENT_PAGE_OPS=7");
      } finally {
        envFileMod.writeEnvFile.mockClear();
      }
    });

    it("persists hot keys that have no runtime applier as restart-required (plan 60 S5)", async () => {
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { MCP_PUBLIC_URL: "https://navigator.example.com" } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.restartRequired).toContain("MCP_PUBLIC_URL");
      expect(body.hotApplied).not.toContain("MCP_PUBLIC_URL");
      expect(body.envWritten).toBe(true);
      expect(fs.readFileSync(envFile, "utf8")).toContain("MCP_PUBLIC_URL=https://navigator.example.com");
      delete process.env.MCP_PUBLIC_URL;
    });

    it("applies a credential + engine-list batch order-independently (plan 60 S6)", async () => {
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const origList = manager.config.searchEnabledEngines;
      const origExa = manager.config.exaApiKey;
      const origEnvList = process.env.SEARCH_ENABLED_ENGINES;
      const origEnvExa = process.env.EXA_API_KEY;
      const seed = () => {
        manager.config.searchEnabledEngines = ["duckduckgo", "bing"];
        manager.config.exaApiKey = "";
        delete process.env.SEARCH_ENABLED_ENGINES;
        delete process.env.EXA_API_KEY;
      };
      const orders = [
        { SEARCH_ENABLED_ENGINES: "duckduckgo,bing", EXA_API_KEY: "fresh-exa" },
        { EXA_API_KEY: "fresh-exa", SEARCH_ENABLED_ENGINES: "duckduckgo,bing" },
      ];
      const seen = [];
      try {
        for (const updates of orders) {
          seed();
          const res = await fetch(`${MCP_BASE}/console/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ updates }),
          });
          const body = await res.json();
          expect(body.ok).toBe(true);
          expect(body.hotApplied).toEqual(expect.arrayContaining(["SEARCH_ENABLED_ENGINES", "EXA_API_KEY"]));
          seen.push([...manager.config.searchEnabledEngines]);
        }
        // explicit list wins — the credential key must not auto-add itself,
        // and both body orders must produce the restart result
        expect(seen[0]).toEqual(["duckduckgo", "bing"]);
        expect(seen[1]).toEqual(seen[seen.length - 1]);
      } finally {
        manager.config.searchEnabledEngines = origList;
        manager.config.exaApiKey = origExa;
        if (origEnvList === undefined) delete process.env.SEARCH_ENABLED_ENGINES;
        else process.env.SEARCH_ENABLED_ENGINES = origEnvList;
        if (origEnvExa === undefined) delete process.env.EXA_API_KEY;
        else process.env.EXA_API_KEY = origEnvExa;
      }
    });

    it("restores a credential engine listed in the explicit list when its key is re-added (plan 60 S6)", async () => {
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const origList = manager.config.searchEnabledEngines;
      const origExa = manager.config.exaApiKey;
      const origEnvList = process.env.SEARCH_ENABLED_ENGINES;
      const origEnvExa = process.env.EXA_API_KEY;
      try {
        // explicit list still contains exa_api; the key was absent so the
        // runtime list had it stripped — re-adding the key must bring it back
        // exactly as a restart from this .env would
        process.env.SEARCH_ENABLED_ENGINES = "duckduckgo,exa_api";
        manager.config.searchEnabledEngines = ["duckduckgo"];
        manager.config.exaApiKey = "";
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { EXA_API_KEY: "fresh-exa" } }),
        });
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.hotApplied).toContain("EXA_API_KEY");
        expect(manager.config.searchEnabledEngines).toEqual(["duckduckgo", "exa_api"]);
      } finally {
        manager.config.searchEnabledEngines = origList;
        manager.config.exaApiKey = origExa;
        if (origEnvList === undefined) delete process.env.SEARCH_ENABLED_ENGINES;
        else process.env.SEARCH_ENABLED_ENGINES = origEnvList;
        if (origEnvExa === undefined) delete process.env.EXA_API_KEY;
        else process.env.EXA_API_KEY = origEnvExa;
      }
    });

    it("an empty engine list means derived defaults, not disabled (plan 60 S7)", async () => {
      const { DEFAULT_SEARCH_ENABLED_ENGINES } = await import("../src/config.js");
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const origList = manager.config.searchEnabledEngines;
      const origExa = manager.config.exaApiKey;
      const origLinkup = manager.config.linkupApiKey;
      const origTavily = manager.config.tavilyApiKey;
      const origFirecrawl = manager.config.firecrawlApiKey;
      const origEnvList = process.env.SEARCH_ENABLED_ENGINES;
      try {
        // the uncheck-all path sends ""; the stored list must fall back to
        // defaults + key-gated engines — never null — and match what a
        // restart from the pre-synced env would derive
        process.env.SEARCH_ENABLED_ENGINES = "duckduckgo,bing";
        manager.config.searchEnabledEngines = ["duckduckgo", "bing"];
        manager.config.exaApiKey = "seed-exa";
        manager.config.linkupApiKey = "";
        manager.config.tavilyApiKey = "";
        manager.config.firecrawlApiKey = "";
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { SEARCH_ENABLED_ENGINES: "" } }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.hotApplied).toContain("SEARCH_ENABLED_ENGINES");
        expect(manager.config.searchEnabledEngines).toEqual([...DEFAULT_SEARCH_ENABLED_ENGINES, "exa_api"]);
        expect(process.env.SEARCH_ENABLED_ENGINES).toBe("");
      } finally {
        manager.config.searchEnabledEngines = origList;
        manager.config.exaApiKey = origExa;
        manager.config.linkupApiKey = origLinkup;
        manager.config.tavilyApiKey = origTavily;
        manager.config.firecrawlApiKey = origFirecrawl;
        if (origEnvList === undefined) delete process.env.SEARCH_ENABLED_ENGINES;
        else process.env.SEARCH_ENABLED_ENGINES = origEnvList;
      }
    });

    it("reset reverts the engine list to derived defaults, not a static list (plan 60 S7)", async () => {
      const { DEFAULT_SEARCH_ENABLED_ENGINES } = await import("../src/config.js");
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const origList = manager.config.searchEnabledEngines;
      const origExa = manager.config.exaApiKey;
      const origLinkup = manager.config.linkupApiKey;
      const origTavily = manager.config.tavilyApiKey;
      const origFirecrawl = manager.config.firecrawlApiKey;
      const origEnvList = process.env.SEARCH_ENABLED_ENGINES;
      try {
        // "reset" means unset: the runtime list must equal what startup
        // computes for a .env without the line — defaults + present keys —
        // instead of the static schema fallback (which drops the key engines)
        fs.writeFileSync(envFile, "# test env\nMAX_CONCURRENT_PAGE_OPS=30\nHEADLESS=true\nSEARCH_ENABLED_ENGINES=duckduckgo,bing\n");
        manager.config.searchEnabledEngines = ["duckduckgo", "bing"];
        manager.config.exaApiKey = "seed-exa";
        manager.config.linkupApiKey = "";
        manager.config.tavilyApiKey = "";
        manager.config.firecrawlApiKey = "";
        process.env.SEARCH_ENABLED_ENGINES = "duckduckgo,bing";
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reset: ["SEARCH_ENABLED_ENGINES"] }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.hotApplied).toContain("SEARCH_ENABLED_ENGINES→default");
        expect(manager.config.searchEnabledEngines).toEqual([...DEFAULT_SEARCH_ENABLED_ENGINES, "exa_api"]);
        expect(process.env.SEARCH_ENABLED_ENGINES).toBeUndefined();
      } finally {
        manager.config.searchEnabledEngines = origList;
        manager.config.exaApiKey = origExa;
        manager.config.linkupApiKey = origLinkup;
        manager.config.tavilyApiKey = origTavily;
        manager.config.firecrawlApiKey = origFirecrawl;
        if (origEnvList === undefined) delete process.env.SEARCH_ENABLED_ENGINES;
        else process.env.SEARCH_ENABLED_ENGINES = origEnvList;
      }
    });

    it("purges runtime state for engines crossing the enabled boundary (plan 60 S8)", async () => {
      const browserMod = await import("../src/browser.js");
      const searchMod = await import("../src/search.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const origList = manager.config.searchEnabledEngines;
      const origEnvList = process.env.SEARCH_ENABLED_ENGINES;
      try {
        searchMod.purgeEngineRuntimeState.mockClear();
        // mojeek was enabled, google was not: one save flips both — both must
        // cross the boundary and be purged (profiles/circuits/telemetry + the
        // web_search cache that may hold select_best results including them)
        manager.config.searchEnabledEngines = ["duckduckgo", "bing", "mojeek"];
        process.env.SEARCH_ENABLED_ENGINES = "duckduckgo,bing,mojeek";
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { SEARCH_ENABLED_ENGINES: "duckduckgo,bing,google" } }),
        });
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(manager.config.searchEnabledEngines).toEqual(["duckduckgo", "bing", "google"]);
        expect(searchMod.purgeEngineRuntimeState).toHaveBeenCalledTimes(1);
        const purged = [...searchMod.purgeEngineRuntimeState.mock.calls.at(-1)[0]].sort();
        expect(purged).toEqual(["google", "mojeek"]);

        // a save that does not move anyone across the boundary must not purge
        searchMod.purgeEngineRuntimeState.mockClear();
        const res2 = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { SEARCH_ENABLED_ENGINES: "duckduckgo,bing,google" } }),
        });
        expect((await res2.json()).ok).toBe(true);
        expect(searchMod.purgeEngineRuntimeState).not.toHaveBeenCalled();
      } finally {
        manager.config.searchEnabledEngines = origList;
        if (origEnvList === undefined) delete process.env.SEARCH_ENABLED_ENGINES;
        else process.env.SEARCH_ENABLED_ENGINES = origEnvList;
      }
    });

    it("applies warmup-list changes to the window pools (plan 60 S9)", async () => {
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const origWarmup = manager.config.searchRouteWarmupEngines;
      const origEnvWarmup = process.env.SEARCH_ROUTE_WARMUP_ENGINES;
      try {
        manager.applyWarmupListChange.mockClear();
        manager.config.searchRouteWarmupEngines = ["brave", "duckduckgo"];
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { SEARCH_ROUTE_WARMUP_ENGINES: "brave,google" } }),
        });
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.hotApplied).toContain("SEARCH_ROUTE_WARMUP_ENGINES");
        expect(manager.config.searchRouteWarmupEngines).toEqual(["brave", "google"]);
        expect(manager.applyWarmupListChange).toHaveBeenCalledTimes(1);
        expect(manager.applyWarmupListChange).toHaveBeenCalledWith({ added: ["google"], removed: ["duckduckgo"] });

        // an unchanged list must not touch the pools
        manager.applyWarmupListChange.mockClear();
        const res2 = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { SEARCH_ROUTE_WARMUP_ENGINES: "brave,google" } }),
        });
        expect((await res2.json()).ok).toBe(true);
        expect(manager.applyWarmupListChange).not.toHaveBeenCalled();
      } finally {
        manager.config.searchRouteWarmupEngines = origWarmup;
        if (origEnvWarmup === undefined) delete process.env.SEARCH_ROUTE_WARMUP_ENGINES;
        else process.env.SEARCH_ROUTE_WARMUP_ENGINES = origEnvWarmup;
      }
    });

    it("reconfigures the engine scheduler on queue-config saves (plan 60 S11)", async () => {
      const searchMod = await import("../src/search.js");
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const origInterval = manager.config.searchQueueMinIntervalMs;
      const origEnvInterval = process.env.SEARCH_QUEUE_MIN_INTERVAL_MS;
      try {
        // boot applied the queue config already — restart-equal with hot saves
        expect(searchMod.reconfigureEngineScheduler).toHaveBeenCalledWith(manager.config);
        searchMod.reconfigureEngineScheduler.mockClear();

        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { SEARCH_QUEUE_MIN_INTERVAL_MS: 45000 } }),
        });
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.hotApplied).toContain("SEARCH_QUEUE_MIN_INTERVAL_MS");
        expect(manager.config.searchQueueMinIntervalMs).toBe(45000);
        expect(searchMod.reconfigureEngineScheduler).toHaveBeenCalledTimes(1);
        expect(searchMod.reconfigureEngineScheduler).toHaveBeenCalledWith(manager.config);

        // a reset funnels through the same listener with the schema fallback
        searchMod.reconfigureEngineScheduler.mockClear();
        const resReset = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reset: ["SEARCH_QUEUE_MIN_INTERVAL_MS"] }),
        });
        expect((await resReset.json()).ok).toBe(true);
        expect(manager.config.searchQueueMinIntervalMs).toBe(30000);
        expect(searchMod.reconfigureEngineScheduler).toHaveBeenCalledTimes(1);

        // non-queue hot keys leave the scheduler alone
        searchMod.reconfigureEngineScheduler.mockClear();
        const resOther = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { ENABLE_SCREENSHOT_DOWNLOAD_LINK: true } }),
        });
        expect((await resOther.json()).hotApplied).toContain("ENABLE_SCREENSHOT_DOWNLOAD_LINK");
        expect(searchMod.reconfigureEngineScheduler).not.toHaveBeenCalled();
      } finally {
        manager.config.searchQueueMinIntervalMs = origInterval;
        if (origEnvInterval === undefined) delete process.env.SEARCH_QUEUE_MIN_INTERVAL_MS;
        else process.env.SEARCH_QUEUE_MIN_INTERVAL_MS = origEnvInterval;
      }
    });

    it("rejects malformed and duplicate POST_PROCESSOR_MODELS saves without touching .env (plan 60 S12)", async () => {
      const before = fs.readFileSync(envFile, "utf8");

      const badJson = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { POST_PROCESSOR_MODELS: "{not json" } }),
      });
      expect(badJson.status).toBe(400);
      const badBody = await badJson.json();
      expect(badBody.ok).toBe(false);
      expect(badBody.invalid?.[0]?.key).toBe("POST_PROCESSOR_MODELS");
      expect(badBody.invalid[0].error).toContain("not valid JSON");

      const nonArray = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { POST_PROCESSOR_MODELS: '{"id":"a"}' } }),
      });
      expect((await nonArray.json()).invalid?.[0]?.error).toContain("must be a JSON array");

      const duplicates = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { POST_PROCESSOR_MODELS: JSON.stringify([
          { id: "reader_lm", model: "m", baseUrl: "http://a" },
          { id: "reader_lm", model: "n", baseUrl: "http://b" }
        ]) } }),
      });
      expect((await duplicates.json()).invalid?.[0]?.error).toContain("duplicate model id(s): reader_lm");

      const allUsable = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { POST_PROCESSOR_MODELS: JSON.stringify([{ id: "x" }]) } }),
      });
      expect((await allUsable.json()).invalid?.[0]?.error).toContain("no usable entries");

      // rejected before any persistence: .env untouched, no backup created
      expect(fs.readFileSync(envFile, "utf8")).toBe(before);
      expect(fs.readdirSync(envDir).some((f) => f.includes(".env.backup-"))).toBe(false);
    });

    it("warns when an update drops a post-processor model still referenced by saved hints (plan 60 S3)", async () => {
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const hintsPath = path.join(envDir, "domain-hints.json");
      fs.writeFileSync(hintsPath, JSON.stringify([{
        domain: "example.com",
        pathPattern: "/**",
        default: { format: "text", postProcessor: "reader_lm" },
      }]));
      const originalHintsPath = manager.config.domainHintsPath;
      const originalModels = manager.config.postProcessorModels;
      const originalEnvModels = process.env.POST_PROCESSOR_MODELS;
      manager.config.domainHintsPath = hintsPath;
      manager.config.postProcessorModels = [
        { id: "reader_lm", label: "Reader LM", model: "reader-lm:0.5b", baseUrl: "http://localhost:9999" },
      ];
      process.env.POST_PROCESSOR_MODELS = JSON.stringify(manager.config.postProcessorModels);

      try {
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { POST_PROCESSOR_MODELS: "[]" } }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.hotApplied).toContain("POST_PROCESSOR_MODELS");
        expect(body.warnings).toEqual(expect.arrayContaining([
          expect.stringContaining('references post-processor model "reader_lm"'),
        ]));

        // the saved hint itself survives the model removal
        const reloaded = JSON.parse(fs.readFileSync(hintsPath, "utf8"));
        expect(reloaded[0].default.postProcessor).toBe("reader_lm");
      } finally {
        manager.config.domainHintsPath = originalHintsPath;
        manager.config.postProcessorModels = originalModels;
        if (originalEnvModels === undefined) delete process.env.POST_PROCESSOR_MODELS;
        else process.env.POST_PROCESSOR_MODELS = originalEnvModels;
      }
    });

    it("emits no warnings when a config save leaves referenced models configured (plan 60 S3)", async () => {
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const originalModels = manager.config.postProcessorModels;
      manager.config.postProcessorModels = [
        { id: "reader_lm", label: "Reader LM", model: "reader-lm:0.5b", baseUrl: "http://localhost:9999" },
      ];

      try {
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { MAX_CONCURRENT_PAGE_OPS: 31 } }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.warnings).toEqual([]);
      } finally {
        manager.config.postProcessorModels = originalModels;
      }
    });

    it("forgets a removed configured relay browser so it does not return as a dynamic driver", async () => {
      const { relayServer } = await import("../src/relay-server.js");
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const originalBrowsers = manager.config.browsers;
      const forget = vi.spyOn(relayServer, "forget").mockReturnValue(true);
      manager.config.browsers = [
        ...originalBrowsers,
        { name: "removed-relay", role: ["devtools"], type: "navigator-cdp", plugin: "chrome", addOn: true },
      ];

      try {
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { BROWSERS: JSON.stringify([{ name: "chromium", role: ["default"] }, { name: "cloakbrowser", role: ["default"], cdpUrl: "http://cloak:9222" }]) } }),
        });
        const body = await res.json();

        expect(body.ok).toBe(true);
        expect(body.forgottenRelayBrowsers).toEqual(["removed-relay"]);
        expect(forget).toHaveBeenCalledWith("removed-relay");
      } finally {
        manager.config.browsers = originalBrowsers;
        forget.mockRestore();
      }
    });

    it("forgets configured relay browsers when BROWSERS is reset to its default", async () => {
      const { relayServer } = await import("../src/relay-server.js");
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const originalBrowsers = manager.config.browsers;
      const originalEnvBrowsers = process.env.BROWSERS;
      const forget = vi.spyOn(relayServer, "forget").mockReturnValue(true);
      const configured = [
        ...originalBrowsers,
        { name: "reset-relay", role: ["devtools"], type: "navigator-cdp", plugin: "chrome", addOn: true },
      ];
      manager.config.browsers = configured;
      fs.writeFileSync(envFile, `BROWSERS=${JSON.stringify(configured)}\n`);

      try {
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reset: ["BROWSERS"] }),
        });
        const body = await res.json();

        expect(body.ok).toBe(true);
        expect(body.forgottenRelayBrowsers).toEqual(["reset-relay"]);
        expect(forget).toHaveBeenCalledWith("reset-relay");
      } finally {
        manager.config.browsers = originalBrowsers;
        if (originalEnvBrowsers === undefined) delete process.env.BROWSERS;
        else process.env.BROWSERS = originalEnvBrowsers;
        forget.mockRestore();
      }
    });

    it("reconciles relay browsers when reverting a BROWSERS change", async () => {
      const { relayServer } = await import("../src/relay-server.js");
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const originalBrowsers = manager.config.browsers;
      const originalEnvBrowsers = process.env.BROWSERS;
      const forget = vi.spyOn(relayServer, "forget").mockReturnValue(true);
      const retained = originalBrowsers.filter((browser) => browser.name !== "cloakbrowser");
      const relay = { name: "reverted-relay", role: ["devtools"], type: "navigator-cdp", plugin: "chrome", addOn: true };
      const configured = [...retained, relay];
      fs.writeFileSync(envFile, `BROWSERS=${JSON.stringify(retained)}\n`);
      manager.config.browsers = configured;

      try {
        const update = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { BROWSERS: JSON.stringify(configured) } }),
        });
        expect((await update.json()).ok).toBe(true);

        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revert: true }),
        });
        const body = await res.json();

        expect(body.ok).toBe(true);
        expect(body.hotApplied).toContain("BROWSERS→reverted");
        expect(body.forgottenRelayBrowsers).toEqual(["reverted-relay"]);
        expect(forget).toHaveBeenCalledWith("reverted-relay");
      } finally {
        manager.config.browsers = originalBrowsers;
        if (originalEnvBrowsers === undefined) delete process.env.BROWSERS;
        else process.env.BROWSERS = originalEnvBrowsers;
        forget.mockRestore();
      }
    });

    it("exposes /console/relay/remove — full removal, distinct from forget", async () => {
      const { relayServer } = await import("../src/relay-server.js");
      const remove = vi.spyOn(relayServer, "remove").mockReturnValue(true);
      try {
        const res = await fetch(`${MCP_BASE}/console/relay/remove`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "ghost-browser" }),
        });
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.name).toBe("ghost-browser");
        expect(body.removed).toBe(true);
        expect(remove).toHaveBeenCalledWith("ghost-browser");
      } finally {
        remove.mockRestore();
      }
    });

    it("reconciles relay browsers after an external BROWSERS file edit", async () => {
      const { relayServer } = await import("../src/relay-server.js");
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const originalBrowsers = manager.config.browsers;
      const originalEnvBrowsers = process.env.BROWSERS;
      const forget = vi.spyOn(relayServer, "forget").mockReturnValue(true);
      const relay = { name: "external-relay", role: ["devtools"], type: "navigator-cdp", plugin: "chrome", addOn: true };
      const configured = [...originalBrowsers, relay];
      const retained = originalBrowsers;
      manager.config.browsers = configured;
      fs.writeFileSync(envFile, `BROWSERS=${JSON.stringify(configured)}\n`);

      try {
        // Establish the file timestamp baseline before the external edit.
        await fetch(`${MCP_BASE}/console/config`);
        fs.writeFileSync(envFile, `BROWSERS=${JSON.stringify(retained)}\n`);

        const res = await fetch(`${MCP_BASE}/console/config`);
        const body = await res.json();

        expect(body.config.browsers.map((browser) => browser.name)).not.toContain("external-relay");
        expect(body.envFile.externalBrowsersApplied).toEqual(["external-relay"]);
        expect(forget).toHaveBeenCalledWith("external-relay");
      } finally {
        manager.config.browsers = originalBrowsers;
        if (originalEnvBrowsers === undefined) delete process.env.BROWSERS;
        else process.env.BROWSERS = originalEnvBrowsers;
        forget.mockRestore();
      }
    });

    it("surfaces an external POST_PROCESSOR_MODELS removal as externalModelWarnings (plan 60 S3)", async () => {
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const hintsPath = path.join(envDir, "domain-hints.json");
      fs.writeFileSync(hintsPath, JSON.stringify([{
        domain: "example.com",
        pathPattern: "/**",
        default: { format: "text", postProcessor: "reader_lm" },
      }]));
      const models = [{ id: "reader_lm", label: "Reader LM", model: "reader-lm:0.5b", baseUrl: "http://localhost:9999" }];
      const originalHintsPath = manager.config.domainHintsPath;
      const originalModels = manager.config.postProcessorModels;
      const originalEnvModels = process.env.POST_PROCESSOR_MODELS;
      manager.config.domainHintsPath = hintsPath;
      manager.config.postProcessorModels = models;
      process.env.POST_PROCESSOR_MODELS = JSON.stringify(models);
      fs.writeFileSync(envFile, `POST_PROCESSOR_MODELS=${JSON.stringify(models)}\n`);

      try {
        // Establish the file timestamp baseline before the external edit.
        await fetch(`${MCP_BASE}/console/config`);
        fs.writeFileSync(envFile, `POST_PROCESSOR_MODELS=[]\n`);

        const res = await fetch(`${MCP_BASE}/console/config`);
        const body = await res.json();

        expect(body.envFile.externalModelWarnings).toEqual(expect.arrayContaining([
          expect.stringContaining('references post-processor model "reader_lm"'),
        ]));
        // the hint itself is never touched by reconcile
        const reloaded = JSON.parse(fs.readFileSync(hintsPath, "utf8"));
        expect(reloaded[0].default.postProcessor).toBe("reader_lm");
      } finally {
        manager.config.domainHintsPath = originalHintsPath;
        manager.config.postProcessorModels = originalModels;
        if (originalEnvModels === undefined) delete process.env.POST_PROCESSOR_MODELS;
        else process.env.POST_PROCESSOR_MODELS = originalEnvModels;
      }
    });

    it("invalidates the stale add-on connection when a browser changes type in place (plan 60 B3)", async () => {
      const { relayServer } = await import("../src/relay-server.js");
      const browserMod = await import("../src/browser.js");
      const devtoolsMod = await import("../src/devtools.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const originalBrowsers = manager.config.browsers;
      const forget = vi.spyOn(relayServer, "forget").mockReturnValue(true);
      manager.invalidateAddOn.mockImplementation((name) => [`${name}: disconnected add-on handle`]);
      devtoolsMod.releaseTargetsByBackend.mockImplementation((name) => [`${name}: released adopted handle`]);
      const sameName = { name: "cloakbrowser", role: ["default"], type: "cdp", cdpUrl: "http://cloak:9222", addOn: true };
      const changedIdentity = { name: "cloakbrowser", role: ["default"], type: "navigator-cdp", plugin: "chrome", addOn: true };
      manager.config.browsers = [originalBrowsers[0], sameName];

      try {
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { BROWSERS: JSON.stringify([originalBrowsers[0], changedIdentity]) } }),
        });
        const body = await res.json();

        expect(body.ok).toBe(true);
        expect(body.invalidatedBrowsers).toContain("cloakbrowser: disconnected add-on handle");
        expect(body.invalidatedBrowsers).toContain("cloakbrowser: released adopted handle");
        expect(manager.invalidateAddOn).toHaveBeenCalledWith("cloakbrowser");
        expect(devtoolsMod.releaseTargetsByBackend).toHaveBeenCalledWith("cloakbrowser");
        // A type change is NOT a removal — the relay pairing must survive.
        expect(forget).not.toHaveBeenCalled();
      } finally {
        manager.invalidateAddOn.mockReset();
        devtoolsMod.releaseTargetsByBackend.mockReset();
        manager.config.browsers = originalBrowsers;
        forget.mockRestore();
      }
    });

    it("invalidates add-on state + devtools targets when a plain-cdp browser is removed (plan 60 B8/B9)", async () => {
      const { relayServer } = await import("../src/relay-server.js");
      const browserMod = await import("../src/browser.js");
      const devtoolsMod = await import("../src/devtools.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const originalBrowsers = manager.config.browsers;
      const forget = vi.spyOn(relayServer, "forget").mockReturnValue(true);
      manager.invalidateAddOn.mockImplementation((name) => [`${name}: disconnected add-on handle`]);
      devtoolsMod.releaseTargetsByBackend.mockImplementation((name) => [`${name}: closed navigator target`]);
      const removedCdp = { name: "removed-cdp-addon", role: ["default"], type: "cdp", cdpUrl: "http://example:9222", addOn: true };
      manager.config.browsers = [...originalBrowsers, removedCdp];

      try {
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { BROWSERS: JSON.stringify(originalBrowsers) } }),
        });
        const body = await res.json();

        expect(body.ok).toBe(true);
        expect(body.invalidatedBrowsers).toContain("removed-cdp-addon: disconnected add-on handle");
        expect(body.invalidatedBrowsers).toContain("removed-cdp-addon: closed navigator target");
        expect(manager.invalidateAddOn).toHaveBeenCalledWith("removed-cdp-addon");
        expect(devtoolsMod.releaseTargetsByBackend).toHaveBeenCalledWith("removed-cdp-addon");
        // Plain cdp removal is not a relay pairing — nothing to forget.
        expect(forget).not.toHaveBeenCalled();
      } finally {
        manager.invalidateAddOn.mockReset();
        devtoolsMod.releaseTargetsByBackend.mockReset();
        manager.config.browsers = originalBrowsers;
        forget.mockRestore();
      }
    });

    it("treats a rename as delete+create with full old-name cleanup (plan 60 B5)", async () => {
      const { relayServer } = await import("../src/relay-server.js");
      const browserMod = await import("../src/browser.js");
      const devtoolsMod = await import("../src/devtools.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const originalBrowsers = manager.config.browsers;
      const forget = vi.spyOn(relayServer, "forget").mockReturnValue(true);
      const remove = vi.spyOn(relayServer, "remove");
      manager.invalidateAddOn.mockImplementation((name) => [`${name}: disconnected add-on handle`]);
      devtoolsMod.releaseTargetsByBackend.mockImplementation((name) => [`${name}: released adopted handle`]);
      const oldRelay = { name: "old-relay-b5", role: ["devtools"], type: "navigator-cdp", plugin: "chrome", addOn: true };
      const newRelay = { name: "new-relay-b5", role: ["devtools"], type: "navigator-cdp", plugin: "chrome", addOn: true };
      manager.config.browsers = [...originalBrowsers, oldRelay];
      fs.writeFileSync(envFile, `BROWSERS=${JSON.stringify([...originalBrowsers, oldRelay])}\n`);

      try {
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { BROWSERS: JSON.stringify([...originalBrowsers, newRelay]) } }),
        });
        const body = await res.json();

        expect(body.ok).toBe(true);
        // Rename = full removal of the old name (session + known row + meta via
        // remove()), not pairing-only forget — the old name must not linger as
        // recoverable unmanaged state once its successor is configured.
        expect(remove).toHaveBeenCalledWith("old-relay-b5");
        expect(forget).toHaveBeenCalledWith("old-relay-b5");
        expect(body.forgottenRelayBrowsers).toEqual(["old-relay-b5"]);
        expect(manager.invalidateAddOn).toHaveBeenCalledWith("old-relay-b5");
        expect(devtoolsMod.releaseTargetsByBackend).toHaveBeenCalledWith("old-relay-b5");
        // Canonical state: .env and the config payload carry only the new name.
        const after = fs.readFileSync(envFile, "utf8");
        expect(after).toContain("new-relay-b5");
        expect(after).not.toContain("old-relay-b5");
        const cfg = await (await fetch(`${MCP_BASE}/console/config`)).json();
        const names = cfg.config.browsers.map((browser) => browser.name);
        expect(names).toContain("new-relay-b5");
        expect(names).not.toContain("old-relay-b5");
        // Read-path: the old name does not survive as a dynamic status row.
        const statusNames = relayServer.getStatusEntries(cfg.config.browsers).map((entry) => entry.name);
        expect(statusNames).not.toContain("old-relay-b5");
        expect(statusNames).toContain("new-relay-b5");
      } finally {
        manager.invalidateAddOn.mockReset();
        devtoolsMod.releaseTargetsByBackend.mockReset();
        manager.config.browsers = originalBrowsers;
        forget.mockRestore();
        remove.mockRestore();
      }
    });

    it("keeps the relay hello-admission set in sync with BROWSERS changes (plan 60 B6)", async () => {
      const { relayServer } = await import("../src/relay-server.js");
      const browserMod = await import("../src/browser.js");
      const manager = await browserMod.getBrowserManager.mock.results[0].value;
      const originalBrowsers = manager.config.browsers;
      const upd = vi.spyOn(relayServer, "updateConfiguredBrowsers");
      const newRelay = { name: "new-relay-b6", role: ["devtools"], type: "navigator-cdp", plugin: "chrome", addOn: true };
      try {
        const res = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { BROWSERS: JSON.stringify([...originalBrowsers, newRelay]) } }),
        });
        expect((await res.json()).ok).toBe(true);
        // The admission gate follows the applied config, not the saved one.
        expect(upd).toHaveBeenCalledWith(
          expect.arrayContaining([expect.objectContaining({ name: "new-relay-b6" })])
        );
      } finally {
        upd.mockRestore();
        manager.config.browsers = originalBrowsers;
      }
    });

    it("hot-applies recreate-apply keys — no restart required", async () => {
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { CHROME_PATH: "/usr/bin/chromium" } }),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.hotApplied).toContain("CHROME_PATH");
      expect(body.restartRequired).not.toContain("CHROME_PATH");
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

  describe("PUT /console/config — browser-process hot-apply (plan 60 H4)", () => {
    let envDir;
    let envFile;
    let manager;
    let vncMod;
    let origHeadless;
    let origVncPort;
    let origNovncPort;
    let origDisplay;

    beforeEach(async () => {
      envDir = fs.mkdtempSync(path.join(os.tmpdir(), "navigator-console-h4-"));
      envFile = path.join(envDir, ".env");
      fs.writeFileSync(envFile, "# test env\nHEADLESS=true\n");
      process.env.NAVIGATOR_ENV_FILE = envFile;
      const browserMod = await import("../src/browser.js");
      manager = await browserMod.getBrowserManager.mock.results[0].value;
      vncMod = await import("../src/vnc-manager.js");
      origHeadless = manager.config.headless;
      origVncPort = vncMod.vncManager.vncPort;
      origNovncPort = vncMod.vncManager.novncPort;
      origDisplay = process.env.DISPLAY;
      manager.config.headless = true;
      manager.relaunchDefaultBackend.mockClear();
      vncMod.vncManager.status = "stopped";
    });

    afterEach(() => {
      delete process.env.NAVIGATOR_ENV_FILE;
      manager.config.headless = origHeadless;
      delete vncMod.vncManager.vncPort;
      if (origVncPort !== undefined) vncMod.vncManager.vncPort = origVncPort;
      delete vncMod.vncManager.novncPort;
      if (origNovncPort !== undefined) vncMod.vncManager.novncPort = origNovncPort;
      if (origDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = origDisplay;
      try { fs.rmSync(envDir, { recursive: true, force: true }); } catch {}
    });

    it("relaunches the built-in Chromium when a browser-process key is hot-applied", async () => {
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { CHROME_PATH: "/usr/bin/chromium-custom" } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.hotApplied).toContain("CHROME_PATH");
      expect(manager.relaunchDefaultBackend).toHaveBeenCalledWith(true);
      expect(body.relaunched).toEqual(expect.objectContaining({ relaunched: true }));
      expect(body.relaunchSkipped).toBeNull();
    });

    it("relaunches headed for a HEADLESS=false hot-apply and reports it", async () => {
      process.env.DISPLAY = ":99";
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { HEADLESS: false } }),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.hotApplied).toContain("HEADLESS");
      expect(body.relaunched.headless).toBe(false);
      expect(manager.relaunchDefaultBackend).toHaveBeenCalledWith(false);
      expect(manager.config.headless).toBe(false);
    });

    it("does not relaunch for non-browser hot keys", async () => {
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { SEARCH_QUEUE_ESCALATION_FACTOR: 4 } }),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.hotApplied).toContain("SEARCH_QUEUE_ESCALATION_FACTOR");
      expect(manager.relaunchDefaultBackend).not.toHaveBeenCalled();
      expect(body.relaunched).toBeNull();
      expect(body.relaunchSkipped).toBeNull();
    });

    it("skips the relaunch headed without a display, reporting why (plan 60 H4)", async () => {
      delete process.env.DISPLAY;
      vncMod.vncManager.status = "stopped";
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { HEADLESS: false } }),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.hotApplied).toContain("HEADLESS");
      expect(body.relaunched).toBeNull();
      expect(body.relaunchSkipped).toMatchObject({ keys: ["HEADLESS"] });
      expect(body.relaunchSkipped.error).toContain("console VNC toggle");
      expect(manager.relaunchDefaultBackend).not.toHaveBeenCalled();
    });

    it("syncs the VncManager ports from config after a VNC_PORT hot-apply", async () => {
      const res = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { VNC_PORT: 2995, NOVNC_PORT: 2996 } }),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.hotApplied).toEqual(expect.arrayContaining(["VNC_PORT", "NOVNC_PORT"]));
      expect(vncMod.vncManager.vncPort).toBe(2995);
      expect(vncMod.vncManager.novncPort).toBe(2996);
    });
  });

  describe("GET /console/config — external .env key removal (plan 60 H5)", () => {
    let envDir;
    let envFile;
    let manager;
    let vncMod;
    let origDisplay;
    let origEnv;

    beforeEach(async () => {
      envDir = fs.mkdtempSync(path.join(os.tmpdir(), "navigator-console-h5-"));
      envFile = path.join(envDir, ".env");
      process.env.NAVIGATOR_ENV_FILE = envFile;
      const browserMod = await import("../src/browser.js");
      manager = await browserMod.getBrowserManager.mock.results[0].value;
      vncMod = await import("../src/vnc-manager.js");
      origDisplay = process.env.DISPLAY;
      delete process.env.DISPLAY;
      origEnv = {
        CHROME_USER_DATA_DIR: process.env.CHROME_USER_DATA_DIR,
        HEADLESS: process.env.HEADLESS,
        SEARCH_QUEUE_ESCALATION_FACTOR: process.env.SEARCH_QUEUE_ESCALATION_FACTOR,
        SOME_RANDOM: process.env.SOME_RANDOM,
      };
      manager.relaunchDefaultBackend.mockClear();
      vncMod.vncManager.status = "stopped";
    });

    afterEach(() => {
      delete process.env.NAVIGATOR_ENV_FILE;
      for (const [k, v] of Object.entries(origEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (origDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = origDisplay;
      try { fs.rmSync(envDir, { recursive: true, force: true }); } catch {}
    });

    // External .env edits are picked up by GET /console/config when the file's
    // mtime/size changed since the last baseline. The removal is only detected
    // against the PREVIOUSLY observed key set, so each test primes the baseline
    // with a key-present version, re-observes a changed key-present version
    // (same keys, different value length so the stat always differs), then
    // removes the key from a third version.
    async function primeAndRemove(keysPresent, value, removedKey) {
      fs.writeFileSync(envFile, keysPresent(value));
      await fetch(`${MCP_BASE}/console/config`); // baseline stat
      fs.writeFileSync(envFile, keysPresent(value + "-" + value)); // changed, key still present → reconcile observes the key set
      await fetch(`${MCP_BASE}/console/config`);
      manager.relaunchDefaultBackend.mockClear();
      fs.writeFileSync(envFile, keysPresent(value).replace(new RegExp(`^${removedKey}=.*$`, "m"), "")); // key removed
      const res = await fetch(`${MCP_BASE}/console/config`);
      return { res, body: await res.json() };
    }

    it("clears a hot key removed from an externally-edited .env and resets live config", async () => {
      const { body } = await primeAndRemove(
        (v) => `# h5\nHEADLESS=true\nCHROME_USER_DATA_DIR=/tmp/h5dir-${v}\n`,
        "aaaa",
        "CHROME_USER_DATA_DIR"
      );
      expect(body.envFile.changedOnDisk).toBe(false);
      expect(process.env.CHROME_USER_DATA_DIR).toBeUndefined();
      expect(manager.config.chromeUserDataDir).toBe("/data/chrome");
      // the still-present key is untouched
      expect(process.env.HEADLESS).toBe("true");
      expect(manager.config.headless).toBe(true);
      // removing a browser-process key relaunches so the live process honors
      // the fallback profile dir, exactly like a value change does (plan 60 H4)
      expect(manager.relaunchDefaultBackend).toHaveBeenCalledWith(true);
    });

    it("resets a hot non-browser key to its fallback when removed", async () => {
      const { body } = await primeAndRemove(
        (v) => `# h5\nHEADLESS=true\nSEARCH_QUEUE_ESCALATION_FACTOR=3\n`,
        "zzzz",
        "SEARCH_QUEUE_ESCALATION_FACTOR"
      );
      expect(body.envFile.changedOnDisk).toBe(false);
      expect(process.env.SEARCH_QUEUE_ESCALATION_FACTOR).toBeUndefined();
      expect(manager.config.searchQueueEscalationFactor).toBe(2);
      expect(process.env.HEADLESS).toBe("true");
      expect(manager.relaunchDefaultBackend).not.toHaveBeenCalled();
    });

    it("relaunches the built-in Chromium when a browser-process key is removed externally", async () => {
      const { body } = await primeAndRemove(
        (v) => `# h5\nHEADLESS=true\nCHROME_USER_DATA_DIR=/tmp/h5dir-${v}\n`,
        "bbbb",
        "HEADLESS"
      );
      expect(body.envFile.changedOnDisk).toBe(false);
      expect(process.env.HEADLESS).toBeUndefined();
      expect(manager.config.headless).toBe(true); // fallback true, still headless
      expect(process.env.CHROME_USER_DATA_DIR).toMatch(/^\/tmp\/h5dir-bbbb/);
      expect(manager.relaunchDefaultBackend).toHaveBeenCalledWith(true);
    });

    it("leaves unknown (non-schema) removed keys untouched", async () => {
      // Simulate an inherited env value the process picked up from some boot
      // source other than this test's .env — removal of the key from the file
      // must NOT clear it, because it is not ours to manage (not in CONFIG_SCHEMA).
      process.env.SOME_RANDOM = "x1";
      const { body } = await primeAndRemove(
        (v) => `# h5\nHEADLESS=true\nSOME_RANDOM=${v}\n`,
        "x1",
        "SOME_RANDOM"
      );
      expect(process.env.SOME_RANDOM).toBe("x1");
      expect(process.env.HEADLESS).toBe("true");
      expect(body.envFile.changedOnDisk).toBe(false);
      expect(manager.relaunchDefaultBackend).not.toHaveBeenCalled();
    });
  });

  describe("GET /console/config — external .env reconcile failure containment (plan 60 H6)", () => {
    let envDir;
    let envFile;
    let manager;
    let origEnv;

    beforeEach(async () => {
      envDir = fs.mkdtempSync(path.join(os.tmpdir(), "navigator-console-h6-"));
      envFile = path.join(envDir, ".env");
      process.env.NAVIGATOR_ENV_FILE = envFile;
      const browserMod = await import("../src/browser.js");
      manager = await browserMod.getBrowserManager.mock.results[0].value;
      origEnv = {
        DISPLAY: process.env.DISPLAY,
        HEADLESS: process.env.HEADLESS,
        CHROME_PATH: process.env.CHROME_PATH,
      };
      delete process.env.DISPLAY;
      manager.relaunchDefaultBackend.mockClear();
    });

    afterEach(() => {
      delete process.env.NAVIGATOR_ENV_FILE;
      for (const [k, v] of Object.entries(origEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try { fs.rmSync(envDir, { recursive: true, force: true }); } catch {}
    });

    // Reconcile reaches its last awaited step (the plan 60 H4 relaunch hook)
    // only when a CHROME_PATH value-change hot-applies; injecting a throw there
    // exercises the GET handler's reconcile containment.
    async function primeAndCauseFailure() {
      fs.writeFileSync(envFile, "# h6\nHEADLESS=true\nCHROME_PATH=/usr/bin/chromium\n");
      await fetch(`${MCP_BASE}/console/config`); // baseline stat
      fs.writeFileSync(envFile, "# h6\nHEADLESS=true\nCHROME_PATH=/usr/bin/chromium-h6\n"); // delta
      manager.relaunchDefaultBackend.mockImplementationOnce(() => {
        throw new Error("h6 reconcile boom");
      });
      const res = await fetch(`${MCP_BASE}/console/config`);
      return { res, body: await res.json() };
    }

    it("reports a reconcile failure in the payload instead of 500ing, then self-heals once it succeeds", async () => {
      const { res, body } = await primeAndCauseFailure();
      // the first poll: reconcile blew up, so the payload is still served with
      // the banner truthfully up and a machine-readable reason attached
      expect(res.status).toBe(200);
      expect(body.envFile.changedOnDisk).toBe(true);
      expect(body.envFile.reconcileError).toContain("h6 reconcile boom");
      // the exact same .env on the next poll reconciles cleanly (the failure
      // was transient): both the banner and the stuck error clear
      const res2 = await fetch(`${MCP_BASE}/console/config`);
      const body2 = await res2.json();
      expect(res2.status).toBe(200);
      expect(body2.envFile.changedOnDisk).toBe(false);
      expect(body2.envFile.reconcileError).toBeNull();
    });

    it("clears a left-over reconcile error when the operator writes the file through the console", async () => {
      const { body } = await primeAndCauseFailure();
      expect(body.envFile.changedOnDisk).toBe(true);
      expect(body.envFile.reconcileError).toContain("h6 reconcile boom");
      // a console PUT acknowledges the sync: the previously-failed external
      // state is superseded, banner and error must not stick
      const put = await fetch(`${MCP_BASE}/console/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { SEARCH_QUEUE_ESCALATION_FACTOR: 7 } }),
      });
      expect(put.status).toBe(200);
      const get = await fetch(`${MCP_BASE}/console/config`);
      const final = await get.json();
      expect(final.envFile.changedOnDisk).toBe(false);
      expect(final.envFile.reconcileError).toBeNull();
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
        "browser", "bypassCache", "maxChars", "ref_ids", "script", "scriptOptions", "urls"
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

    it("caps query count at 6", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query: "q1",
        queries: Array.from({ length: 8 }, (_, i) => `query ${i + 1}`),
        results: [],
      }));

      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 15, method: "tools/call",
        params: {
          name: "web_search",
          arguments: { queries: Array.from({ length: 8 }, (_, i) => `query ${i + 1}`) },
        },
      });

      expect(status).toBe(200);
      const lastCall = searchMod.browserSearch.mock.calls.at(-1)[0];
      expect(lastCall.queries.length).toBe(6);
      expect(lastCall.queries).toEqual(["query 1", "query 2", "query 3", "query 4", "query 5", "query 6"]);
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

    it("a key restricted to MCP browsers bypasses the web_fetch result cache (plan 57)", async () => {
      // The tool-result cache is keyed on request args and carries no API-key
      // identity, so a restricted key must not be able to read an entry another
      // key fetched on a browser it is not allowed to use. Restricted keys skip
      // both the read and the write.
      const dbMod = await import("../src/db.js");
      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockImplementation(async ({ url }) => ({
        title: "Cached Domain",
        url,
        text: "page body",
      }));

      // Create through the console API so the key is synced into the
      // in-memory list the request path authorizes against.
      const created = await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name: "cache-bypass key",
          allowedTools: ["web_fetch"],
          allowedMcpBrowsers: ["chromium"],
        }),
      });
      const secret = (await created.json()).key;
      expect(secret).toMatch(/^nvg_/);

      const request = {
        jsonrpc: "2.0", id: 300, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { urls: ["https://cache-bypass.example.com"], browser: "chromium" },
        },
      };

      // 1. An unrestricted request populates the shared cache for these args.
      await mcpPost(request);
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(1);

      // 2. A second unrestricted request with the same args IS served from cache.
      await mcpPost({ ...request, id: 301 });
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(1);

      // 3. The restricted key must miss that cache and go to the browser, where
      //    the per-key permission check can run.
      await mcpPost(request, { authorization: `Bearer ${secret}` });
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(2);

      const revoked = await fetch(`${MCP_BASE}/console/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke", id: (await (await fetch(`${MCP_BASE}/console/api-keys`)).json()).keys.find((entry) => entry.name === "cache-bypass key").id }),
      });
      expect(revoked.status).toBe(200);
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
        browser: "",
        allowedMcpBrowsers: null
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

    it("rejects an oversized web_fetch batch with a clear message", async () => {
      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 170, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { urls: Array.from({ length: 11 }, (_, i) => `https://x${i}.example.com`) },
        },
      });
      expect(status).toBe(200);
      const message = body.result.isError ? body.result.content[0].text : JSON.stringify(body);
      expect(message).toContain("Too many URLs");
      expect(message).toContain("max 10");
    });

    it("rejects a web_fetch script with a multi-URL batch", async () => {
      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 171, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { urls: ["https://a.example.com", "https://b.example.com"], script: 'return { text: "x" };' },
        },
      });
      expect(status).toBe(200);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toMatch(/single URL/);
    });

    it("rejects an invalid web_fetch script before opening a browser", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract.mockReset();
      const { status, body } = await mcpPost({
        jsonrpc: "2.0", id: 172, method: "tools/call",
        params: {
          name: "web_fetch",
          arguments: { url: "https://example.com", script: "return {{{" },
        },
      });
      expect(status).toBe(200);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toMatch(/Invalid web_fetch script/);
      expect(searchMod.browserOpenAndExtract).not.toHaveBeenCalled();
    });

    it("runs a per-call web_fetch script and never caches it", async () => {
      const searchMod = await import("../src/search.js");
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValue({
        text: "script output",
        title: "Script Page",
        url: "https://script.example.com"
      });
      const args = { url: "https://script.example.com", script: 'return { text: "script output" };', scriptOptions: { timeoutMs: 5000 } };
      for (const id of [173, 174]) {
        const { status, body } = await mcpPost({
          jsonrpc: "2.0", id, method: "tools/call",
          params: { name: "web_fetch", arguments: args },
        });
        expect(status).toBe(200);
        expect(body.result.content[0].text).toContain("script output");
      }
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(2);
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledWith(expect.objectContaining({
        url: "https://script.example.com",
        requestScript: 'return { text: "script output" };',
        requestScriptOptions: { timeoutMs: 5000 }
      }));
    });

    describe("web_fetch_setup (plan 62)", () => {
      async function sharedManager() {
        const browserMod = await import("../src/browser.js");
        return browserMod.getBrowserManager.mock.results[0].value;
      }

      async function enableSetup() {
        const manager = await sharedManager();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-unit-"));
        manager.config.enableDomainHintManagement = true;
        manager.config.domainHintsManagedPath = path.join(dir, "domain-hints.managed.json");
        return manager;
      }

      async function disableSetup() {
        const manager = await sharedManager();
        manager.config.enableDomainHintManagement = false;
        delete manager.config.domainHintsManagedPath;
        const { clearManagedHintCache } = await import("../src/domain-hints.js");
        clearManagedHintCache();
      }

      async function setupCall(args, id = 200) {
        const { status, body } = await mcpPost({
          jsonrpc: "2.0", id, method: "tools/call",
          params: { name: "web_fetch_setup", arguments: args },
        });
        expect(status).toBe(200);
        return body;
      }

      const setupHint = (overrides = {}) => ({
        id: "ex-1h-v1",
        domain: "example.com",
        pathPattern: "/*",
        pageType: "chart",
        comment: "reads 1H series",
        script: 'return { text: "hi" };',
        ...overrides
      });

      it("is hidden from tools/list and rejected when disabled", async () => {
        await disableSetup();
        const { body } = await mcpPost({ jsonrpc: "2.0", id: 201, method: "tools/list" });
        expect(body.result.tools.map((t) => t.name)).not.toContain("web_fetch_setup");
        const direct = await setupCall({ operation: "list" }, 202);
        expect(direct.result.isError).toBe(true);
        expect(direct.result.content[0].text).toMatch(/disabled/);
      });

      it("appears in tools/list with a closed schema when enabled", async () => {
        await enableSetup();
        try {
          const { body } = await mcpPost({ jsonrpc: "2.0", id: 203, method: "tools/list" });
          const tool = body.result.tools.find((t) => t.name === "web_fetch_setup");
          expect(tool).toBeDefined();
          expect(tool.inputSchema.additionalProperties).toBe(false);
          expect(tool.inputSchema.required).toEqual(["operation"]);
        } finally {
          await disableSetup();
        }
      });

      it("runs validate → upsert → get → disable → enable → remove", async () => {
        await enableSetup();
        try {
          const bad = await setupCall({ operation: "validate", hint: setupHint({ id: "BAD!" }) }, 204);
          expect(JSON.parse(bad.result.content[0].text).valid).toBe(false);

          const upserted = await setupCall({ operation: "upsert", hint: setupHint() }, 205);
          const saved = JSON.parse(upserted.result.content[0].text);
          expect(saved.id).toBe("ex-1h-v1");
          expect(saved.source).toBe("managed");

          const listed = await setupCall({ operation: "list" }, 206);
          const listBody = JSON.parse(listed.result.content[0].text);
          expect(listBody.hints.map((h) => h.id)).toEqual(["ex-1h-v1"]);
          expect(listBody.hints[0]).not.toHaveProperty("script");

          const got = await setupCall({ operation: "get", url: "https://example.com/feat" }, 207);
          expect(JSON.parse(got.result.content[0].text).source).toBe("managed");

          const missing = await setupCall({ operation: "get", url: "https://other.com/x" }, 208);
          expect(JSON.parse(missing.result.content[0].text).source).toBe("none");

          const disabled = await setupCall({ operation: "disable", id: "ex-1h-v1" }, 209);
          expect(JSON.parse(disabled.result.content[0].text).enabled).toBe(false);
          const afterDisable = await setupCall({ operation: "get", url: "https://example.com/feat" }, 210);
          expect(JSON.parse(afterDisable.result.content[0].text).source).toBe("none");

          const enabled = await setupCall({ operation: "enable", id: "ex-1h-v1" }, 211);
          expect(JSON.parse(enabled.result.content[0].text).enabled).toBe(true);
          const afterEnable = await setupCall({ operation: "get", url: "https://example.com/feat" }, 212);
          expect(JSON.parse(afterEnable.result.content[0].text).source).toBe("managed");

          const removed = await setupCall({ operation: "remove", id: "ex-1h-v1" }, 213);
          expect(JSON.parse(removed.result.content[0].text).removed).toBe(true);
          const afterRemove = await setupCall({ operation: "list" }, 214);
          expect(JSON.parse(afterRemove.result.content[0].text).hints).toEqual([]);
        } finally {
          await disableSetup();
        }
      });

      it("rejects unknown ids and missing upsert fields", async () => {
        await enableSetup();
        try {
          const noHint = await setupCall({ operation: "disable", id: "nope" }, 215);
          expect(noHint.result.isError).toBe(true);
          const noHintEnable = await setupCall({ operation: "enable", id: "nope" }, 216);
          expect(noHintEnable.result.isError).toBe(true);
          const missingField = await setupCall({ operation: "upsert", hint: { id: "x" } }, 217);
          expect(missingField.result.isError).toBe(true);
          expect(missingField.result.content[0].text).toMatch(/hint\.domain/);
        } finally {
          await disableSetup();
        }
      });

      it("console hints API can create, list, edit, validate and remove managed hints by id", async () => {
        const manager = await enableSetup();
        manager.config.domainHintsPath = path.join(path.dirname(manager.config.domainHintsManagedPath), "domain-hints.json");
        try {
          const createdRes = await fetch(`${MCP_BASE}/console/api/hints/managed/console-test`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hint: { id: "console-test", domain: "test.example.com", pathPattern: "/**", pageType: "probe", comment: "console probe", script: 'return { text: document.title };' } }),
          });
          expect(createdRes.status).toBe(200);
          const created = await createdRes.json();
          expect(created.ok).toBe(true);
          expect(created.id).toBe("console-test");
          expect(created.source).toBe("managed");
          expect(created.hint.domain).toBe("test.example.com");

          const listRes = await fetch(`${MCP_BASE}/console/api/hints`).then((r) => r.json());
          const row = listRes.hints.find((h) => h._managed === true && h.id === "console-test");
          expect(row).toBeDefined();
          expect(row.pageType).toBe("probe");

          const urlIdWinsRes = await fetch(`${MCP_BASE}/console/api/hints/managed/console-test`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hint: { id: "WRONG-ID", domain: "test.example.com", pathPattern: "/foo/**", pageType: "probe2", comment: "updated", script: 'return { text: document.title + "!" };' } }),
          });
          expect(urlIdWinsRes.status).toBe(200);
          const updated = await urlIdWinsRes.json();
          expect(updated.hint.id).toBe("console-test");
          expect(updated.hint.pathPattern).toBe("/foo/**");
          expect(updated.hint.pageType).toBe("probe2");

          const invalidRes = await fetch(`${MCP_BASE}/console/api/hints/managed/console-test`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hint: { id: "console-test", domain: "test.example.com", pathPattern: "/**", script: "x", enabled: "not-bool" } }),
          });
          expect(invalidRes.status).toBe(400);
          const invalid = await invalidRes.json();
          expect(invalid.ok).toBe(false);
          expect(invalid.validation.errors.some((e) => e.field === "enabled")).toBe(true);

          const validateRes = await fetch(`${MCP_BASE}/console/api/hints/validate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hint: { _managed: true, id: "console-test", domain: "test.example.com", pathPattern: "/**", script: "x", scriptOptions: { timeoutMs: 99999 } } }),
          }).then((r) => r.json());
          expect(validateRes.valid).toBe(false);

          const removedRes = await fetch(`${MCP_BASE}/console/api/hints/managed/console-test`, { method: "DELETE" });
          expect(removedRes.status).toBe(200);
          const removed = await removedRes.json();
          expect(removed.ok).toBe(true);
          expect(removed.removed).toMatchObject({ id: "console-test" });

          const afterRes = await fetch(`${MCP_BASE}/console/api/hints`).then((r) => r.json());
          expect(afterRes.hints.find((h) => h._managed === true && h.id === "console-test")).toBeUndefined();

          const missingRes = await fetch(`${MCP_BASE}/console/api/hints/managed/does-not-exist`, { method: "DELETE" });
          expect(missingRes.status).toBe(400);
        } finally {
          await disableSetup();
        }
      });
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
        default: { format: "readability_to_markdown", postProcessor: "reader_lm" }
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

  describe("list_browsers prompt precedence (plan 45)", () => {
    it("a relay browser's own description wins over the configured BROWSERS prompt; empty falls back to it", async () => {
      const { relayServer } = await import("../src/relay-server.js");
      const browserMod = await import("../src/browser.js");
      // Ask the mock for its CURRENT manager — earlier suites reset the mock to
      // a fresh instance, so results[0] would be a stale, unused manager.
      const manager = await browserMod.getBrowserManager();
      const originalBrowsers = manager.config.browsers;
      const originalAddOns = manager._effectiveAddOns;

      // The console-configured prompt is the default, shown whenever the
      // browser owner has not written a description of their own.
      const configured = { name: "laptop", role: ["default"], type: "navigator-cdp", plugin: "chrome", addOn: true, prompt: "console default prompt" };
      manager.config.browsers = [...originalBrowsers, configured];
      // The description reaches list_browsers through the effective add-on
      // entry (BrowserManager._effectiveAddOns -> relayServer.getStatusEntries),
      // so that entry is the seam to drive.
      const relayEntry = { name: "laptop", type: "navigator-cdp", role: ["default"], status: "connected", paired: true, connected: true, configured: true, description: "" };
      manager._effectiveAddOns = () => [
        { name: "cloakbrowser", type: "cdp", role: ["default"], cdpUrl: "http://cloak:9222", status: "available", configured: true },
        relayEntry,
      ];
      const isPaired = vi.spyOn(relayServer, "isPaired").mockReturnValue(true);
      // list_browsers asks the manager whether a cdp add-on is connected; the
      // shared mock manager has no such method, so stub it for this test only.
      const hadIsConnected = "_isAddOnConnected" in manager;
      manager._isAddOnConnected = () => true;

      const rowFor = (text) => String(text).split("\n").find((l) => l.includes("**laptop**")) || "";

      try {
        // 1. No owner description -> the configured prompt is shown.
        let res = await mcpPost({
          jsonrpc: "2.0", id: 90, method: "tools/call",
          params: { name: "list_browsers", arguments: {} },
        });
        expect(res.status).toBe(200);
        let text = res.body.result.content[0].text;
        expect(rowFor(text)).toContain("console default prompt");

        // 2. The owner typed a description in the popup -> it wins.
        relayEntry.description = "my personal laptop, logged into Gmail";
        res = await mcpPost({
          jsonrpc: "2.0", id: 91, method: "tools/call",
          params: { name: "list_browsers", arguments: {} },
        });
        text = res.body.result.content[0].text;
        expect(rowFor(text)).toContain("my personal laptop, logged into Gmail");
        expect(rowFor(text)).not.toContain("console default prompt");

        // 3. Whitespace-only is still "no description" — the fallback stays.
        relayEntry.description = "   ";
        res = await mcpPost({
          jsonrpc: "2.0", id: 92, method: "tools/call",
          params: { name: "list_browsers", arguments: {} },
        });
        text = res.body.result.content[0].text;
        expect(rowFor(text)).toContain("console default prompt");

        // 4. A multi-line description is flattened to one table cell.
        relayEntry.description = "line one\nline two";
        res = await mcpPost({
          jsonrpc: "2.0", id: 93, method: "tools/call",
          params: { name: "list_browsers", arguments: {} },
        });
        text = res.body.result.content[0].text;
        expect(rowFor(text)).toContain("line one line two");
      } finally {
        isPaired.mockRestore();
        if (!hadIsConnected) delete manager._isAddOnConnected;
        manager._effectiveAddOns = originalAddOns;
        manager.config.browsers = originalBrowsers;
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

  // ---- cache transparency (plan 59 §9a) ---------------------------------
  // Two separate defects: a failure payload was cached for the full TTL (one
  // DNS blip became permanent), and a replayed response was byte-identical to
  // a fresh one, so a model could not tell a 10-minute-old page from current.
  describe("cache transparency (plan 59)", () => {
    it("never caches a result that contains a failed item", async () => {
      const searchMod = await import("../src/search.js");
      const query = `cache failure ${Date.now()}`;
      searchMod.browserSearch.mockReset();
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query,
        results: [{ title: "Fine", url: "https://ok.example.com", snippet: "ok" }],
        errors: ["transient network error"],
      }));

      const r1 = await mcpPost({
        jsonrpc: "2.0", id: 80, method: "tools/call",
        params: { name: "web_search", arguments: { query } },
      });
      expect(r1.status).toBe(200);

      // A second call must hit the network again, not replay the failure.
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query,
        results: [{ title: "Recovered Result", url: "https://ok.example.com", snippet: "ok" }],
      }));
      const r2 = await mcpPost({
        jsonrpc: "2.0", id: 81, method: "tools/call",
        params: { name: "web_search", arguments: { query } },
      });
      expect(r2.body.result.content[0].text).toContain("Recovered Result");
    });

    it("marks a replayed response as cached with its age", async () => {
      const searchMod = await import("../src/search.js");
      const query = `cache stamp ${Date.now()}`;
      searchMod.browserSearch.mockReset();
      searchMod.browserSearch.mockResolvedValueOnce(makeMockSearchPayload({
        query,
        results: [{ title: "Stamped Result", url: "https://stamped.example.com", snippet: "s" }],
      }));

      const r1 = await mcpPost({
        jsonrpc: "2.0", id: 82, method: "tools/call",
        params: { name: "web_search", arguments: { query } },
      });
      const freshText = r1.body.result.content[0].text;
      expect(freshText).toContain("Stamped Result");
      expect(freshText).not.toMatch(/cached result/i);

      searchMod.browserSearch.mockReset();
      const r2 = await mcpPost({
        jsonrpc: "2.0", id: 83, method: "tools/call",
        params: { name: "web_search", arguments: { query } },
      });
      const cachedText = r2.body.result.content[0].text;
      expect(searchMod.browserSearch).not.toHaveBeenCalled(); // really a cache hit
      expect(cachedText).toMatch(/cached result/i);
      expect(cachedText).toMatch(/retrieved \d+[smh] ago/);
      expect(cachedText).toContain("bypassCache");
    });

    it("bypassCache skips the cache and returns an unmarked fresh response", async () => {
      const searchMod = await import("../src/search.js");
      const query = `bypass stamp ${Date.now()}`;
      searchMod.browserSearch.mockReset();
      searchMod.browserSearch.mockResolvedValue(makeMockSearchPayload({
        query,
        results: [{ title: "Bypass Result", url: "https://bypass.example.com", snippet: "b" }],
      }));

      await mcpPost({
        jsonrpc: "2.0", id: 84, method: "tools/call",
        params: { name: "web_search", arguments: { query } },
      });
      const r2 = await mcpPost({
        jsonrpc: "2.0", id: 85, method: "tools/call",
        params: { name: "web_search", arguments: { query, bypassCache: true } },
      });
      const text = r2.body.result.content[0].text;
      expect(text).toContain("Bypass Result");
      expect(text).not.toMatch(/cached result/i);
    });
  });

  // ---- cache identity (plan 60 S10) --------------------------------------
  // Args alone let a cached fetch outlive the producer context that shaped it:
  // a static-hint save or a hot config change must make the next fetch re-run,
  // not replay the pre-change entry.
  describe("cache identity (plan 60 S10)", () => {
    it("re-extracts after a static hint is created through the console API", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-s10-hints-"));
      const s10HintsPath = path.join(tempDir, "domain-hints.json");
      fs.writeFileSync(s10HintsPath, "[]\n");
      // The console handlers close over the boot manager, so point its
      // domainHintsPath at the temp file (restored afterwards) — the fetch
      // path reads the same object via getBrowserManager().
      const browserMod = await import("../src/browser.js");
      const bootManager = await browserMod.getBrowserManager();
      const prevHintsPath = bootManager.config.domainHintsPath;
      bootManager.config.domainHintsPath = s10HintsPath;
      try {
        const searchMod = await import("../src/search.js");
        const url = `https://example.com/s10-hint-${Date.now()}`;
        searchMod.browserOpenAndExtract.mockReset();
        searchMod.browserOpenAndExtract.mockResolvedValueOnce({ text: "before hint", title: "Before", url });

        const r1 = await mcpPost({
          jsonrpc: "2.0", id: 90, method: "tools/call",
          params: { name: "web_fetch", arguments: { url } },
        });
        expect(r1.status).toBe(200);
        expect(r1.body.result.content[0].text).toContain("before hint");
        expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(1);

        // Static hint CRUD only bumps the hint revision (no bucket clear) —
        // the key context is what must invalidate the cached entry.
        const created = await fetch(`${MCP_BASE}/console/api/hints`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hint: { domain: "example.com", pathPattern: "/**", pageType: "page", comment: "s10 cache identity" } }),
        });
        const createdBody = await created.json();
        if (created.status !== 200) console.error("S10 create hint failed:", created.status, JSON.stringify(createdBody));
        expect(created.status).toBe(200);
        expect(createdBody.ok).toBe(true);

        searchMod.browserOpenAndExtract.mockResolvedValueOnce({ text: "after hint", title: "After", url });
        const r2 = await mcpPost({
          jsonrpc: "2.0", id: 91, method: "tools/call",
          params: { name: "web_fetch", arguments: { url } },
        });
        expect(r2.body.result.content[0].text).toContain("after hint");
        expect(r2.body.result.content[0].text).not.toContain("before hint");
        expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(2);
      } finally {
        bootManager.config.domainHintsPath = prevHintsPath;
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    });

    it("re-extracts after a hot config change", async () => {
      const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-s10-env-"));
      const envFile = path.join(envDir, ".env");
      fs.writeFileSync(envFile, "# test env\n");
      process.env.NAVIGATOR_ENV_FILE = envFile;
      try {
        const searchMod = await import("../src/search.js");
        const url = `https://example.com/s10-cfg-${Date.now()}`;
        searchMod.browserOpenAndExtract.mockReset();
        searchMod.browserOpenAndExtract.mockResolvedValueOnce({ text: "before config", title: "Before", url });

        const r1 = await mcpPost({
          jsonrpc: "2.0", id: 92, method: "tools/call",
          params: { name: "web_fetch", arguments: { url } },
        });
        expect(r1.status).toBe(200);
        expect(r1.body.result.content[0].text).toContain("before config");

        const put = await fetch(`${MCP_BASE}/console/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { ENABLE_SCREENSHOT_DOWNLOAD_LINK: true } }),
        });
        expect(put.status).toBe(200);
        const putBody = await put.json();
        expect(putBody.ok).toBe(true);
        expect(putBody.hotApplied).toContain("ENABLE_SCREENSHOT_DOWNLOAD_LINK");

        searchMod.browserOpenAndExtract.mockResolvedValueOnce({ text: "after config", title: "After", url });
        const r2 = await mcpPost({
          jsonrpc: "2.0", id: 93, method: "tools/call",
          params: { name: "web_fetch", arguments: { url } },
        });
        expect(r2.body.result.content[0].text).toContain("after config");
        expect(r2.body.result.content[0].text).not.toContain("before config");
        expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(2);
      } finally {
        delete process.env.NAVIGATOR_ENV_FILE;
        try { fs.rmSync(envDir, { recursive: true, force: true }); } catch {}
      }
    });

    it("still hits the cache when nothing about the producer context changed", async () => {
      const searchMod = await import("../src/search.js");
      const url = `https://example.com/s10-stable-${Date.now()}`;
      searchMod.browserOpenAndExtract.mockReset();
      searchMod.browserOpenAndExtract.mockResolvedValueOnce({ text: "stable page", title: "Stable", url });

      const r1 = await mcpPost({
        jsonrpc: "2.0", id: 94, method: "tools/call",
        params: { name: "web_fetch", arguments: { url } },
      });
      expect(r1.body.result.content[0].text).toContain("stable page");
      expect(r1.body.result.cached).toBeFalsy();

      const r2 = await mcpPost({
        jsonrpc: "2.0", id: 95, method: "tools/call",
        params: { name: "web_fetch", arguments: { url } },
      });
      expect(r2.body.result.content[0].text).toContain("stable page");
      // fetch hits signal via the result flag (object response shape)
      expect(r2.body.result.cached).toBe(true);
      expect(r2.body.result.cacheAgeMs).toBeGreaterThanOrEqual(0);
      expect(searchMod.browserOpenAndExtract).toHaveBeenCalledTimes(1);
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

describe("resolveSvgElementLimit (plan 68)", () => {
  it("honors explicit limits on full-page captures, floors only defaulted ones", async () => {
    const { resolveSvgElementLimit } = await import("../src/mcp-server.js");
    expect(resolveSvgElementLimit(60, true)).toBe(60);
    expect(resolveSvgElementLimit(60, false)).toBe(60);
    expect(resolveSvgElementLimit(undefined, true)).toBe(5000);
    expect(resolveSvgElementLimit(undefined, false)).toBe(5000);
    expect(resolveSvgElementLimit(100000, true)).toBe(5000);
    expect(() => resolveSvgElementLimit(0, true)).toThrow(/positive number/);
    expect(() => resolveSvgElementLimit("many", true)).toThrow(/positive number/);
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
