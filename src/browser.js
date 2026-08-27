import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { loadConfig } from "./config.js";
import { getBrowserWarmupEngines, getEngineMetadata } from "./engines/index.js";
import { getTabTimings } from "./tab-timers.js";

const LOCK_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
const CLONE_EXCLUDE_NAMES = new Set([
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "lockfile",
  "DevToolsActivePort"
]);
const CLONE_EXCLUDE_DIRS = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "Crashpad"
]);
const MONITOR_WIDTH = 1920;
const MONITOR_HEIGHT = 1080;

const BROWSER_LOG_EMOJI = {
  "addon.connected": "🔌",
  "addon.disconnected": "🔌",
  "search.window.opened": "🪟",
  "search.window.closed": "🔒",
  "search.warmup.ready": "✅",
  "chromium.prelaunch.ready": "✅",
  "chromium.ready": "✅"
};

const BROWSER_LOG_LABEL = {
  "addon.connected": "Add-on Connected",
  "addon.disconnected": "Add-on Disconnected",
  "search.window.opened": "Window Opened",
  "search.window.closed": "Window Closed",
  "search.warmup.ready": "Search Windows Warmed",
  "chromium.prelaunch.ready": "Chromium Ready",
  "chromium.ready": "Chromium Ready"
};

const BROWSER_LOG_FMT = {
  "search.window.opened":  (p) => `${p?.engine || "?"}  (${p?.reason || "?"})`,
  "search.window.closed":  (p) => `${p?.engine || "?"}  (${p?.reason || "?"})`,
  "search.warmup.ready":  (p) => `${p?.engines?.length || 0} engines`,
  "chromium.prelaunch.ready": () => "",
  "chromium.ready": () => ""
};

function logBrowserEvent(label, payload) {
  const emoji = BROWSER_LOG_EMOJI[label] || "●";
  const readable = BROWSER_LOG_LABEL[label] || label;
  const fmt = BROWSER_LOG_FMT[label];

  if (fmt) {
    const extra = fmt(payload || {});
    console.error(`${emoji}  ${readable}${extra ? "  " + extra : ""}`);
    return;
  }

  if (!payload || typeof payload !== "object") {
    const suffix = payload === undefined ? "" : `  ${String(payload)}`;
    console.error(`${emoji}  ${readable}${suffix}`);
    return;
  }

  const extra = Object.entries(payload)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  console.error(`${emoji}  ${readable}${extra ? "  " + extra : ""}`);
}

function isLockError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("singleton") ||
    message.includes("already in use") ||
    message.includes("profile") ||
    message.includes("processsingleton") ||
    message.includes("lock")
  );
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removeIfExists(targetPath) {
  if (await fileExists(targetPath)) {
    await fs.rm(targetPath, { force: true, recursive: true });
  }
}

export class BrowserManager {
  constructor(config) {
    this.config = config;

    // Chromium (the only built-in browser)
    this.browser = null;
    this.launching = null;
    this.tempProfileDir = null;
    this.keepAlivePage = null;
    this.prelaunchPromise = null;

    // Add-on browser state (keyed by `addon_${name}`) — lazy CDP connections
    this._addOnState = new Map();

    // Shared
    this.engineWorkingWindows = new Map();
    this.pageSlotsInUse = 0;
    this.pageSlotWaiters = [];

    // Cumulative spawn counters (in-memory, reset on restart)
    this.instanceSpawns = { chromium: 0 };
  }

  async ensureKeepAlivePage(browser) {
    const activeBrowser = browser || (await this.getBrowser());

    if (this.keepAlivePage && !this.keepAlivePage.isClosed()) {
      return this.keepAlivePage;
    }

    const pages = await activeBrowser.pages();
    const existing = pages.find((item) => !item.isClosed());
    if (existing) {
      this.keepAlivePage = existing;
      return existing;
    }

    const page = await this.createWindowPage(activeBrowser);
    await page.goto(this.config.startupUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.config.browserOpTimeoutMs
    });
    this.keepAlivePage = page;
    return page;
  }

  async acquirePageSlot({ signal } = {}) {
    if (signal?.aborted) {
      throw signal.reason || new Error("Page slot acquisition aborted");
    }
    if (this.pageSlotsInUse < this.config.maxConcurrentPageOps) {
      this.pageSlotsInUse += 1;
      return;
    }

    await new Promise((resolve, reject) => {
      const waiter = {
        settled: false,
        grant: () => {
          if (waiter.settled || signal?.aborted) return false;
          waiter.settled = true;
          signal?.removeEventListener("abort", onAbort);
          this.pageSlotsInUse += 1;
          resolve();
          return true;
        }
      };
      const onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.pageSlotWaiters.indexOf(waiter);
        if (index !== -1) this.pageSlotWaiters.splice(index, 1);
        reject(signal.reason || new Error("Page slot acquisition aborted"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      this.pageSlotWaiters.push(waiter);
      if (signal?.aborted) onAbort();
    });
  }

  grantPageSlotWaiters() {
    while (this.pageSlotsInUse < this.config.maxConcurrentPageOps && this.pageSlotWaiters.length) {
      const next = this.pageSlotWaiters.shift();
      if (typeof next === "function") {
        next();
        break;
      }
      next?.grant?.();
    }
  }

  releasePageSlot() {
    if (this.pageSlotsInUse > 0) {
      this.pageSlotsInUse -= 1;
    }

    this.grantPageSlotWaiters();
  }

  async withPageSlot(task, { signal } = {}) {
    await this.acquirePageSlot({ signal });
    let onAbort;
    try {
      if (!signal) return await task();
      if (signal.aborted) throw signal.reason || new Error("Page operation aborted");

      const abortPromise = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason || new Error("Page operation aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      const taskPromise = Promise.resolve().then(task);
      return await Promise.race([taskPromise, abortPromise]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      this.releasePageSlot();
    }
  }

  getEnginePool(engine) {
    const key = String(engine || "").trim().toLowerCase() || "default";
    let pool = this.engineWorkingWindows.get(key);
    if (!pool) {
      pool = { engine: key, windows: [], waiters: [] };
      this.engineWorkingWindows.set(key, pool);
    }
    return pool;
  }

  wakeSearchWaiter(pool) {
    const next = pool?.waiters.shift();
    if (next) next();
  }

  clearSearchWindows() {
    // All search windows pool on Chromium; a browser disconnect invalidates them all.
    for (const pool of this.engineWorkingWindows.values()) {
      const hadWindows = pool.windows.length > 0;
      pool.windows = [];
      if (hadWindows) this.wakeSearchWaiter(pool);
    }
  }

  buildWindowStats(engine) {
    const scoped = engine ? this.getEnginePool(engine) : null;
    if (scoped) {
      this.pruneClosedWindows(scoped);
    }

    const byEngine = {};
    let totalOpen = 0;
    let totalInUse = 0;
    let totalPending = 0;
    let totalWaiters = 0;

    for (const [name, pool] of this.engineWorkingWindows.entries()) {
      this.pruneClosedWindows(pool);
      const open = pool.windows.length;
      const inUse = pool.windows.filter((entry) => entry.inUse).length;
      const pending = pool.windows.filter((entry) => entry.pending).length;
      const waiters = pool.waiters.length;
      byEngine[name] = { open, inUse, pending, waiters };
      totalOpen += open;
      totalInUse += inUse;
      totalPending += pending;
      totalWaiters += waiters;
    }

    return {
      totalOpen,
      totalInUse,
      totalPending,
      totalWaiters,
      byEngine,
      pageSlots: {
        inUse: this.pageSlotsInUse,
        queued: this.pageSlotWaiters.length,
        max: this.config.maxConcurrentPageOps
      }
    };
  }

  logWindowEvent(label, engine, extra = {}) {
    logBrowserEvent(label, {
      engine,
      ...extra,
      stats: this.buildWindowStats()
    });
  }

  pruneClosedWindows(pool) {
    pool.windows = pool.windows.filter(
      (entry) => entry?.pending || (entry?.page && !entry.page.isClosed())
    );
  }

  async trimIdleWindows(pool, keepCount) {
    this.pruneClosedWindows(pool);

    while (pool.windows.length > keepCount) {
      const idle = pool.windows.find((entry) => !entry.pending && !entry.inUse);
      if (!idle) break;

      pool.windows = pool.windows.filter((entry) => entry !== idle);
      try {
        if (idle.page && !idle.page.isClosed()) {
          await idle.page.close();
          this.logWindowEvent("search.window.closed", pool.engine, { reason: "trim_idle", persistent: Boolean(idle.persistent) });
        }
      } catch {
        // ignore window close errors
      }
    }
  }

  async ensureProfileBase() {
    await fs.mkdir(this.config.chromeUserDataDir, { recursive: true });
  }

  async clearKnownLockFiles(userDataDir) {
    const profileDirPath = path.join(userDataDir, this.config.chromeProfileDir);
    for (const lockFile of LOCK_FILES) {
      await removeIfExists(path.join(userDataDir, lockFile));
      await removeIfExists(path.join(profileDirPath, lockFile));
    }
  }

  async cloneProfileDir(sourceDir) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-profile-clone-"));
    await fs.cp(sourceDir, tempDir, {
      recursive: true,
      force: true,
      filter: (src) => {
        const base = path.basename(src);
        if (CLONE_EXCLUDE_NAMES.has(base)) return false;
        if (CLONE_EXCLUDE_DIRS.has(base)) return false;
        return true;
      }
    });

    if (this.config.chromeProfileDir !== "Default") {
      const sourceProfilePath = path.join(tempDir, this.config.chromeProfileDir);
      const defaultProfilePath = path.join(tempDir, "Default");
      if (await fileExists(sourceProfilePath)) {
        await fs.rm(defaultProfilePath, { recursive: true, force: true });
        await fs.cp(sourceProfilePath, defaultProfilePath, { recursive: true, force: true });
      }
    }

    return tempDir;
  }

  buildLaunchArgs(profileDir) {
    return [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${MONITOR_WIDTH},${MONITOR_HEIGHT}`,
      `--profile-directory=${profileDir}`
    ];
  }

  async launchBrowser(userDataDir, profileDir = this.config.chromeProfileDir) {
    const browser = await puppeteer.launch({
      executablePath: this.config.chromePath,
      headless: this.config.headless,
      userDataDir,
      args: this.buildLaunchArgs(profileDir),
      defaultViewport: {
        width: MONITOR_WIDTH,
        height: MONITOR_HEIGHT,
        deviceScaleFactor: 1
      },
      timeout: this.config.browserOpTimeoutMs
    });

    try {
      await this.ensureKeepAlivePage(browser);
    } catch {
      // ignore initial page setup errors
    }

    browser.on("disconnected", () => {
      this.browser = null;
      this.launching = null;
      this.clearSearchWindows();
      this.keepAlivePage = null;
      this.prelaunchPromise = null;
    });

    logBrowserEvent("chromium.ready", { reason: "on_demand" });
    return browser;
  }

  async launchWithRecovery() {
    await this.ensureProfileBase();

    try {
      return await this.launchBrowser(this.config.chromeUserDataDir);
    } catch (firstError) {
      if (!isLockError(firstError)) throw firstError;

      await this.clearKnownLockFiles(this.config.chromeUserDataDir);

      try {
        return await this.launchBrowser(this.config.chromeUserDataDir);
      } catch (secondError) {
        if (!isLockError(secondError)) throw secondError;

        const clonedDir = await this.cloneProfileDir(this.config.chromeUserDataDir);
        this.tempProfileDir = clonedDir;
        return this.launchBrowser(clonedDir, "Default");
      }
    }
  }

  async getBrowser() {
    if (this.browser && this.browser.connected) return this.browser;
    if (this.launching) return this.launching;

    console.error("⏳  Starting Chromium...");
    this.launching = this.launchWithRecovery();

    try {
      this.browser = await this.launching;
      this.instanceSpawns.chromium += 1;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  async createWindowPage(browser) {
    let lastError;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let session = null;

      try {
        const pages = await browser.pages();
        const openerPage =
          (this.keepAlivePage && !this.keepAlivePage.isClosed() && this.keepAlivePage) ||
          pages.find((page) => !page.isClosed()) ||
          null;
        const openerTarget = openerPage ? openerPage.target() : browser.target();
        session = await openerTarget.createCDPSession();
        const created = await session.send("Target.createTarget", {
          url: "about:blank",
          newWindow: true
        });
        const expectedTargetId = String(created?.targetId || "");
        if (!expectedTargetId) {
          throw new Error("Browser target is not found");
        }

        const deadline = Date.now() + Math.min(this.config.browserOpTimeoutMs, 20000);
        while (Date.now() < deadline) {
          const targets = browser.targets().filter((candidate) => candidate.type() === "page");
          for (const target of targets) {
            const targetId = String(target?._targetId || target?._targetInfo?.targetId || "");
            if (targetId !== expectedTargetId) continue;

            const page = await target.page();
            if (page && !page.isClosed()) {
              return page;
            }
          }

          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        throw new Error("Browser target is not found");
      } catch (error) {
        lastError = error;
      } finally {
        if (session) {
          try {
            await session.detach();
          } catch {
            // ignore session detach errors
          }
        }
      }
    }

    throw lastError || new Error("Browser target is not found");
  }

  _findAddOnByName(name) {
    if (!name || !this.config.browsers) return null;
    return this.config.browsers.find((b) => b.addOn && b.name === name) || null;
  }

  async _connectAddOnPage(addOnEntry) {
    const stateKey = `addon_${addOnEntry.name}`;
    let state = this._addOnState.get(stateKey);

    // Reuse existing connection if alive
    if (state?.browser?.connected) {
      return state.browser.newPage();
    }

    // Connect to external CDP - no launch logic, the user owns the process.
    // HTTP(S) cdpUrls are CDP servers (e.g. CloakBrowser's cloakserve, Chrome
    // --remote-debugging-port) — puppeteer resolves /json/version via browserURL.
    // ws:// cdpUrls are direct browser WebSocket endpoints (puppeteer-connected).
    const usesHttp = /^https?:\/\//i.test(String(addOnEntry.cdpUrl || ""));
    const browser = await puppeteer.connect({
      defaultViewport: { width: MONITOR_WIDTH, height: MONITOR_HEIGHT },
      ...(usesHttp
        ? { browserURL: addOnEntry.cdpUrl }
        : { browserWSEndpoint: addOnEntry.cdpUrl }),
    });

    // Store state (disconnect-only: never close a browser we don't own)
    this._addOnState.set(stateKey, { browser, owned: false, connected: true });

    // Track disconnection - stale connections clear themselves
    browser.on("disconnected", () => {
      if (this._addOnState.get(stateKey)?.browser === browser) {
        this._addOnState.delete(stateKey);
        logBrowserEvent("addon.disconnected", { name: addOnEntry.name });
      }
    });

    this.instanceSpawns[addOnEntry.name] = (this.instanceSpawns[addOnEntry.name] || 0) + 1;
    logBrowserEvent("addon.connected", { name: addOnEntry.name, cdpUrl: addOnEntry.cdpUrl });

    return browser.newPage();
  }

  _addOnConnection(name) {
    return this._addOnState.get(`addon_${name}`)?.browser || null;
  }

  _isAddOnConnected(name) {
    return Boolean(this._addOnState.get(`addon_${name}`)?.browser?.connected);
  }

  async _newChromiumPage() {
    const browser = await this.getBrowser();
    await this.ensureKeepAlivePage(browser);
    const page = await this.createWindowPage(browser);

    await page.setUserAgent(this.config.userAgent);
    page.setDefaultNavigationTimeout(this.config.browserOpTimeoutMs);
    page.setDefaultTimeout(this.config.browserOpTimeoutMs);
    return page;
  }

  async newPage(options = {}) {
    // Explicit browser name wins. "chromium" → the built-in; any other name
    // must be a configured add-on entry. Unknown names throw.
    if (options?.browser) {
      if (options.browser === "chromium") return this._newChromiumPage();
      const addOn = this._findAddOnByName(options.browser);
      if (!addOn) {
        throw new Error(
          `unknown browser "${options.browser}" — add a BROWSERS entry with a cdpUrl for it`
        );
      }
      return this._connectAddOnPage(addOn);
    }

    // Search engines always run on Chromium (the only built-in). API engines
    // never open a page — `_poolEngine(engine)` returns null for them.
    if (options?.engine) {
      return this._newChromiumPage();
    }

    // No browser and no engine → Chromium (always present).
    return this._newChromiumPage();
  }

  _poolEngine(engine) {
    // Every browser engine pools on Chromium. API engines → null (no page).
    const lower = (engine || "").toLowerCase();
    return getEngineMetadata(lower)?.pool === "engine" ? lower : null;
  }

  _poolMaxWindows(poolEngine) {
    return this.config.searchMaxWorkingWindows;
  }

  async ensureMinWorkingWindows(engine, { startupUrl, waitUntil = "domcontentloaded", label, reason = "cold_start" } = {}) {
    const lower = (engine || "").toLowerCase();
    const poolEngine = this._poolEngine(lower);
    const pool = this.getEnginePool(poolEngine);
    this.pruneClosedWindows(pool);

    const minWindows = this.config.searchKeepMinWorkingWindows;
    const maxWindows = this._poolMaxWindows(poolEngine);
    const target = Math.min(minWindows, maxWindows);
    const missing = Math.max(0, target - pool.windows.length);

    for (let index = 0; index < missing; index += 1) {
      const entry = {
        page: null,
        inUse: false,
        persistent: true,
        pending: true,
        engine: poolEngine
      };
      pool.windows.push(entry);

      try {
        const page = await this.newPage({ engine: lower });
        entry.page = page;
        entry.pending = false;

        page.on("close", () => {
          const activePool = this.getEnginePool(entry.engine);
          activePool.windows = activePool.windows.filter((item) => item.page !== page);
          this.wakeSearchWaiter(activePool);
        });

        if (startupUrl) {
          await page.goto(startupUrl, {
            waitUntil,
            timeout: this.config.browserOpTimeoutMs
          });
        }
        this.logWindowEvent("search.window.opened", label || entry.engine, { reason, persistent: true });
      } catch (error) {
        pool.windows = pool.windows.filter((item) => item !== entry);
        this.wakeSearchWaiter(pool);
        throw error;
      }
    }
  }

  async acquireSearchWindow(engine, { startupUrl, waitUntil = "domcontentloaded" } = {}) {
    if (this.prelaunchPromise) {
      await this.prelaunchPromise.catch(() => {
        // ignore prelaunch errors; search path will attempt normal creation
      });
    }

    const poolEngine = this._poolEngine(engine);
    await this.ensureMinWorkingWindows(engine, {
      startupUrl,
      waitUntil,
      label: engine,
      reason: "cold_start"
    });
    const pool = this.getEnginePool(poolEngine);

    while (true) {
      this.pruneClosedWindows(pool);
      const idle = pool.windows.find((entry) => !entry.pending && !entry.inUse);
      if (idle) {
        idle.inUse = true;
        return idle.page;
      }

      if (pool.windows.length < this._poolMaxWindows(poolEngine)) {
        const entry = {
          page: null,
          inUse: true,
          persistent: false,
          pending: true,
          engine: poolEngine
        };
        pool.windows.push(entry);
        try {
          const page = await this.newPage({ engine });
          entry.page = page;
          entry.pending = false;

          page.on("close", () => {
            const activePool = this.getEnginePool(entry.engine);
            activePool.windows = activePool.windows.filter((item) => item.page !== page);
            this.wakeSearchWaiter(activePool);
          });

          if (startupUrl) {
            await page.goto(startupUrl, {
              waitUntil,
              timeout: this.config.browserOpTimeoutMs
            });
          }
          this.logWindowEvent("search.window.opened", engine, { reason: "on_demand", persistent: false });
          return page;
        } catch (error) {
          pool.windows = pool.windows.filter((item) => item !== entry);
          this.wakeSearchWaiter(pool);
          throw error;
        }
      }

      await new Promise((resolve) => {
        pool.waiters.push(resolve);
      });
    }
  }

  async releaseSearchWindow(engine, page) {
    const poolEngine = this._poolEngine(engine);
    const pool = this.getEnginePool(poolEngine);
    this.pruneClosedWindows(pool);
    const entry = pool.windows.find((item) => item.page === page);
    if (!entry) return;

    if (entry.pending || !entry.page || entry.page.isClosed()) {
      pool.windows = pool.windows.filter((item) => item !== entry);
    } else if (!entry.persistent && pool.windows.length > this.config.searchKeepMinWorkingWindows) {
      pool.windows = pool.windows.filter((item) => item !== entry);
      try {
        await entry.page.close();
        this.logWindowEvent("search.window.closed", entry.engine, { reason: "release_over_min", persistent: false });
      } catch {
        // ignore window close errors
      }
    } else {
      entry.inUse = false;
      if (pool.windows.filter((item) => item.persistent).length < this.config.searchKeepMinWorkingWindows) {
        entry.persistent = true;
      }
    }

    if (!pool.waiters.length) {
      await this.trimIdleWindows(pool, this.config.searchKeepMinWorkingWindows);
    }

    this.wakeSearchWaiter(pool);
  }

  async getHealth() {
    const pools = {};
    let totalSearchWindows = 0;

    for (const [engine, pool] of this.engineWorkingWindows.entries()) {
      this.pruneClosedWindows(pool);
      const total = pool.windows.length;
      const inUse = pool.windows.filter((entry) => entry.inUse).length;
      const pending = pool.windows.filter((entry) => entry.pending).length;
      const persistent = pool.windows.filter((entry) => entry.persistent).length;
      totalSearchWindows += total;
      pools[engine] = { total, inUse, pending, persistent };
    }

    return {
      ok: true,
      backend: this.config.defaultBackend,
      browserConnected: Boolean(this.browser?.connected),
      headless: this.config.headless,
      enableDevtoolsMcp: this.config.enableDevtoolsMcp,
      userDataDir: this.config.chromeUserDataDir,
      profileDir: this.config.chromeProfileDir,
      searchRouteWarmupEngines: this.config.searchRouteWarmupEngines,
      searchWindows: {
        total: totalSearchWindows,
        byEngine: pools
      },
      pageLimiter: {
        maxConcurrentPageOps: this.config.maxConcurrentPageOps,
        inUse: this.pageSlotsInUse,
        queued: this.pageSlotWaiters.length
      },
      browsers: (this.config.browsers || []).map((b) => ({
        name: b.name,
        role: b.role,
        addOn: b.addOn,
        cdpUrl: b.cdpUrl,
        connected: b.addOn ? this._isAddOnConnected(b.name) : Boolean(this.browser?.connected),
      })),
      addOns: this._buildAddOnHealth()
    };
  }

  _buildAddOnHealth() {
    const result = {};
    if (!this.config.browsers) return result;
    for (const entry of this.config.browsers) {
      if (!entry.addOn) continue;
      result[entry.name] = {
        connected: this._isAddOnConnected(entry.name),
        cdpUrl: entry.cdpUrl,
        role: entry.role,
      };
    }
    return result;
  }

  async getInstanceStats() {
    // Built-in instances (chromium) plus configured add-ons (lazily connected)
    const addOnInstances = [];
    if (this.config.browsers) {
      for (const entry of this.config.browsers) {
        if (!entry.addOn) continue;
        addOnInstances.push([entry.name, this._addOnConnection(entry.name), entry]);
      }
    }

    const allInstances = [
      { backend: "chromium", instance: this.browser, addOn: false },
      ...addOnInstances.map(([name, instance, entry]) => ({
        backend: name,
        instance,
        addOn: true,
        cdpUrl: entry.cdpUrl,
      }))
    ];

    return Promise.all(
      allInstances.map(({ backend, instance, addOn, cdpUrl }) =>
        this._instanceStatWithTimeout(backend, instance, { addOn, cdpUrl })
      )
    );
  }

  async _instanceStatWithTimeout(backend, instance, extra = {}) {
    let timeout;
    try {
      return await Promise.race([
        this._instanceStat(backend, instance, extra),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve({
            backend,
            connected: Boolean(instance?.connected),
            tabs: 0,
            openTabs: [],
            pid: null,
            spawns: this.instanceSpawns[backend] || 0,
            timedOut: true,
            ...extra
          }), 750);
          timeout.unref?.();
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async _instanceStat(backend, instance, extra = {}) {
    const connected = Boolean(instance?.connected);
    let tabs = 0;
    let openTabs = [];
    let pid = null;

    if (connected) {
      try {
        const pages = await instance.pages();
        const activePages = pages.filter((page) => !page.isClosed());
        tabs = activePages.length;
        openTabs = await Promise.all(activePages.map(async (page) => {
          let title = "Untitled page";
          try { title = await page.title() || title; } catch {}
          let targetId = null;
          try { targetId = page.target()?.id?.() || null; } catch {}
          const timing = targetId ? getTabTimings(backend, targetId) : null;
          return {
            title,
            url: page.url(),
            targetId,
            lastActiveAt: timing?.lastActiveAt ?? null,
            closesInMs: timing?.closesInMs ?? null,
            autoClose: Boolean(timing)
          };
        }));
      } catch {
        tabs = 0;
        openTabs = [];
      }

      try {
        pid = instance.process()?.pid ?? null;
      } catch {
        pid = null;
      }
    }

    return {
      backend,
      connected,
      tabs,
      openTabs,
      pid,
      spawns: this.instanceSpawns[backend] || 0,
      ...extra
    };
  }

  async prelaunchIfConfigured() {
    if (!this.config.prelaunchBrowser) return;

    if (this.prelaunchPromise) {
      return this.prelaunchPromise;
    }

    this.prelaunchPromise = (async () => {
      // Only the built-in Chromium has a launch lifecycle; add-ons connect lazily.
      await this._prelaunchChromium();

      await Promise.allSettled(
        getBrowserWarmupEngines(this.config.searchRouteWarmupEngines).map((engine) =>
          this.ensureMinWorkingWindows(engine, {
            startupUrl: getEngineMetadata(engine)?.homeUrl || "about:blank",
            waitUntil: "domcontentloaded",
            reason: "warmup"
          })
        )
      );

      logBrowserEvent("search.warmup.ready", {
        engines: this.config.searchRouteWarmupEngines,
        minWindowsPerEngine: this.config.searchKeepMinWorkingWindows,
        maxWindowsPerEngine: this.config.searchMaxWorkingWindows,
        stats: this.buildWindowStats()
      });
    })();

    return this.prelaunchPromise;
  }

  async _prelaunchChromium() {
    const browser = await this.getBrowser();
    await this.ensureKeepAlivePage(browser);
    logBrowserEvent("chromium.prelaunch.ready", { reason: "screenshot_backend" });
  }

  async relaunchDefaultBackend(headless) {
    const previousHeadless = this.config.headless;
    this.config.headless = Boolean(headless);

    // Only the built-in Chromium is relaunched — add-ons have no launch lifecycle.
    const relaunchChromium = this.browser || [...this.engineWorkingWindows.values()].some((pool) => pool.windows.length > 0);

    try {
      if (relaunchChromium && this.browser) {
        await this.browser.close();
      }
    } catch (error) {
      logBrowserEvent("relaunch.close_failed", { error: String(error?.message || error) });
    }

    this.browser = null;
    this.launching = null;
    this.clearSearchWindows();
    this.keepAlivePage = null;
    this.prelaunchPromise = null;

    let relaunched = null;
    if (relaunchChromium || this.config.headless) {
      relaunched = await this.getBrowser();
    }
    logBrowserEvent("relaunch.ready", {
      backend: "chromium",
      headless: this.config.headless,
      previousHeadless
    });
    return {
      ok: true,
      backend: "chromium",
      relaunched: Boolean(relaunched?.connected),
      headless: this.config.headless,
    };
  }

  async shutdown() {
    // Chromium shutdown (owned — close)
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // ignore close errors on shutdown
      }
      this.browser = null;
    }

    if (this.tempProfileDir) {
      try {
        await fs.rm(this.tempProfileDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup errors
      }
      this.tempProfileDir = null;
    }

    // Add-on shutdown — disconnect only (the user owns the browser process)
    for (const [stateKey, state] of this._addOnState) {
      try {
        state.browser?.disconnect();
      } catch {
        // ignore disconnect errors on shutdown
      }
    }
    this._addOnState.clear();

    this.engineWorkingWindows.clear();
    this.keepAlivePage = null;
    this.prelaunchPromise = null;
  }
}

let managerPromise;

/**
 * Resolve the browser a page tool should use, then create a page on it.
 *
 * Selection rules (Browser Selection & Rollback, plan 39):
 *   1. Explicit `browser` param — strict: "chromium" hits the built-in; any
 *      other name must be a configured add-on in `BROWSERS`. A down add-on
 *      errors the call (no silent reroute).
 *   2. No `browser` param — add-ons are tried in `BROWSERS` array order; the
 *      first that connects serves the page. Each down add-on is recorded in
 *      `rollbackNotes` and reported in the tool result.
 *   3. All add-ons down (or none configured) — Chromium (always present).
 *
 * Returns `{ page, browser, rollbackNotes }` so callers can tag the result
 * with which browser actually served the page.
 */
export async function resolveBrowserParam(args = {}, config = null, manager = null, opts = {}) {
  const mgr = manager || (await getBrowserManager());
  const cfg = config || mgr.config;
  const explicit = typeof args?.browser === "string" && args.browser.trim()
    ? String(args.browser).trim()
    : "";
  const roles = Array.isArray(opts.roles) && opts.roles.length ? new Set(opts.roles) : null;

  if (explicit) {
    if (explicit === "chromium" || explicit === "Chromium") {
      return { page: await mgr._newChromiumPage(), browser: "chromium", rollbackNotes: [] };
    }
    const entry = (cfg.browsers || []).find((b) => b.addOn && b.name.toLowerCase() === explicit.toLowerCase());
    if (!entry) {
      throw new Error(`unknown browser "${explicit}" — add a BROWSERS entry with a cdpUrl for it`);
    }
    if (roles && !entry.role.some((r) => roles.has(r))) {
      throw new Error(`browser "${explicit}" lacks a required role (${[...roles].join(", ")})`);
    }
    try {
      const page = await mgr._connectAddOnPage(entry);
      return { page, browser: entry.name, rollbackNotes: [] };
    } catch (error) {
      throw new Error(`browser "${explicit}" unreachable (${entry.cdpUrl}): ${error?.message || error}`);
    }
  }

  const rollbackNotes = [];
  const candidates = (cfg.browsers || []).filter((b) => b.addOn && (!roles || b.role.some((r) => roles.has(r))));
  for (const entry of candidates) {
    try {
      const page = await mgr._connectAddOnPage(entry);
      return { page, browser: entry.name, rollbackNotes };
    } catch {
      rollbackNotes.push(`${entry.name}: down`);
    }
  }
  return { page: await mgr._newChromiumPage(), browser: "chromium", rollbackNotes };
}

export async function getBrowserManager() {
  if (!managerPromise) {
    managerPromise = loadConfig().then((config) => new BrowserManager(config));
  }
  try {
    return await managerPromise;
  } catch (error) {
    managerPromise = null;
    throw error;
  }
}
