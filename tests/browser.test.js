import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("puppeteer-core", () => ({
  default: {
    launch: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(),
}));

import { loadConfig } from "../src/config.js";

function makeConfig(overrides = {}) {
  return {
    chromePath: "/usr/bin/chrome",
    chromeUserDataDir: "/data/chrome",
    chromeProfileDir: "Default",
    defaultBackend: "chromium",
    browsers: [
      { name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false }
    ],
    browserOpTimeoutMs: 60000,
    headless: true,
    userAgent: "test-agent",
    navWaitUntil: "domcontentloaded",
    mcpApiPort: 1994,
    mcpApiHost: "http://localhost",
    enableHttpHealth: false,
    enableHttpMcp: false,
    enableStdioMcp: true,
    enableDevtoolsMcp: false,
    searchKeepMinWorkingWindows: 2,
    searchMaxWorkingWindows: 10,
    searchRouteCircuitOpenMs: 300000,
    openPageMaxParallel: 6,
    maxConcurrentPageOps: 30,
    humanTypingDelay: 15,
    prelaunchBrowser: true,
    enableHangRestart: false,
    hangRestartTimeoutMs: 120000,
    startupUrl: "about:blank",
    searchRouteWarmupEngines: [],
    searchEnabledEngines: null,
    screenshotPathPrefix: null,
    enableScreenshotDownloadLink: false,
    ...overrides,
  };
}

describe("BrowserManager", () => {
  let BrowserManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../src/browser.js");
    BrowserManager = mod.BrowserManager;
  });

  describe("constructor", () => {
    it("sets config and initializes properties", () => {
      const config = makeConfig();
      const manager = new BrowserManager(config);
      expect(manager.config).toBe(config);
      expect(manager.browser).toBeNull();
      expect(manager.launching).toBeNull();
      expect(manager.tempProfileDir).toBeNull();
      expect(manager.keepAlivePage).toBeNull();
      expect(manager.prelaunchPromise).toBeNull();
      expect(manager._addOnState instanceof Map).toBe(true);
      expect(manager.engineWorkingWindows instanceof Map).toBe(true);
      expect(manager.engineWorkingWindows.size).toBe(0);
      expect(manager.pageSlotsInUse).toBe(0);
      expect(Array.isArray(manager.pageSlotWaiters)).toBe(true);
      expect(manager.pageSlotWaiters.length).toBe(0);
    });
  });

  describe("getEnginePool", () => {
    it("creates a new pool for unknown engine", () => {
      const manager = new BrowserManager(makeConfig());
      const pool = manager.getEnginePool("google");
      expect(pool).toHaveProperty("engine", "google");
      expect(pool).toHaveProperty("windows");
      expect(Array.isArray(pool.windows)).toBe(true);
      expect(pool.windows.length).toBe(0);
    });

    it("returns same pool for same engine", () => {
      const manager = new BrowserManager(makeConfig());
      const pool1 = manager.getEnginePool("google");
      const pool2 = manager.getEnginePool("google");
      expect(pool1).toBe(pool2);
    });
  });

  describe("buildWindowStats", () => {
    it("returns empty stats when no windows exist", () => {
      const manager = new BrowserManager(makeConfig());
      const stats = manager.buildWindowStats();
      expect(stats).toHaveProperty("totalOpen", 0);
      expect(stats).toHaveProperty("totalInUse", 0);
      expect(stats).toHaveProperty("totalPending", 0);
      expect(stats).toHaveProperty("totalWaiters", 0);
      expect(stats).toHaveProperty("byEngine");
      expect(typeof stats.byEngine).toBe("object");
      expect(stats).toHaveProperty("pageSlots");
      expect(stats.pageSlots).toHaveProperty("inUse", 0);
      expect(stats.pageSlots).toHaveProperty("queued", 0);
      expect(stats.pageSlots).toHaveProperty("max", 30);
    });
  });

  describe("newPage", () => {
    it("creates a chromium page by default", async () => {
      const manager = new BrowserManager(makeConfig());
      const page = { setUserAgent: vi.fn(), setDefaultNavigationTimeout: vi.fn(), setDefaultTimeout: vi.fn() };
      manager._newChromiumPage = vi.fn().mockResolvedValue(page);
      await expect(manager.newPage({})).resolves.toBe(page);
    });

    it("dispatches an explicit chromium browser", async () => {
      const manager = new BrowserManager(makeConfig());
      const page = { setUserAgent: vi.fn(), setDefaultNavigationTimeout: vi.fn(), setDefaultTimeout: vi.fn() };
      manager._newChromiumPage = vi.fn().mockResolvedValue(page);
      await expect(manager.newPage({ browser: "chromium" })).resolves.toBe(page);
    });

    it("connects to a configured add-on by name", async () => {
      const config = makeConfig({
        browsers: [
          { name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false },
          { name: "lightpanda", role: ["fetch"], cdpUrl: "http://127.0.0.1:9222", addOn: true }
        ]
      });
      const manager = new BrowserManager(config);
      const addOnPage = { id: "lp" };
      manager._connectAddOnPage = vi.fn().mockResolvedValue(addOnPage);
      await expect(manager.newPage({ browser: "lightpanda" })).resolves.toBe(addOnPage);
      expect(manager._connectAddOnPage).toHaveBeenCalledWith(expect.objectContaining({ name: "lightpanda" }));
    });

    it("throws for an unknown browser name", async () => {
      const manager = new BrowserManager(makeConfig());
      await expect(manager.newPage({ browser: "firefox" })).rejects.toThrow(/unknown browser/);
    });
  });

  describe("_poolEngine", () => {
    it("returns the engine name for engine-pool engine routes", () => {
      const manager = new BrowserManager(makeConfig());
      expect(manager._poolEngine("google")).toBe("google");
      expect(manager._poolEngine("duckduckgo")).toBe("duckduckgo");
    });

    it("returns null for shared-pool engine routes", () => {
      const manager = new BrowserManager(makeConfig());
      expect(manager._poolEngine("mojeek")).toBeNull();
      expect(manager._poolEngine("bing")).toBeNull();
    });

    it("returns null for API engines", () => {
      const manager = new BrowserManager(makeConfig());
      expect(manager._poolEngine("duckduckgo_api")).toBeNull();
    });

    it("returns null for unknown engines (no route = no window pool)", () => {
      const manager = new BrowserManager(makeConfig());
      expect(manager._poolEngine("some_engine")).toBeNull();
    });
  });

  describe("_poolMaxWindows", () => {
    it("returns searchMaxWorkingWindows", () => {
      const manager = new BrowserManager(makeConfig({ searchMaxWorkingWindows: 10 }));
      expect(manager._poolMaxWindows("google")).toBe(10);
    });
  });

  describe("add-on connections", () => {
    it("connects to an HTTP cdpUrl via browserURL (CloakBrowser style CDP server)", async () => {
      const config = makeConfig({
        browsers: [
          { name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false },
          { name: "cloakbrowser", role: ["fetch", "screenshot", "devtools"], cdpUrl: "http://cloak-browser:9222", addOn: true }
        ]
      });
      const manager = new BrowserManager(config);
      const page = { fake: "page" };
      const browser = { connected: true, on: vi.fn(), newPage: vi.fn().mockResolvedValue(page) };
      const puppeteer = (await import("puppeteer-core")).default;
      puppeteer.connect = vi.fn().mockResolvedValue(browser);

      await expect(manager._connectAddOnPage(config.browsers[1])).resolves.toBe(page);

      expect(puppeteer.connect).toHaveBeenCalledWith(expect.objectContaining({
        browserURL: "http://cloak-browser:9222",
        defaultViewport: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) })
      }));
      expect(puppeteer.connect).not.toHaveBeenCalledWith(expect.objectContaining({ browserWSEndpoint: expect.anything() }));
    });

    it("connects to a ws:// cdpUrl via browserWSEndpoint (direct browser endpoint)", async () => {
      const config = makeConfig({
        browsers: [
          { name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false },
          { name: "playwright", role: ["fetch"], cdpUrl: "ws://127.0.0.1:9222", addOn: true }
        ]
      });
      const manager = new BrowserManager(config);
      const page = { fake: "page" };
      const browser = { connected: true, on: vi.fn(), newPage: vi.fn().mockResolvedValue(page) };
      const puppeteer = (await import("puppeteer-core")).default;
      puppeteer.connect = vi.fn().mockResolvedValue(browser);

      await expect(manager._connectAddOnPage(config.browsers[1])).resolves.toBe(page);

      expect(puppeteer.connect).toHaveBeenCalledWith(expect.objectContaining({
        browserWSEndpoint: "ws://127.0.0.1:9222"
      }));
      expect(puppeteer.connect).not.toHaveBeenCalledWith(expect.objectContaining({ browserURL: expect.anything() }));
    });

    it("finds an add-on by name and ignores case", () => {
      const config = makeConfig({
        browsers: [
          { name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false },
          { name: "lightpanda", role: ["fetch"], cdpUrl: "http://127.0.0.1:9222", addOn: true }
        ]
      });
      const manager = new BrowserManager(config);
      const found = manager._findAddOnByName("lightpanda");
      expect(found).toMatchObject({
        name: "lightpanda",
        role: ["fetch"],
        cdpUrl: "http://127.0.0.1:9222",
        type: "cdp",
        configured: true
      });
      expect(manager._findAddOnByName("chromium")).toBeNull(); // built-in, not an add-on
      expect(manager._findAddOnByName("missing")).toBeNull();
    });

    it("reports connection state per add-on", async () => {
      const config = makeConfig({
        browsers: [
          { name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false },
          { name: "lightpanda", role: ["fetch"], cdpUrl: "http://127.0.0.1:9222", addOn: true }
        ]
      });
      const manager = new BrowserManager(config);
      manager._addOnState.set("addon_lightpanda", { browser: { connected: true } });
      expect(manager._isAddOnConnected("lightpanda")).toBe(true);
      expect(manager._isAddOnConnected("missing")).toBe(false);
      expect(manager._addOnConnection("lightpanda")).toBeTruthy();
      expect(manager._addOnConnection("missing")).toBeNull();
    });
  });

  describe("prelaunch", () => {
    it("prelaunches only chromium", async () => {
      const manager = new BrowserManager(makeConfig({ searchRouteWarmupEngines: [] }));
      manager._prelaunchChromium = vi.fn().mockResolvedValue(undefined);
      manager.ensureMinWorkingWindows = vi.fn();

      await manager.prelaunchIfConfigured();

      expect(manager._prelaunchChromium).toHaveBeenCalledOnce();
      expect(manager.ensureMinWorkingWindows).not.toHaveBeenCalled();
    });
  });

  describe("acquireSearchWindow", () => {
    it("acquires a pooled page and preserves the engine identity", async () => {
      const manager = new BrowserManager(makeConfig({ searchKeepMinWorkingWindows: 0 }));
      const page = { isClosed: () => false, on: vi.fn() };
      manager.ensureMinWorkingWindows = vi.fn();
      manager.newPage = vi.fn().mockResolvedValue(page);

      await manager.acquireSearchWindow("google");

      expect(manager.ensureMinWorkingWindows).toHaveBeenCalledWith("google", expect.any(Object));
      expect(manager.newPage).toHaveBeenCalledWith({ engine: "google" });
      expect(manager.getEnginePool("google").windows[0].page).toBe(page);
    });

    it("wakes a queued search when its pooled page closes", async () => {
      const manager = new BrowserManager(makeConfig({
        searchKeepMinWorkingWindows: 0,
        searchMaxWorkingWindows: 1
      }));
      const handlers = new Map();
      const firstPage = {
        isClosed: () => false,
        on: vi.fn((event, handler) => handlers.set(event, handler))
      };
      const replacementPage = { isClosed: () => false, on: vi.fn() };
      manager.newPage = vi.fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(replacementPage);

      await manager.acquireSearchWindow("google");
      const queued = manager.acquireSearchWindow("google");
      await Promise.resolve();
      handlers.get("close")();

      await expect(queued).resolves.toBe(replacementPage);
    });
  });

  describe("releaseSearchWindow", () => {
    it("closes the last pooled page when the retained minimum is zero", async () => {
      const manager = new BrowserManager(makeConfig({
        searchKeepMinWorkingWindows: 0,
        searchMaxWorkingWindows: 1
      }));
      const close = vi.fn().mockResolvedValue(undefined);
      const page = { isClosed: () => false, close };
      const pool = manager.getEnginePool("google");
      pool.windows.push({ page, inUse: true, pending: false, persistent: true, engine: "google" });

      await manager.releaseSearchWindow("google", page);

      expect(close).toHaveBeenCalledOnce();
      expect(pool.windows).toEqual([]);
    });
  });

  describe("page slot management", () => {
    it("acquirePageSlot increments when under max", async () => {
      const manager = new BrowserManager(makeConfig({ maxConcurrentPageOps: 5 }));
      await manager.acquirePageSlot();
      expect(manager.pageSlotsInUse).toBe(1);
    });

    it("releasePageSlot decrements and wakes waiters", () => {
      const manager = new BrowserManager(makeConfig());
      manager.pageSlotsInUse = 3;
      const waiter = vi.fn();
      manager.pageSlotWaiters.push(waiter);
      manager.releasePageSlot();
      expect(manager.pageSlotsInUse).toBe(2);
      expect(waiter).toHaveBeenCalled();
    });

    it("withPageSlot wraps task with acquire/release", async () => {
      const manager = new BrowserManager(makeConfig());
      const result = await manager.withPageSlot(() => "task-result");
      expect(result).toBe("task-result");
      expect(manager.pageSlotsInUse).toBe(0);
    });

    it("withPageSlot releases slot even on task failure", async () => {
      const manager = new BrowserManager(makeConfig());
      await expect(
        manager.withPageSlot(() => Promise.reject(new Error("task failed")))
      ).rejects.toThrow("task failed");
      expect(manager.pageSlotsInUse).toBe(0);
    });

    it("releasePageSlot does not go negative", () => {
      const manager = new BrowserManager(makeConfig());
      manager.releasePageSlot();
      expect(manager.pageSlotsInUse).toBe(0);
    });
  });

  describe("getHealth", () => {
    it("returns health object with browsers array", async () => {
      const config = makeConfig({
        browsers: [
          { name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false },
          { name: "lightpanda", role: ["fetch"], cdpUrl: "http://127.0.0.1:9222", addOn: true }
        ]
      });
      const manager = new BrowserManager(config);
      manager._newChromiumPage = vi.fn();
      const health = await manager.getHealth();
      expect(health).toHaveProperty("ok", true);
      expect(health).toHaveProperty("backend", "chromium");
      expect(health).toHaveProperty("browserConnected", false);
      expect(health.browsers).toHaveLength(1); // add-ons only; chromium is built-in
      expect(health.browsers[0]).toMatchObject({ name: "lightpanda", configured: true, connected: false, cdpUrl: "http://127.0.0.1:9222" });
      expect(health).toHaveProperty("searchWindows");
    });
  });

  describe("resolveBrowserParam", () => {
    it("serves an explicit add-on browser", async () => {
      const config = makeConfig({
        browsers: [
          { name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false },
          { name: "lightpanda", role: ["fetch"], cdpUrl: "http://127.0.0.1:9222", addOn: true }
        ]
      });
      const manager = new BrowserManager(config);
      const page = { id: "lp" };
      manager._connectAddOnPage = vi.fn().mockResolvedValue(page);
      const mod = await import("../src/browser.js");
      const result = await mod.resolveBrowserParam({ browser: "lightpanda" }, config, manager);
      expect(result).toMatchObject({ page, browser: "lightpanda", rollbackNotes: [] });
    });

    it("throws for an explicit unknown browser", async () => {
      const manager = new BrowserManager(makeConfig());
      const mod = await import("../src/browser.js");
      await expect(mod.resolveBrowserParam({ browser: "firefox" }, makeConfig(), manager)).rejects.toThrow(/unknown browser/);
    });

    it("rolls back add-ons in order then serves chromium when all are down", async () => {
      const config = makeConfig({
        browsers: [
          { name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false },
          { name: "lightpanda", role: ["fetch"], cdpUrl: "http://lp:9222", addOn: true },
          { name: "cb", role: ["fetch"], cdpUrl: "http://cb:9222", addOn: true }
        ]
      });
      const manager = new BrowserManager(config);
      const chPage = { id: "ch" };
      manager._connectAddOnPage = vi.fn().mockRejectedValue(new Error("down"));
      manager._newChromiumPage = vi.fn().mockResolvedValue(chPage);
      const mod = await import("../src/browser.js");
      const result = await mod.resolveBrowserParam({}, config, manager);
      expect(result).toMatchObject({ page: chPage, browser: "chromium" });
      expect(result.rollbackNotes).toEqual(["lightpanda: down", "cb: down"]);
    });

    it("honors role filtering for the rollback path", async () => {
      const config = makeConfig({
        browsers: [
          { name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false },
          { name: "cb", role: ["devtools"], cdpUrl: "http://cb:9222", addOn: true },
          { name: "fetch", role: ["fetch"], cdpUrl: "http://fetch:9222", addOn: true }
        ]
      });
      const manager = new BrowserManager(config);
      const chPage = { id: "ch" };
      manager._connectAddOnPage = vi.fn().mockRejectedValue(new Error("down"));
      manager._newChromiumPage = vi.fn().mockResolvedValue(chPage);
      const mod = await import("../src/browser.js");
      const result = await mod.resolveBrowserParam({}, config, manager, { roles: ["fetch"] });
      expect(result.rollbackNotes).toEqual(["fetch: down"]);
    });
  });

  describe("getBrowserManager singleton", () => {
    it("returns a BrowserManager instance", async () => {
      loadConfig.mockResolvedValue(makeConfig());
      const { getBrowserManager } = await import("../src/browser.js");
      const manager = await getBrowserManager();
      expect(manager instanceof BrowserManager).toBe(true);
    });

    it("caches the promise result", async () => {
      loadConfig.mockResolvedValue(makeConfig());
      const { getBrowserManager } = await import("../src/browser.js");
      const m1 = await getBrowserManager();
      const m2 = await getBrowserManager();
      expect(m1).toBe(m2);
    });
  });

  describe("getInstanceStats: relay browser tabs reach the cross-browser listing", () => {
    it("reports live registry tabs, not the empty status projection", async () => {
      const { relayServer } = await import("../src/relay-server.js");
      relayServer._entries.set("Chrome", {
        name: "Chrome", plugin: "auto", platform: "chrome", extensionVersion: "0.3.0",
        status: "connected", ws: { OPEN: 1, readyState: 1 }, connectedAt: 1787900000000,
        tabs: [
          { targetId: "T1", tabId: 11, url: "https://example.com/", title: "Example" },
          { targetId: "T2", tabId: 12, url: "about:blank", title: "Untitled" },
          { targetId: "T3", tabId: 13, url: "chrome-extension://abc/background.js", title: "Service Worker" },
          { targetId: "T4", tabId: 14, url: "chrome://omnibox-popup.top-chrome/", title: "Omnibox Popup" }
        ],
        tabIdToTarget: new Map(), clients: new Map(), tabWaiters: [],
        sessionForTarget: new Map(), extSessionToTarget: new Map(),
        lastActivity: Date.now()
      });
      try {
        const config = makeConfig({
          browsers: [
            { name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false },
            { name: "Chrome", role: ["default"], type: "navigator-cdp", plugin: "auto", addOn: true }
          ]
        });
        const manager = new BrowserManager(config);
        const stats = await manager.getInstanceStats();
        const chrome = stats.find((s) => s.backend === "Chrome");
        expect(chrome.connected).toBe(true);
        // Plugin windows / chrome-extension workers / about:blank hidden from display
        expect(chrome.tabs).toBe(1);
        expect(chrome.openTabs.map((t) => t.url)).toEqual(["https://example.com/"]);
        expect(chrome.extensionVersion).toBe("0.3.0");
      } finally {
        relayServer._entries.delete("Chrome");
      }
    });
  });
});
