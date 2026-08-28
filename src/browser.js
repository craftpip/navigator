import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { loadConfig } from "./config.js";
import { getBrowserWarmupEngines, getEngineMetadata } from "./engines/index.js";
import { getTabTimings } from "./tab-timers.js";
import { relayServer } from "./relay-server.js";

/**
 * User-facing display filter for cross-browser target listings (Target.getTargets,
 * /stats). Hides browser chrome and plugin surfaces — chrome://omnibox-popup,
 * chrome://tab-search, chrome://extensions, chrome-extension:// background
 * pages/service workers, about:blank strays — keeping only real web pages.
 * The relay CDP gateway itself still exposes every target to puppeteer; this
 * only controls what the human-facing listings show.
 */
export function isVisiblePageUrl(url = "") {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function isPageTargetType(target) {
  if (!target || typeof target.type !== "string") return true;
  return target.type === "page" || target.type === "tab";
}

/**
 * Browser ownership — who the browser window belongs to.
 *
 * - "user"  – type "navigator-cdp" (the relay browser): the USER's real,
 *             visible, non-headless window. Every tab/click/navigation the
 *             agent does there appears on the user's screen.
 * - "agent" – everything else: navigator-owned browsers (builtin Chromium,
 *             plain "cdp" add-ons like cloakbrowser/lightpanda). Headless /
 *             off-screen; the user cannot see activity there.
 *
 * Derives purely from `type` so all listings agree (list_browsers,
 * Target.getTargets, page-tool browser params).
 */
export function browserOwnership(type) {
  return type === "navigator-cdp" ? "user" : "agent";
}

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

  /**
   * Effective add-on list = configured add-ons (config order, roles honored)
   * + registry navigator-cdp entries (pre-declared merged by name, dynamic
   * registrations appended with role ["default"]) + relay status for each.
   * This is the single source the routing decision and every status surface
   * read from — never iterate config.browsers directly for add-on routing.
   */
  _effectiveAddOns() {
    return relayServer.getStatusEntries(this.config.browsers);
  }

  _findAddOnByName(name) {
    if (!name) return null;
    const lower = String(name).toLowerCase();
    return this._effectiveAddOns().find((b) => b.name.toLowerCase() === lower) || null;
  }

  async _connectAddOnPage(addOnEntry) {
    const browser = await this._ensureAddOnConnection(addOnEntry);
    return browser.newPage();
  }

  /**
   * Ensure a CDP connection to an add-on exists and return the connected
   * Browser (without opening a new page). Reuses a live connection. Used by
   * both `_connectAddOnPage` and `attachToExistingTarget` (which must not open
   * a new tab when adopting an existing one).
   */
  async _ensureAddOnConnection(addOnEntry) {
    const stateKey = `addon_${addOnEntry.name}`;
    let state = this._addOnState.get(stateKey);

    // Reuse existing connection if alive
    if (state?.browser?.connected) {
      return state.browser;
    }

    // navigator-cdp add-ons dial OUR /browser/<name> CDP gateway (the extension
    // dials us over /relay); plain cdp add-ons dial their configured endpoint.
    const isRelay = addOnEntry.type === "navigator-cdp";
    const endpoint = isRelay
      ? relayServer.gatewayWsUrl(addOnEntry.name)
      : addOnEntry.cdpUrl;
    const usesHttp = !isRelay && /^https?:\/\//i.test(String(endpoint || ""));
    // Relay add-ons (navigator-cdp) are the USER's real browser window — never
    // force the 1920x1080 puppeteer default viewport onto their tabs, or every
    // adopted/created tab renders wider than their actual window (Emulation
    // device-metrics override). Connecting with defaultViewport:null lets real
    // tabs keep their natural window size. Navigator-owned browsers (chromium,
    // plain cdp like cloakbrowser/lightpanda) keep the fixed monitor viewport.
    const browser = await puppeteer.connect({
      defaultViewport: isRelay
        ? null
        : { width: MONITOR_WIDTH, height: MONITOR_HEIGHT },
      ...(usesHttp
        ? { browserURL: endpoint }
        : { browserWSEndpoint: endpoint }),
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

    return browser;
  }

  _addOnConnection(name) {
    return this._addOnState.get(`addon_${name}`)?.browser || null;
  }

  _isAddOnConnected(name) {
    const entry = this._findAddOnByName(name);
    if (entry && entry.type === "navigator-cdp") return entry.status === "connected";
    return Boolean(this._addOnState.get(`addon_${name}`)?.browser?.connected);
  }

  /**
   * Adopt an EXISTING browser-origin tab (a real tab in the user's browser,
   * e.g. one listed by Target.getTargets as origin:"browser") so navigator's
   * devtools tooling can drive it, without opening a new tab.
   *
   * Scans every connected add-on's CDP connection for a target whose CDP
   * targetId matches `targetId`, then returns that target's Page. Interacting
   * with the page triggers the relay's on-demand Target.attachToTarget.
   *
   * @returns {Promise<{page: import("puppeteer-core").Page, backend: string} | null>}
   *   null when `targetId` doesn't match any existing tab on a connected add-on.
   */
  /**
   * Adopt an EXISTING browser-origin tab (a real tab in the user's browser,
   * e.g. one listed by Target.getTargets as origin:"browser") so navigator's
   * devtools tooling can drive it, without opening a new tab.
   *
   * Connects to the add-on, asks the relay to synthesize an attachedToTarget
   * for the tab (so puppeteer creates a managed Page), then waits for that
   * page to appear in browser.pages(). Interacting with the page drives the
   * user's real tab through the relay.
   *
   * @returns {Promise<{page: import("puppeteer-core").Page, backend: string} | null>}
   *   null when `targetId` doesn't match any existing tab on a connected add-on.
   */
  async attachToExistingTarget(targetId) {
    const tid = String(targetId || "").trim();
    if (!tid) return null;

    const candidates = this._effectiveAddOns().filter((b) => b.connected || b.status === "connected");
    for (const entry of candidates) {
      let browser;
      try {
        browser = await this._ensureAddOnConnection(entry);
      } catch {
        continue;
      }
      if (!browser || !browser.connected) continue;

      // Refresh the relay's tab list so the targetId is present, then make the
      // relay synthesize an attachedToTarget -> puppeteer creates a Page.
      const gotBackend = typeof entry.name === "string" && entry.name;
      const res = await relayServer.attachExistingTabToClients(
        gotBackend,
        tid
      );
      if (!res || !res.found || !res.attached) continue;

      // There is no public `Target.id()` in puppeteer v24 — the target id lives
      // on the internal `_targetId` field of the underlying CdpTarget, which
      // `attachExistingTabToClients` populates from the real extension targetId.
      const targetIdOf = (p) => {
        try { const t = p?.target?.(); if (!t) return ""; return String(t._targetId ?? ""); } catch { return ""; }
      };

      // Poll browser.pages() until the adopted page materializes.
      const deadline = Date.now() + Math.min(this.config?.browserOpTimeoutMs || 60000, 5000);
      let page = null;
      while (Date.now() < deadline) {
        try {
          const pages = await browser.pages();
          // Match on the CDP target id, not URL — the user frequently has several
          // tabs open to the same page (e.g. multiple boniface.pe/eira tabs), so
          // URL matching would drive the wrong one. Never fall back to a wrong
          // target: wait for the exact tid to appear.
          page = pages.find((p) => !p.isClosed() && targetIdOf(p) === tid) || null;
        } catch {
          break;
        }
        if (page) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      if (page) {
        return { page, backend: gotBackend };
      }
    }

    return null;
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
      browsers: this._effectiveAddOns().map((b) => ({
        name: b.name,
        role: b.role,
        type: b.type,
        plugin: b.plugin,
        configured: b.configured,
        status: b.status,
        paired: b.paired ?? (b.type === "navigator-cdp" ? relayServer.isPaired(b.name) : undefined),
        connected: b.type === "navigator-cdp"
          ? b.status === "connected"
          : this._isAddOnConnected(b.name),
        cdpUrl: b.cdpUrl,
        relayWsUrl: b.type === "navigator-cdp" && b.status === "connected"
          ? relayServer.gatewayWsUrl(b.name)
          : undefined,
        pin: b.pin ?? undefined,
        pinExpiresAt: b.pinExpiresAt ?? undefined,
        extensionVersion: b.extensionVersion ?? undefined
      })),
      addOns: this._buildAddOnHealth(),
      relay: this.getRelaySummary()
    };
  }

  _buildAddOnHealth() {
    const result = {};
    for (const entry of this._effectiveAddOns()) {
      result[entry.name] = {
        type: entry.type,
        status: entry.status,
        connected: entry.type === "navigator-cdp"
          ? entry.status === "connected"
          : this._isAddOnConnected(entry.name),
        cdpUrl: entry.cdpUrl,
        role: entry.role,
      };
    }
    return result;
  }

  getRelaySummary() {
    const entries = this._effectiveAddOns().filter((e) => e.type === "navigator-cdp");
    return {
      pending: entries.filter((e) => e.status === "auth_pending").map(this._relaySummaryItem),
      connected: entries.filter((e) => e.status === "connected").map(this._relaySummaryItem)
    };
  }

  _relaySummaryItem(entry) {
    return {
      name: entry.name,
      plugin: entry.plugin,
      status: entry.status,
      pin: entry.pin ?? undefined,
      pinExpiresAt: entry.pinExpiresAt ?? undefined,
      connectedAt: entry.connectedAt ?? undefined,
      extensionVersion: entry.extensionVersion ?? undefined,
      wsUrl: relayServer.gatewayWsUrl(entry.name)
    };
  }

  async getInstanceStats() {
    // Built-in instances (chromium) plus each effective add-on. navigator-cdp
    // entries report directly from the relay registry (no puppet connection
    // needed until a page tool actually drives them); plain cdp add-ons are
    // lazily connected and report via their puppet Browser.
    const statResults = [
      this._instanceStatWithTimeout("chromium", this.browser, { addOn: false })
    ];

    for (const entry of this._effectiveAddOns()) {
      if (entry.type === "navigator-cdp") {
        statResults.push(this._navigatorCdpStat(entry));
        continue;
      }
      statResults.push(this._instanceStatWithTimeout(
        entry.name,
        this._addOnConnection(entry.name),
        { addOn: true, cdpUrl: entry.cdpUrl }
      ));
    }

    return Promise.all(statResults);
  }

  async _navigatorCdpStat(entry) {
    const live = relayServer.getEntry(entry.name);
    if (!live) {
      return {
        backend: entry.name,
        connected: false,
        tabs: 0,
        openTabs: [],
        pid: null,
        spawns: 0,
        type: "navigator-cdp",
        plugin: entry.plugin || "auto",
        status: "disconnected",
        cdpUrl: relayServer.gatewayWsUrl(entry.name)
      };
    }
    const conn = this._addOnConnection(entry.name);
    const isConn = relayServer.isConnected(entry.name);
    // Refresh the relay's tab list so newly user-opened tabs are visible,
    // rather than serving a stale cache. Bounded by GATEWAY_WAIT_MS (3s).
    let tabs;
    if (isConn) {
      tabs = await relayServer.refreshTabList(entry.name);
    } else {
      tabs = [];
    }
    const visible = tabs.filter((t) => isVisiblePageUrl(t.url) && isPageTargetType(t));
    return {
      backend: live.name,
      connected: isConn,
      tabs: visible.length,
      openTabs: visible.map((t) => ({
        title: t.title || "Untitled",
        url: t.url || "",
        targetId: t.targetId || null
      })),
      pid: null,
      spawns: 0,
      type: "navigator-cdp",
      plugin: entry.plugin,
      status: isConn ? "connected" : live.status === "auth_pending" ? "auth_pending" : "disconnected",
      extensionVersion: live.extensionVersion,
      connectedAt: live.connectedAt || null,
      puppeteerClients: live.clients && live.clients.size,
      viaPuppeteer: Boolean(conn?.browser?.connected),
      cdpUrl: relayServer.gatewayWsUrl(entry.name)
    };
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
      if (!extra.addOn) openTabs = openTabs.filter((t) => isVisiblePageUrl(t.url));

      try {
        pid = instance.process()?.pid ?? null;
      } catch {
        pid = null;
      }
    }

    const status = connected
      ? (extra.status || "connected")
      : (extra.cdpUrl ? "available" : (extra.status || "disconnected"));
    return {
      backend,
      connected,
      status,
      tabs,
      openTabs,
      pid,
      spawns: this.instanceSpawns[backend] || 0,
      ...extra,
      status
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
    const entry = mgr._effectiveAddOns().find((b) => b.name.toLowerCase() === explicit.toLowerCase());
    if (!entry) {
      throw new Error(`unknown browser "${explicit}" — add a BROWSERS entry with a cdpUrl or type "navigator-cdp" for it`);
    }
    if (roles && !entry.role.some((r) => roles.has(r))) {
      throw new Error(`browser "${explicit}" lacks a required role (${[...roles].join(", ")})`);
    }
    if (entry.type === "navigator-cdp" && entry.status !== "connected") {
      throw new Error(`browser "${explicit}" is ${entry.status} — pair the browser extension (PIN) before routing to it`);
    }
    try {
      const page = await mgr._connectAddOnPage(entry);
      return { page, browser: entry.name, rollbackNotes: [] };
    } catch (error) {
      const endpoint = entry.type === "navigator-cdp"
        ? relayServer.gatewayWsUrl(entry.name)
        : entry.cdpUrl;
      throw new Error(`browser "${explicit}" unreachable (${endpoint}): ${error?.message || error}`);
    }
  }

  const rollbackNotes = [];
  const candidates = mgr._effectiveAddOns().filter((b) => !roles || b.role.some((r) => roles.has(r)));
  for (const entry of candidates) {
    if (entry.type === "navigator-cdp" && entry.status !== "connected") {
      rollbackNotes.push(`${entry.name}: ${entry.status}`);
      continue;
    }
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
