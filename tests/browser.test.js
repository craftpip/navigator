import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("puppeteer-core", () => ({
  default: {
    launch: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(),
  findLightpandaPath: vi.fn(),
}));

vi.mock("cloakbrowser", () => ({}));
vi.mock("cloakbrowser/puppeteer", () => ({ launch: vi.fn() }));

function makeConfig(overrides = {}) {
  return {
    chromePath: "/usr/bin/chrome",
    chromeUserDataDir: "/data/chrome",
    chromeProfileDir: "Default",
    defaultBackend: "cloakbrowser",
    devtoolsBackend: "cloakbrowser",
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
    lightpandaPath: null,
    lightpandaPort: 1997,
    cloakbrowserPath: null,
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
      expect(manager.lightpandaProcess).toBeNull();
      expect(manager.lightpandaBrowser).toBeNull();
      expect(manager.lightpandaLaunching).toBeNull();
      expect(manager.cloakbrowserBrowser).toBeNull();
      expect(manager.cloakbrowserLaunching).toBeNull();
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
      expect(pool).toHaveProperty("waiters");
      expect(Array.isArray(pool.waiters)).toBe(true);
      expect(pool.waiters.length).toBe(0);
    });

    it("returns same pool for same engine", () => {
      const manager = new BrowserManager(makeConfig());
      const pool1 = manager.getEnginePool("google");
      const pool2 = manager.getEnginePool("google");
      expect(pool1).toBe(pool2);
    });

    it("normalizes engine key", () => {
      const manager = new BrowserManager(makeConfig());
      const pool1 = manager.getEnginePool("  GOOGLE  ");
      const pool2 = manager.getEnginePool("google");
      expect(pool1).toBe(pool2);
    });

    it("uses 'default' for empty engine", () => {
      const manager = new BrowserManager(makeConfig());
      const pool = manager.getEnginePool("");
      expect(pool.engine).toBe("default");
    });

    it("tracks separate pools for different engines", () => {
      const manager = new BrowserManager(makeConfig());
      const pool1 = manager.getEnginePool("google");
      const pool2 = manager.getEnginePool("bing");
      expect(pool1).not.toBe(pool2);
      expect(manager.engineWorkingWindows.size).toBe(2);
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

    it("includes stats for specific engine when scoped", () => {
      const manager = new BrowserManager(makeConfig());
      // Add a window to the pool
      const pool = manager.getEnginePool("google");
      pool.windows.push({
        page: { isClosed: () => false },
        inUse: true,
        pending: false,
        engine: "google",
      });
      const stats = manager.buildWindowStats("google");
      expect(stats.totalOpen).toBe(1);
      expect(stats.totalInUse).toBe(1);
      expect(stats.byEngine["google"].open).toBe(1);
      expect(stats.byEngine["google"].inUse).toBe(1);
    });

    it("prunes closed windows before counting", () => {
      const manager = new BrowserManager(makeConfig());
      const pool = manager.getEnginePool("test");
      pool.windows.push(
        { page: { isClosed: () => true }, inUse: false, pending: false, engine: "test" },
        { page: { isClosed: () => false }, inUse: false, pending: false, engine: "test" }
      );
      const stats = manager.buildWindowStats("test");
      expect(stats.totalOpen).toBe(1);
      expect(stats.byEngine["test"].open).toBe(1);
    });
  });

  describe("pruneClosedWindows", () => {
    it("removes closed windows from pool", () => {
      const manager = new BrowserManager(makeConfig());
      const pool = manager.getEnginePool("test");
      const closedPage = { isClosed: () => true };
      const openPage = { isClosed: () => false };
      pool.windows.push(
        { page: closedPage, inUse: false, pending: false },
        { page: openPage, inUse: false, pending: false }
      );
      manager.pruneClosedWindows(pool);
      expect(pool.windows.length).toBe(1);
      expect(pool.windows[0].page).toBe(openPage);
    });

    it("keeps pending entries even without page", () => {
      const manager = new BrowserManager(makeConfig());
      const pool = manager.getEnginePool("test");
      pool.windows.push(
        { page: null, inUse: false, pending: true },
        { page: { isClosed: () => false }, inUse: false, pending: false }
      );
      manager.pruneClosedWindows(pool);
      expect(pool.windows.length).toBe(2);
    });

    it("handles empty pool gracefully", () => {
      const manager = new BrowserManager(makeConfig());
      const pool = manager.getEnginePool("test");
      manager.pruneClosedWindows(pool);
      expect(pool.windows.length).toBe(0);
    });
  });

  describe("trimIdleWindows", () => {
    it("removes idle windows above keepCount", async () => {
      const manager = new BrowserManager(makeConfig({ searchKeepMinWorkingWindows: 1 }));
      const pool = manager.getEnginePool("test");
      const closeFn = vi.fn();
      pool.windows.push(
        { page: { isClosed: () => false, close: closeFn }, inUse: false, pending: false },
        { page: { isClosed: () => false, close: closeFn }, inUse: false, pending: false },
        { page: { isClosed: () => false, close: closeFn }, inUse: false, pending: false }
      );
      await manager.trimIdleWindows(pool, 1);
      expect(pool.windows.length).toBe(1);
      expect(closeFn).toHaveBeenCalledTimes(2);
    });

    it("does not remove in-use windows", async () => {
      const manager = new BrowserManager(makeConfig({ searchKeepMinWorkingWindows: 1 }));
      const pool = manager.getEnginePool("test");
      const closeFn = vi.fn();
      pool.windows.push(
        { page: { isClosed: () => false, close: closeFn }, inUse: true, pending: false },
        { page: { isClosed: () => false, close: closeFn }, inUse: false, pending: false }
      );
      await manager.trimIdleWindows(pool, 1);
      expect(pool.windows.length).toBe(1);
      expect(pool.windows[0].inUse).toBe(true);
    });

    it("handles empty pool", async () => {
      const manager = new BrowserManager(makeConfig());
      const pool = manager.getEnginePool("test");
      await manager.trimIdleWindows(pool, 5);
      expect(pool.windows.length).toBe(0);
    });
  });

  describe("buildLaunchArgs", () => {
    it("returns array of Chrome arguments", () => {
      const manager = new BrowserManager(makeConfig());
      const args = manager.buildLaunchArgs("Default");
      expect(Array.isArray(args)).toBe(true);
      expect(args).toContain("--no-sandbox");
      expect(args).toContain("--disable-setuid-sandbox");
      expect(args).toContain("--disable-dev-shm-usage");
      expect(args).toContain("--disable-blink-features=AutomationControlled");
      expect(args).toContain("--disable-gpu");
      expect(args).toContain("--no-first-run");
      expect(args).toContain("--no-default-browser-check");
      expect(args).toContain("--window-size=1920,1080");
    });

    it("includes profile directory argument", () => {
      const manager = new BrowserManager(makeConfig());
      const args = manager.buildLaunchArgs("Profile2");
      expect(args).toContain("--profile-directory=Profile2");
    });
  });

  describe("_poolEngine", () => {
    it("returns engine name for engine-pool engines", () => {
      const manager = new BrowserManager(makeConfig({ defaultBackend: "cloakbrowser" }));
      expect(manager._poolEngine("duckduckgo")).toBe("duckduckgo");
      expect(manager._poolEngine("google")).toBe("google");
      expect(manager._poolEngine("brave")).toBe("brave");
      expect(manager._poolEngine("startpage")).toBe("startpage");
      expect(manager._poolEngine("yahoo")).toBe("yahoo");
    });

    it("returns _shared for shared-pool engines", () => {
      const manager = new BrowserManager(makeConfig({ defaultBackend: "cloakbrowser" }));
      expect(manager._poolEngine("bing")).toBe("_shared");
      expect(manager._poolEngine("mojeek")).toBe("_shared");
    });

    it("returns engine key for unknown engine with cloakbrowser default", () => {
      const manager = new BrowserManager(makeConfig({ defaultBackend: "cloakbrowser" }));
      const result = manager._poolEngine("some_engine");
      expect(result).toBe("some_engine");
    });

    it("returns _shared for unknown engine with non-chromium default", () => {
      const manager = new BrowserManager(makeConfig({ defaultBackend: "lightpanda" }));
      expect(manager._poolEngine("some_engine")).toBe("_shared");
    });

    it("returns engine name for unknown engine with chromium default", () => {
      const manager = new BrowserManager(makeConfig({ defaultBackend: "chromium" }));
      expect(manager._poolEngine("some_engine")).toBe("some_engine");
    });
  });

  describe("newPage engine dispatch", () => {
    it("uses provided backend option", async () => {
      const manager = new BrowserManager(makeConfig());
      const pages = {
        cloakbrowser: { id: "cb" },
        chromium: { id: "ch" },
        lightpanda: { id: "lp" },
      };
      manager._newCloakbrowserPage = vi.fn().mockResolvedValue(pages.cloakbrowser);
      manager._newChromiumPage = vi.fn().mockResolvedValue(pages.chromium);
      manager._newLightpandaPage = vi.fn().mockResolvedValue(pages.lightpanda);

      await expect(manager.newPage({ backend: "cloakbrowser" })).resolves.toBe(pages.cloakbrowser);
      await expect(manager.newPage({ backend: "chromium" })).resolves.toBe(pages.chromium);
      await expect(manager.newPage({ backend: "lightpanda" })).resolves.toBe(pages.lightpanda);
    });

    it("falls back to defaultBackend when no backend option", async () => {
      const manager = new BrowserManager(makeConfig({ defaultBackend: "chromium" }));
      const page = { id: "ch" };
      manager._newChromiumPage = vi.fn().mockResolvedValue(page);

      await expect(manager.newPage({})).resolves.toBe(page);
      await expect(manager._newChromiumPage).toHaveBeenCalledOnce();
    });
  });

  describe("backend isolation", () => {
    it("does not fall back to Chromium when Lightpanda is unavailable", async () => {
      const manager = new BrowserManager(makeConfig());
      manager.getLightpandaBrowser = vi.fn().mockResolvedValue(null);
      manager._newChromiumPage = vi.fn();

      await expect(manager._newLightpandaPage()).rejects.toThrow("Lightpanda is unavailable");
      expect(manager._newChromiumPage).not.toHaveBeenCalled();
    });

    it("uses the validated CloakBrowser binary path for launch", async () => {
      const manager = new BrowserManager(makeConfig({ cloakbrowserPath: "/valid/cloakbrowser" }));
      const { launch } = await import("cloakbrowser/puppeteer");
      const originalPath = process.env.CLOAKBROWSER_BINARY_PATH;
      const browser = { connected: true, on: vi.fn() };
      launch.mockResolvedValue(browser);

      await expect(manager.getCloakbrowserBrowser()).resolves.toBe(browser);
      expect(process.env.CLOAKBROWSER_BINARY_PATH).toBe("/valid/cloakbrowser");

      if (originalPath === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH;
      else process.env.CLOAKBROWSER_BINARY_PATH = originalPath;
    });
  });

  describe("prelaunch", () => {
    it("starts only the configured default backend and warms browser routes", async () => {
      const manager = new BrowserManager(makeConfig({
        defaultBackend: "cloakbrowser",
        searchRouteWarmupEngines: ["google", "bing"]
      }));
      manager.getCloakbrowserBrowser = vi.fn().mockResolvedValue({});
      manager.getBrowser = vi.fn();
      manager.ensureMinWorkingWindows = vi.fn().mockResolvedValue(undefined);

      await manager.prelaunchIfConfigured();

      expect(manager.getCloakbrowserBrowser).toHaveBeenCalledOnce();
      expect(manager.getBrowser).not.toHaveBeenCalled();
      expect(manager.ensureMinWorkingWindows).toHaveBeenCalledWith(
        "google",
        expect.objectContaining({ reason: "warmup" })
      );
      expect(manager.ensureMinWorkingWindows).toHaveBeenCalledWith(
        "bing",
        expect.objectContaining({ reason: "warmup" })
      );
    });
  });

  describe("_poolMaxWindows", () => {
    it("returns 1 for shared pool with non-chromium backend", () => {
      const manager = new BrowserManager(makeConfig({ defaultBackend: "cloakbrowser", searchMaxWorkingWindows: 10 }));
      expect(manager._poolMaxWindows("_shared")).toBe(1);
    });

    it("returns searchMaxWorkingWindows for non-shared pool", () => {
      const manager = new BrowserManager(makeConfig({ searchMaxWorkingWindows: 10 }));
      expect(manager._poolMaxWindows("google")).toBe(10);
    });

    it("keeps the Lightpanda shared pool to one page with chromium", () => {
      const manager = new BrowserManager(makeConfig({ defaultBackend: "chromium", searchMaxWorkingWindows: 10 }));
      expect(manager._poolMaxWindows("_shared")).toBe(1);
    });
  });

  describe("Lightpanda lifecycle", () => {
    it("clears stale shared pages and wakes queued searches on disconnect", () => {
      const manager = new BrowserManager(makeConfig());
      const pool = manager.getEnginePool("_shared");
      const waiter = vi.fn();
      pool.windows.push({ page: { isClosed: () => false }, inUse: true, pending: false });
      pool.waiters.push(waiter);
      const handlers = new Map();
      const browser = { on: vi.fn((event, handler) => handlers.set(event, handler)) };
      manager.lightpandaBrowser = browser;

      manager._watchLightpandaBrowser(browser);
      handlers.get("disconnected")();

      expect(manager.lightpandaBrowser).toBeNull();
      expect(pool.windows).toEqual([]);
      expect(waiter).toHaveBeenCalledOnce();
    });
  });

  describe("acquireSearchWindow", () => {
    it("preserves the engine while using its shared pool", async () => {
      const manager = new BrowserManager(makeConfig({ searchKeepMinWorkingWindows: 0 }));
      const page = { isClosed: () => false, on: vi.fn() };
      manager.ensureMinWorkingWindows = vi.fn();
      manager.newPage = vi.fn().mockResolvedValue(page);

      await manager.acquireSearchWindow("bing");

      expect(manager.ensureMinWorkingWindows).toHaveBeenCalledWith(
        "bing",
        expect.any(Object)
      );
      expect(manager.newPage).toHaveBeenCalledWith({ engine: "bing" });
      expect(manager.getEnginePool("_shared").windows[0].page).toBe(page);
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

    it("wakes a queued search when the first page creation fails", async () => {
      const manager = new BrowserManager(makeConfig({
        searchKeepMinWorkingWindows: 0,
        searchMaxWorkingWindows: 1
      }));
      const replacementPage = { isClosed: () => false, on: vi.fn() };
      manager.newPage = vi.fn()
        .mockRejectedValueOnce(new Error("browser unavailable"))
        .mockResolvedValueOnce(replacementPage);

      const first = manager.acquireSearchWindow("google");
      const queued = manager.acquireSearchWindow("google");

      await expect(first).rejects.toThrow("browser unavailable");
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

  describe("relaunchDefaultBackend", () => {
    it("keeps pools belonging to other browser backends", async () => {
      const manager = new BrowserManager(makeConfig({ defaultBackend: "cloakbrowser" }));
      const lightpandaPool = manager.getEnginePool("_shared");
      lightpandaPool.windows.push({ backend: "lightpanda", page: { isClosed: () => false } });
      manager.cloakbrowserBrowser = { close: vi.fn().mockResolvedValue(undefined) };
      manager.getCloakbrowserBrowser = vi.fn().mockResolvedValue({ connected: true });

      await manager.relaunchDefaultBackend(false);

      expect(lightpandaPool.windows).toHaveLength(1);
    });

    it("relaunches an active graphical search backend when the default is Lightpanda", async () => {
      const manager = new BrowserManager(makeConfig({ defaultBackend: "lightpanda", devtoolsBackend: "cloakbrowser" }));
      const cloakPool = manager.getEnginePool("google");
      cloakPool.windows.push({ backend: "cloakbrowser", page: { isClosed: () => false } });
      const previousBrowser = { close: vi.fn().mockResolvedValue(undefined) };
      manager.cloakbrowserBrowser = previousBrowser;
      manager.getCloakbrowserBrowser = vi.fn().mockResolvedValue({ connected: true });

      const result = await manager.relaunchDefaultBackend(false);

      expect(previousBrowser.close).toHaveBeenCalled();
      expect(manager.getCloakbrowserBrowser).toHaveBeenCalled();
      expect(result).toMatchObject({ headless: false, relaunched: true, backends: ["cloakbrowser"] });
      expect(cloakPool.windows).toHaveLength(0);
    });
  });

  describe("ensureMinWorkingWindows", () => {
    it("keeps the Lightpanda route identity while using the shared pool", async () => {
      const manager = new BrowserManager(makeConfig({
        defaultBackend: "lightpanda",
        searchKeepMinWorkingWindows: 1
      }));
      const page = { isClosed: () => false, on: vi.fn(), goto: vi.fn() };
      manager.newPage = vi.fn().mockResolvedValue(page);

      await manager.ensureMinWorkingWindows("bing");

      expect(manager.newPage).toHaveBeenCalledWith({ engine: "bing" });
      expect(manager.getEnginePool("_shared").windows).toHaveLength(1);
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

    it("acquirePageSlot queues when at max", async () => {
      const manager = new BrowserManager(makeConfig({ maxConcurrentPageOps: 1 }));
      await manager.acquirePageSlot();
      expect(manager.pageSlotsInUse).toBe(1);

      // Second acquire should wait
      const acquirePromise = manager.acquirePageSlot();
      expect(manager.pageSlotWaiters.length).toBe(1);

      // Release to unblock
      manager.releasePageSlot();
      await acquirePromise;
      expect(manager.pageSlotsInUse).toBe(1);
    });

    it("removes an aborted waiter without consuming a slot", async () => {
      const manager = new BrowserManager(makeConfig({ maxConcurrentPageOps: 1 }));
      await manager.acquirePageSlot();
      const controller = new AbortController();

      const queued = manager.acquirePageSlot({ signal: controller.signal });
      const assertion = expect(queued).rejects.toThrow("slot deadline");
      expect(manager.pageSlotWaiters).toHaveLength(1);

      controller.abort(new Error("slot deadline"));
      await assertion;

      expect(manager.pageSlotWaiters).toHaveLength(0);
      expect(manager.pageSlotsInUse).toBe(1);
      manager.releasePageSlot();
      expect(manager.pageSlotsInUse).toBe(0);
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

    it("releases an active slot when its task is aborted", async () => {
      const manager = new BrowserManager(makeConfig({ maxConcurrentPageOps: 1 }));
      const controller = new AbortController();
      const pending = manager.withPageSlot(
        () => new Promise(() => {}),
        { signal: controller.signal }
      );
      const assertion = expect(pending).rejects.toThrow("operation deadline");

      await Promise.resolve();
      expect(manager.pageSlotsInUse).toBe(1);
      controller.abort(new Error("operation deadline"));
      await assertion;

      expect(manager.pageSlotsInUse).toBe(0);
      await expect(manager.withPageSlot(() => "next task")).resolves.toBe("next task");
      expect(manager.pageSlotsInUse).toBe(0);
    });

    it("releasePageSlot does not go negative", () => {
      const manager = new BrowserManager(makeConfig());
      manager.releasePageSlot();
      expect(manager.pageSlotsInUse).toBe(0);
    });

    it("honors a lower runtime concurrency cap before waking queued work", async () => {
      const manager = new BrowserManager(makeConfig({ maxConcurrentPageOps: 3 }));
      await manager.acquirePageSlot();
      await manager.acquirePageSlot();
      await manager.acquirePageSlot();
      manager.config.maxConcurrentPageOps = 1;

      const queued = manager.acquirePageSlot();
      manager.releasePageSlot();
      await Promise.resolve();
      expect(manager.pageSlotsInUse).toBe(2);

      manager.releasePageSlot();
      await Promise.resolve();
      expect(manager.pageSlotsInUse).toBe(1);

      manager.releasePageSlot();
      await queued;
      expect(manager.pageSlotsInUse).toBe(1);
    });
  });

  describe("getHealth", () => {
    it("returns health object with correct structure", async () => {
      const manager = new BrowserManager(makeConfig());
      const health = await manager.getHealth();
      expect(health).toHaveProperty("ok", true);
      expect(health).toHaveProperty("backend", "cloakbrowser");
      expect(health).toHaveProperty("browserConnected", false);
      expect(health).toHaveProperty("lightpandaConnected", false);
      expect(health).toHaveProperty("cloakbrowserConnected", false);
      expect(health).toHaveProperty("headless", true);
      expect(health).toHaveProperty("enableDevtoolsMcp", false);
      expect(health).toHaveProperty("userDataDir", "/data/chrome");
      expect(health).toHaveProperty("profileDir", "Default");
      expect(health).toHaveProperty("searchWindows");
      expect(health.searchWindows).toHaveProperty("total", 0);
      expect(health.searchWindows).toHaveProperty("byEngine");
      expect(typeof health.searchWindows.byEngine).toBe("object");
      expect(health).toHaveProperty("pageLimiter");
      expect(health.pageLimiter).toHaveProperty("inUse", 0);
      expect(health.pageLimiter).toHaveProperty("queued", 0);
      expect(health.pageLimiter).toHaveProperty("maxConcurrentPageOps", 30);
    });

    it("includes pool stats per engine", async () => {
      const manager = new BrowserManager(makeConfig());
      const pool = manager.getEnginePool("google");
      pool.windows.push({
        page: { isClosed: () => false },
        inUse: true,
        pending: false,
        persistent: true,
        engine: "google",
      });
      const health = await manager.getHealth();
      expect(health.searchWindows.total).toBe(1);
      expect(health.searchWindows.byEngine["google"]).toBeDefined();
      expect(health.searchWindows.byEngine["google"].total).toBe(1);
      expect(health.searchWindows.byEngine["google"].inUse).toBe(1);
    });
  });

  describe("getInstanceStats", () => {
    it("returns one entry per backend", async () => {
      const manager = new BrowserManager(makeConfig());
      const stats = await manager.getInstanceStats();
      expect(stats).toHaveLength(3);
      expect(stats.map((s) => s.backend).sort()).toEqual(["chromium", "cloakbrowser", "lightpanda"]);
    });

    it("reports zeroed state when nothing is launched", async () => {
      const manager = new BrowserManager(makeConfig());
      const stats = await manager.getInstanceStats();
      for (const entry of stats) {
        expect(entry.connected).toBe(false);
        expect(entry.tabs).toBe(0);
        expect(entry.pid).toBeNull();
        expect(entry.spawns).toBe(0);
      }
    });

    it("counts tabs from non-closed pages", async () => {
      const manager = new BrowserManager(makeConfig());
      manager.cloakbrowserBrowser = {
        connected: true,
        pages: async () => [
          { isClosed: () => false, url: () => "https://one.example" },
          { isClosed: () => false, url: () => "https://two.example" },
          { isClosed: () => true, url: () => "https://closed.example" },
        ],
        process: () => ({ pid: 99 }),
      };
      const stats = await manager.getInstanceStats();
      const cloak = stats.find((s) => s.backend === "cloakbrowser");
      expect(cloak).toMatchObject({ connected: true, tabs: 2, pid: 99 });
    });
  });

  describe("getBrowserManager singleton", () => {
    it("returns a BrowserManager instance", async () => {
      const { loadConfig } = await import("../src/config.js");
      loadConfig.mockResolvedValue(makeConfig());

      const { getBrowserManager } = await import("../src/browser.js");
      vi.resetModules();
      const manager = await getBrowserManager();
      expect(manager instanceof BrowserManager).toBe(true);
    });

    it("caches the promise result", async () => {
      const { loadConfig } = await import("../src/config.js");
      loadConfig.mockResolvedValue(makeConfig());

      const { getBrowserManager } = await import("../src/browser.js");
      const m1 = await getBrowserManager();
      const m2 = await getBrowserManager();
      expect(m1).toBe(m2);
    });
  });
});
