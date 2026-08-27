import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import puppeteer from "puppeteer-core";
import { loadConfig, findLightpandaPath } from "./config.js";
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
  "lightpanda.spawn_failed": "❌",
  "lightpanda.exit": "🚪",
  "cloakbrowser.launch.ready": "✅",
  "cloakbrowser.launch.failed": "❌",
  "addon.connected": "🔌",
  "addon.disconnected": "🔌",
  "search.window.opened": "🪟",
  "search.window.closed": "🔒",
  "search.warmup.ready": "✅",
  "chromium.prelaunch.ready": "✅",
  "chromium.ready": "✅"
};

const BROWSER_LOG_LABEL = {
  "lightpanda.spawn_failed": "Lightpanda Spawn Failed",
  "lightpanda.exit": "Lightpanda Exited",
  "cloakbrowser.launch.ready": "CloakBrowser Ready",
  "cloakbrowser.launch.failed": "CloakBrowser Failed",
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

    // Chromium
    this.browser = null;
    this.launching = null;
    this.tempProfileDir = null;
    this.keepAlivePage = null;
    this.prelaunchPromise = null;

    // Lightpanda
    this.lightpandaProcess = null;
    this.lightpandaBrowser = null;
    this.lightpandaLaunching = null;
    this.lightpandaOwned = false;

    // CloakBrowser
    this.cloakbrowserBrowser = null;
    this.cloakbrowserLaunching = null;

    // Add-on browser state (keyed by `addon_${name}`)
    this._backendState = new Map();

    // Shared
    this.engineWorkingWindows = new Map();
    this.pageSlotsInUse = 0;
    this.pageSlotWaiters = [];

    // Cumulative spawn counters (in-memory, reset on restart)
    this.instanceSpawns = { chromium: 0, lightpanda: 0, cloakbrowser: 0 };
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

  clearSearchWindowsForBackend(backend) {
    for (const pool of this.engineWorkingWindows.values()) {
      const entryBackend = (entry) =>
        entry.backend ||
        (pool.engine === "_shared"
          ? "lightpanda"
          : this.config.defaultBackend);
      const removed = pool.windows.some((entry) => entryBackend(entry) === backend);
      pool.windows = pool.windows.filter((entry) => entryBackend(entry) !== backend);
      if (removed) this.wakeSearchWaiter(pool);
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
      this.clearSearchWindowsForBackend("chromium");
      if (this.config.defaultBackend === "chromium") {
        this.keepAlivePage = null;
        this.prelaunchPromise = null;
      }
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

  // ---- Lightpanda backend ----

  async _spawnLightpanda() {
    const binaryPath = this.config.lightpandaPath || (await findLightpandaPath());
    if (!binaryPath) return null;

    const port = this.config.lightpandaPort;

    return new Promise((resolve, reject) => {
      const proc = spawn(binaryPath, ["serve", "--port", String(port), "--timeout", "300"], {
        stdio: "ignore"
      });

      let started = false;
      let pollTimer;
      let startupTimer;
      const settle = (error) => {
        if (started) return;
        started = true;
        clearTimeout(pollTimer);
        clearTimeout(startupTimer);
        if (error) {
          proc.kill();
          reject(error);
        } else {
          resolve(proc);
        }
      };

      proc.on("error", (err) => {
        settle(err);
      });

      const poll = () => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          res.resume();
          settle();
        });
        req.on("error", () => {
          if (!started) pollTimer = setTimeout(poll, 100);
        });
        req.end();
      };
      pollTimer = setTimeout(poll, 300);
      startupTimer = setTimeout(() => settle(new Error("Lightpanda failed to start within 15s")), 15000);
    });
  }

  async getLightpandaBrowser() {
    if (this.lightpandaBrowser?.connected) return this.lightpandaBrowser;
    if (this.lightpandaLaunching) return this.lightpandaLaunching;

    this.lightpandaLaunching = this._connectLightpanda();
    try {
      this.lightpandaBrowser = await this.lightpandaLaunching;
      return this.lightpandaBrowser;
    } finally {
      this.lightpandaLaunching = null;
    }
  }

  async _connectLightpanda() {
    let processHandle = this.lightpandaProcess;
    if (!processHandle) {
      try {
        const browser = await puppeteer.connect({
          browserWSEndpoint: `ws://127.0.0.1:${this.config.lightpandaPort}`,
          defaultViewport: { width: MONITOR_WIDTH, height: MONITOR_HEIGHT }
        });
        this.lightpandaBrowser = browser;
        this.lightpandaOwned = false;
        this._watchLightpandaBrowser(browser);
        return browser;
      } catch {
        // No existing CDP server is accepting connections; spawn one below.
      }

      try {
        processHandle = await this._spawnLightpanda();
        if (processHandle) this.instanceSpawns.lightpanda += 1;
      } catch (error) {
        logBrowserEvent("lightpanda.spawn_failed", { error: String(error?.message || error) });
        return null;
      }
    }

    if (!processHandle) return null;

    this.lightpandaProcess = processHandle;
    this.lightpandaOwned = true;
    processHandle.on("exit", (code) => {
      logBrowserEvent("lightpanda.exit", { code });
      this.lightpandaProcess = null;
      this.lightpandaBrowser = null;
      this.lightpandaOwned = false;
    });

    const browser = await puppeteer.connect({
      browserWSEndpoint: `ws://127.0.0.1:${this.config.lightpandaPort}`,
      defaultViewport: { width: MONITOR_WIDTH, height: MONITOR_HEIGHT }
    });

    this.lightpandaBrowser = browser;
    this._watchLightpandaBrowser(browser);
    return browser;
  }

  _watchLightpandaBrowser(browser) {
    browser.on("disconnected", () => {
      this.lightpandaBrowser = null;
      this.clearSearchWindowsForBackend("lightpanda");
    });
  }

  async _newLightpandaPage() {
    const browser = await this.getLightpandaBrowser();
    if (!browser) {
      throw new Error("Lightpanda is unavailable; cannot create a Lightpanda page");
    }

    const page = await browser.newPage();
    await page.setUserAgent(this.config.userAgent);
    page.setDefaultNavigationTimeout(this.config.browserOpTimeoutMs);
    page.setDefaultTimeout(this.config.browserOpTimeoutMs);

    // Inject stealth patches to avoid bot detection.
    // These run before any page scripts on every navigation.
    await page.evaluateOnNewDocument(() => {
      // Override navigator.webdriver
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
        configurable: true,
      });

      // Spoof navigator.plugins
      const makePlugin = (name, filename, description) => {
        const plugin = {
          name,
          filename,
          description,
          length: 0,
          item: () => null,
          namedItem: () => null,
          [Symbol.iterator]: function* () {},
        };
        return plugin;
      };
      const plugins = [
        makePlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format'),
        makePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''),
        makePlugin('Native Client', 'internal-nacl-plugin', ''),
      ];
      const pluginArray = Object.assign(plugins.slice(), {
        item: (i) => plugins[i] || null,
        namedItem: (n) => plugins.find((p) => p.name === n) || null,
        refresh: () => {},
        length: plugins.length,
        [Symbol.iterator]: function* () { yield* plugins; },
      });
      Object.defineProperty(navigator, 'plugins', {
        get: () => pluginArray,
        configurable: true,
      });

      // Spoof navigator.mimeTypes
      const mimeTypes = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ];
      const mimeTypeArray = Object.assign(mimeTypes.slice(), {
        item: (i) => mimeTypes[i] || null,
        namedItem: (n) => mimeTypes.find((m) => m.type === n) || null,
        length: mimeTypes.length,
        [Symbol.iterator]: function* () { yield* mimeTypes; },
      });
      Object.defineProperty(navigator, 'mimeTypes', {
        get: () => mimeTypeArray,
        configurable: true,
      });

      // Spoof navigator.languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true,
      });

      // Spoof navigator.platform
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Linux x86_64',
        configurable: true,
      });

      // Spoof navigator.hardwareConcurrency
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
        configurable: true,
      });

      // Spoof navigator.deviceMemory
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
        configurable: true,
      });

      // Add window.chrome object
      if (!window.chrome) {
        window.chrome = {
          runtime: {},
          loadTimes: () => null,
          csi: () => null,
          app: {},
        };
      }

      // Override navigator.connection to include effectiveType
      if (navigator.connection) {
        Object.defineProperty(navigator.connection, 'effectiveType', {
          get: () => '4g',
          configurable: true,
        });
      }

      // Remove webdriver from navigator
      if (Object.hasOwn(navigator, "webdriver")) {
        delete navigator.webdriver;
      }

      // Hide headless chrome by overriding permissions
      const origQuery = navigator.permissions?.query;
      if (origQuery) {
        navigator.permissions.query = (params) => {
          if (params?.name === 'notifications') {
            return Promise.resolve({ state: 'denied', onchange: null });
          }
          return origQuery(params);
        };
      }
    });

    return page;
  }

  async _launchCloakbrowser() {
    if (this.cloakbrowserLaunching) return this.cloakbrowserLaunching;
    this.cloakbrowserLaunching = (async () => {
      try {
        const { launch } = await import("cloakbrowser/puppeteer");
        // CloakBrowser reads its binary path from process.env, not launch options.
        if (this.config.cloakbrowserPath) {
          process.env.CLOAKBROWSER_BINARY_PATH = this.config.cloakbrowserPath;
        } else {
          delete process.env.CLOAKBROWSER_BINARY_PATH;
        }
        const browser = await launch({
          headless: this.config.headless,
          humanize: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--window-size=1920,1080",
            "--fingerprint=48271",
            "--fingerprint-hardware-concurrency=8",
            "--fingerprint-device-memory=8",
            "--fingerprint-screen-width=1920",
            "--fingerprint-screen-height=1080",
            "--fingerprint-taskbar-height=48",
            "--fingerprint-storage-quota=5000"
          ]
        });
        this.cloakbrowserBrowser = browser;
        this.instanceSpawns.cloakbrowser += 1;
        browser.on("disconnected", () => {
          this.cloakbrowserBrowser = null;
          this.cloakbrowserLaunching = null;
          this.clearSearchWindowsForBackend("cloakbrowser");
        });
        logBrowserEvent("cloakbrowser.launch.ready");
        return browser;
      } catch (error) {
        this.cloakbrowserLaunching = null;
        logBrowserEvent("cloakbrowser.launch.failed", { error: String(error?.message || error) });
        throw error;
      }
    })();
    return this.cloakbrowserLaunching;
  }

  getCloakbrowserBrowser() {
    if (this.cloakbrowserBrowser?.connected) return this.cloakbrowserBrowser;
    if (this.cloakbrowserLaunching) return this.cloakbrowserLaunching;
    return this._launchCloakbrowser();
  }

  async _newCloakbrowserPage() {
    const browser = await this.getCloakbrowserBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(this.config.userAgent);
    page.setDefaultNavigationTimeout(this.config.browserOpTimeoutMs);
    page.setDefaultTimeout(this.config.browserOpTimeoutMs);
    return page;
  }

  _findAddOnForBackend(backend) {
    if (!backend || !this.config.browsers) return null;
    return this.config.browsers.find(
      (b) => b.addOn && b.connect === backend
    );
  }

  async _connectAddOnPage(addOnEntry) {
    const stateKey = `addon_${addOnEntry.name}`;
    let state = this._backendState.get(stateKey);

    // Reuse existing connection if alive
    if (state?.browser?.connected) {
      return state.browser.newPage();
    }

    // Connect to external CDP
    const browser = await puppeteer.connect({
      browserWSEndpoint: addOnEntry.cdpUrl,
      defaultViewport: { width: MONITOR_WIDTH, height: MONITOR_HEIGHT },
    });

    // Store state (owned: false = don't close on shutdown)
    this._backendState.set(stateKey, {
      browser,
      owned: false,
      connected: true,
    });

    // Track disconnection
    browser.on("disconnected", () => {
      this._backendState.delete(stateKey);
      this.clearSearchWindowsForBackend(addOnEntry.name);
    });

    this.instanceSpawns[addOnEntry.name] = (this.instanceSpawns[addOnEntry.name] || 0) + 1;
    logBrowserEvent("addon.connected", { name: addOnEntry.name, cdpUrl: addOnEntry.cdpUrl });

    return browser.newPage();
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
    let backend = (options && options.backend) || this.config.defaultBackend;

    // Engine-specific backend routing: pool "shared" → lightpanda,
    // pool "engine" → defaultBackend (chromium/cloakbrowser), API → defaultBackend
    if (options?.engine && !options.backend) {
      const meta = getEngineMetadata(options.engine);
      if (meta?.pool === "shared") {
        backend = "lightpanda";
      }
    }

    // Check for add-on that connects as this backend type
    const addOn = this._findAddOnForBackend(backend);
    if (addOn) return this._connectAddOnPage(addOn);

    // Built-in backend dispatch
    if (backend === "cloakbrowser") return this._newCloakbrowserPage();
    if (backend === "chromium") return this._newChromiumPage();
    return this._newLightpandaPage();
  }

  _poolEngine(engine) {
    // Per-engine pools for CloakBrowser/Chromium routes; Lightpanda routes share one pool.
    const lower = (engine || "").toLowerCase();
    const pool = getEngineMetadata(lower)?.pool;
    if (pool === "engine") return lower;
    if (pool === "shared") return "_shared";
    if (this.config.defaultBackend === "cloakbrowser") return lower;
    return this.config.defaultBackend !== "chromium" ? "_shared" : lower;
  }

  _poolMaxWindows(poolEngine) {
    if (poolEngine === "_shared") return 1;
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
        engine: poolEngine,
        backend: this.config.defaultBackend
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
          engine: poolEngine,
          backend: this.config.defaultBackend
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
      devtoolsBackend: this.config.devtoolsBackend,
      browserConnected: Boolean(this.browser?.connected),
      lightpandaConnected: Boolean(this.lightpandaBrowser?.connected),
      cloakbrowserConnected: Boolean(this.cloakbrowserBrowser?.connected),
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
        index: b.index,
        addOn: b.addOn,
        cdpUrl: b.cdpUrl,
        connect: b.connect,
      })),
      addOns: this._buildAddOnHealth()
    };
  }

  _buildAddOnHealth() {
    const result = {};
    if (!this.config.browsers) return result;
    for (const entry of this.config.browsers) {
      if (!entry.addOn) continue;
      const state = this._backendState.get(`addon_${entry.name}`);
      result[entry.name] = {
        connected: Boolean(state?.browser?.connected),
        cdpUrl: entry.cdpUrl,
        connect: entry.connect,
        role: entry.role,
      };
    }
    return result;
  }

  async getInstanceStats() {
    const instances = [
      ["chromium", this.browser],
      ["lightpanda", this.lightpandaBrowser],
      ["cloakbrowser", this.cloakbrowserBrowser]
    ];

    // Add add-on browsers
    const addOnInstances = [];
    if (this.config.browsers) {
      for (const entry of this.config.browsers) {
        if (!entry.addOn) continue;
        const state = this._backendState.get(`addon_${entry.name}`);
        addOnInstances.push([entry.name, state?.browser || null, entry]);
      }
    }

    const allInstances = [
      ...instances.map(([backend, instance]) => ({ backend, instance, addOn: false })),
      ...addOnInstances.map(([name, instance, entry]) => ({
        backend: name,
        instance,
        addOn: true,
        cdpUrl: entry.cdpUrl,
        connect: entry.connect,
      }))
    ];

    return Promise.all(
      allInstances.map(({ backend, instance, addOn, cdpUrl, connect }) =>
        this._instanceStatWithTimeout(backend, instance, { addOn, cdpUrl, connect })
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

      if (backend === "lightpanda") {
        pid = this.lightpandaProcess?.pid ?? null;
      } else {
        try {
          pid = instance.process()?.pid ?? null;
        } catch {
          pid = null;
        }
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
      if (this.config.defaultBackend === "chromium") {
        await this._prelaunchChromium();
      } else if (this.config.defaultBackend === "cloakbrowser") {
        await this.getCloakbrowserBrowser();
      } else {
        const browser = await this.getLightpandaBrowser();
        if (!browser) {
          throw new Error("Lightpanda is unavailable; cannot pre-launch the configured backend");
        }
      }

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
    const backend = this.config.defaultBackend;
    const previousHeadless = this.config.headless;
    this.config.headless = Boolean(headless);

    // VNC needs every active graphical route restarted, not only the default
    // backend. Search and devtools may use a different browser backend.
    const graphicalBackends = new Set();
    if (this.browser || [...this.engineWorkingWindows.values()].some((pool) => pool.windows.some((entry) => entry.backend === "chromium"))) {
      graphicalBackends.add("chromium");
    }
    if (this.cloakbrowserBrowser || [...this.engineWorkingWindows.values()].some((pool) => pool.windows.some((entry) => entry.backend === "cloakbrowser"))) {
      graphicalBackends.add("cloakbrowser");
    }
    if (!graphicalBackends.size) {
      if (this.config.devtoolsBackend === "chromium" || this.config.devtoolsBackend === "cloakbrowser") {
        graphicalBackends.add(this.config.devtoolsBackend);
      } else if (backend === "chromium" || backend === "cloakbrowser") {
        graphicalBackends.add(backend);
      }
    }

    try {
      if (graphicalBackends.has("chromium") && this.browser) {
        await this.browser.close();
      }
      if (graphicalBackends.has("cloakbrowser") && this.cloakbrowserBrowser) {
        await this.cloakbrowserBrowser.close();
      }
    } catch (error) {
      logBrowserEvent("relaunch.close_failed", { error: String(error?.message || error) });
    }

    this.browser = null;
    this.launching = null;
    this.cloakbrowserBrowser = null;
    this.cloakbrowserLaunching = null;
    for (const graphicalBackend of graphicalBackends) {
      this.clearSearchWindowsForBackend(graphicalBackend);
    }
    this.keepAlivePage = null;
    this.prelaunchPromise = null;

    const relaunched = await Promise.all(
      [...graphicalBackends].map((graphicalBackend) =>
        graphicalBackend === "chromium" ? this.getBrowser() : this.getCloakbrowserBrowser()
      )
    );
    logBrowserEvent("relaunch.ready", {
      backend,
      backends: [...graphicalBackends],
      headless: this.config.headless,
      previousHeadless
    });
    return {
      ok: true,
      backend,
      backends: [...graphicalBackends],
      relaunched: relaunched.length > 0,
      headless: this.config.headless,
      ...(backend === "lightpanda" ? { note: "Lightpanda is CDP-only; graphical routes were relaunched for VNC." } : {})
    };
  }

  async shutdown() {
    // Chromium shutdown
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

    // Lightpanda shutdown
    if (this.lightpandaBrowser) {
      try {
        if (this.lightpandaOwned) await this.lightpandaBrowser.close();
        else this.lightpandaBrowser.disconnect();
      } catch {
        // ignore close errors on shutdown
      }
      this.lightpandaBrowser = null;
    }

    if (this.lightpandaProcess) {
      try {
        this.lightpandaProcess.kill();
      } catch {
        // ignore process kill errors
      }
      this.lightpandaProcess = null;
      this.lightpandaOwned = false;
    }

    // CloakBrowser shutdown
    if (this.cloakbrowserBrowser) {
      try {
        await this.cloakbrowserBrowser.close();
      } catch {
        // ignore close errors on shutdown
      }
      this.cloakbrowserBrowser = null;
    }

    // Add-on shutdown — disconnect only (user owns the browser process)
    for (const [stateKey, state] of this._backendState) {
      try {
        state.browser?.disconnect();
      } catch {
        // ignore disconnect errors on shutdown
      }
    }
    this._backendState.clear();

    this.engineWorkingWindows.clear();
    this.keepAlivePage = null;
    this.prelaunchPromise = null;
  }
}

let managerPromise;

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
