import { randomBytes } from "node:crypto";
import { getBrowserManager, resolveBrowserParam } from "./browser.js";
import { resolveRefIdToUrl } from "./ref-memory.js";
import { clearTab, touchTab } from "./tab-timers.js";

const MAX_TARGETS = 20;
const MAX_CONSOLE_MESSAGES = 200;
const MAX_NETWORK_REQUESTS = 200;
const MAX_QUERY_RESULTS = 25;
const DEFAULT_HTML_LIMIT = 20000;
const INACTIVITY_TIMEOUT_MS = 300_000;
const INACTIVITY_CHECK_INTERVAL_MS = 30_000;
const CLOSED_TARGET_RETENTION_MS = 600_000;

const targetsById = new Map();
const closedTargets = new Map();

const devtoolsCounters = { targetsCreated: 0, targetsClosed: 0, targetsInactivityClosed: 0 };

export function getDevtoolsCounters() {
  return { ...devtoolsCounters };
}

function cleanWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanCssSelector(selector) {
  return String(selector || "")
    .replace(/:has-text\(((?:[^()]|\([^()]*\))*)\)/gi, "")
    .replace(/:text(?:-is|-matches)?\(((?:[^()]|\([^()]*\))*)\)/gi, "")
    .replace(/:visible\b|:hidden\b/gi, "")
    .replace(/,\s*,/g, ",")
    .replace(/^[\s,]+|[\s,]+$/g, "");
}

function truncate(value, maxChars = 300) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function parseMaxChars(value, fallback = DEFAULT_HTML_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(120000, Math.floor(parsed));
}

function assertString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid input: ${field} must be a non-empty string`);
  }
}

function parseViewport(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid input: viewport must be an object with positive width and height");
  }
  const width = Math.floor(Number(value.width));
  const height = Math.floor(Number(value.height));
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("Invalid input: viewport.width and viewport.height must be positive numbers");
  }
  return { width, height };
}

function assertEnabled(manager) {
  if (!manager?.config?.enableDevtoolsMcp) {
    throw new Error("Developer browser tools are disabled. Set ENABLE_DEVTOOLS_MCP=1 to enable them.");
  }
}

export function getTargetState(targetId) {
  const tid = String(targetId || "").trim();
  if (closedTargets.has(tid)) {
    throw new Error(`Target ${tid} was closed due to inactivity (no interaction for 5 minutes). Create a new target with Target.createTarget.`);
  }
  const state = targetsById.get(tid);
  if (!state || !state.page || state.page.isClosed()) {
    throw new Error(`Unknown targetId: ${targetId}`);
  }
  state.lastActiveAt = new Date().toISOString();
  touchTab(state.backend, state.targetId);
  return state;
}

function recordConsoleMessage(state, entry) {
  state.consoleMessages.push(entry);
  while (state.consoleMessages.length > MAX_CONSOLE_MESSAGES) {
    state.consoleMessages.shift();
  }
}

function recordNetworkRequest(state, entry) {
  state.networkRequests.push(entry);
  while (state.networkRequests.length > MAX_NETWORK_REQUESTS) {
    state.networkRequests.shift();
  }
}

function buildTargetSummary(state) {
  return {
    targetId: state.targetId,
    backend: state.backend,
    url: state.page.url(),
    title: state.lastTitle || "",
    viewport: state.viewport,
    createdAt: state.createdAt,
    lastActiveAt: state.lastActiveAt,
    consoleMessageCount: state.consoleMessages.length
  };
}

async function refreshTitle(state) {
  try {
    state.lastTitle = await state.page.title();
  } catch {
    state.lastTitle = state.lastTitle || "";
  }
}

let inactivityInterval = null;

function startInactivityCleanup() {
  if (inactivityInterval) return;
  inactivityInterval = setInterval(() => {
    const now = Date.now();
    for (const [targetId, state] of [...targetsById.entries()]) {
      if (state.page.isClosed()) {
        targetsById.delete(targetId);
        clearTab(state.backend, targetId);
        continue;
      }
      const lastActive = new Date(state.lastActiveAt).getTime();
      if (now - lastActive >= INACTIVITY_TIMEOUT_MS) {
        closedTargets.set(targetId, { closedAt: new Date().toISOString() });
        devtoolsCounters.targetsInactivityClosed += 1;
        targetsById.delete(targetId);
        clearTab(state.backend, targetId);
        state.page.close().catch(() => {});
      }
    }
    for (const [targetId, entry] of [...closedTargets.entries()]) {
      if (now - new Date(entry.closedAt).getTime() >= CLOSED_TARGET_RETENTION_MS) {
        closedTargets.delete(targetId);
      }
    }
  }, INACTIVITY_CHECK_INTERVAL_MS);
  inactivityInterval.unref();
}

startInactivityCleanup();

function safePageListener(label, handler) {
  return (...args) => {
    try {
      const result = handler(...args);
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          console.error(`⚠️  devtools ${label} listener error: ${String(error?.message || error)}`);
        });
      }
    } catch (error) {
      console.error(`⚠️  devtools ${label} listener error: ${String(error?.message || error)}`);
    }
  };
}

function installPageObservers(state) {
  const { page } = state;
  const pendingRequests = new Map();

  page.on("console", safePageListener("console", async (message) => {
    let args = [];
    try {
      const handles = await Promise.all(
        message.args().slice(0, 5).map(async (handle) => {
          try {
            return await handle.jsonValue();
          } catch {
            return handle.toString();
          }
        })
      );
      args = handles;
    } catch {
      args = [];
    }

    recordConsoleMessage(state, {
      type: message.type(),
      text: cleanWhitespace(message.text()),
      args,
      location: message.location(),
      timestamp: new Date().toISOString()
    });
  }));

  page.on("pageerror", safePageListener("pageerror", (error) => {
    recordConsoleMessage(state, {
      type: "pageerror",
      text: truncate(error?.stack || error?.message || String(error), 1000),
      timestamp: new Date().toISOString()
    });
  }));

  page.on("requestfailed", safePageListener("requestfailed", (request) => {
    const failure = request.failure();
    recordConsoleMessage(state, {
      type: "requestfailed",
      text: `${request.method()} ${request.url()}${failure?.errorText ? ` - ${failure.errorText}` : ""}`,
      timestamp: new Date().toISOString()
    });
  }));

  page.on("request", safePageListener("request", (request) => {
    pendingRequests.set(request, {
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType() || "other",
      startedAt: Date.now()
    });
  }));

  page.on("response", safePageListener("response", (response) => {
    const request = response.request();
    const pending = request ? pendingRequests.get(request) : null;
    recordNetworkRequest(state, {
      method: request ? request.method() : "?",
      url: response.url(),
      resourceType: request ? request.resourceType() || "other" : "other",
      status: response.status(),
      ok: response.ok(),
      fromCache: response.fromCache(),
      durationMs: pending ? Date.now() - pending.startedAt : null,
      failed: false,
      startedAt: pending?.startedAt || null
    });
    if (request) pendingRequests.delete(request);
  }));

  page.on("requestfailed", safePageListener("requestfailed", (request) => {
    const pending = pendingRequests.get(request);
    recordNetworkRequest(state, {
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType() || "other",
      status: null,
      ok: false,
      fromCache: false,
      durationMs: pending ? Date.now() - pending.startedAt : null,
      failed: true,
      error: request.failure()?.errorText || "request failed",
      startedAt: pending?.startedAt || null
    });
    pendingRequests.delete(request);
  }));

  page.on("framenavigated", safePageListener("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) return;
    state.lastActiveAt = new Date().toISOString();
    await refreshTitle(state);
  }));

  page.on("close", safePageListener("close", () => {
    targetsById.delete(state.targetId);
  }));
}

async function createTarget(args = {}) {
  const manager = await getBrowserManager();
  assertEnabled(manager);

  if (targetsById.size >= MAX_TARGETS) {
    throw new Error(`Too many open targets. Close a target before creating a new one (max ${MAX_TARGETS}).`);
  }

  const customTargetId = typeof args.targetId === "string" && args.targetId.trim()
    ? args.targetId.trim()
    : null;
  if (customTargetId && targetsById.has(customTargetId)) {
    throw new Error(`Target ${customTargetId} already exists. Use a different targetId or close the existing one.`);
  }

  let url = typeof args.url === "string" && args.url.trim() ? args.url.trim() : "about:blank";
  if (url === "about:blank" && args.ref_id !== undefined && args.ref_id !== null && Number(args.ref_id) > 0) {
    const ref = Number(args.ref_id);
    if (!Number.isInteger(ref)) {
      throw new Error(`Invalid input: ref_id must be a positive integer, got ${args.ref_id}`);
    }
    url = resolveRefIdToUrl(ref);
  }

  const viewport = parseViewport(args.viewport);
  const { page, browser: backend, rollbackNotes } = await resolveBrowserParam(
    { browser: typeof args.browser === "string" && args.browser.trim() ? args.browser.trim() : "" },
    manager.config,
    manager,
    { roles: ["devtools", "default"] }
  );

  if (viewport) await page.setViewport(viewport);

  const state = {
    targetId: customTargetId || randomBytes(6).toString("hex"),
    backend,
    page,
    consoleMessages: [],
    networkRequests: [],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    lastTitle: "",
    viewport,
    sourceUrl: url
  };

  installPageObservers(state);
  targetsById.set(state.targetId, state);
  devtoolsCounters.targetsCreated += 1;
  touchTab(backend, state.targetId);

  if (url !== "about:blank") {
    page.goto(url, {
      waitUntil: manager.config.navWaitUntil,
      timeout: manager.config.browserOpTimeoutMs
    }).then(
      () => refreshTitle(state),
      (error) => recordConsoleMessage(state, {
        type: "navigationerror",
        text: truncate(error?.message || String(error)),
        timestamp: new Date().toISOString()
      })
    );
  }
  return { ...buildTargetSummary(state), url, navigating: url !== "about:blank", ...(rollbackNotes?.length ? { rollbackNotes } : {}) };
}

async function listTargets() {
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const results = [];
  for (const state of targetsById.values()) {
    if (!state.page || state.page.isClosed()) continue;
    await refreshTitle(state);
    results.push(buildTargetSummary(state));
  }
  return {
    count: results.length,
    targets: results
  };
}

export { listTargets };

async function closeTarget(args = {}) {
  assertString(args.targetId, "targetId");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  await state.page.close();
  targetsById.delete(state.targetId);
  clearTab(state.backend, state.targetId);
  devtoolsCounters.targetsClosed += 1;
  return {
    targetId: state.targetId,
    closed: true
  };
}

export async function captureTargetScreenshot(args = {}) {
  assertString(args.targetId, "targetId");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);

  const normalizedFormat = "jpeg";
  const normalizedQuality =
    normalizedFormat === "jpeg"
      ? Math.max(1, Math.min(100, Math.floor(Number.isFinite(args.quality) ? args.quality : 75)))
      : undefined;
  const fullPage = args.fullPage === undefined ? true : Boolean(args.fullPage);
  const timeoutMs = Math.max(1000, Number(manager.config.browserOpTimeoutMs) || 60000);

  // ---- viewport handling: same style as Target.createTarget ----
  let normalizedViewport = null;
  if (args.viewport !== undefined && args.viewport !== null) {
    const vp = args.viewport;
    if (!vp || typeof vp !== "object" || Array.isArray(vp)) {
      throw new Error("Invalid input: viewport must be an object with width and height");
    }
    const hasWidth = Object.prototype.hasOwnProperty.call(vp, "width");
    const hasHeight = Object.prototype.hasOwnProperty.call(vp, "height");
    if (!hasWidth) throw new Error("Invalid input: viewport.width is required");
    const w = Math.floor(Number(vp.width));
    if (!Number.isFinite(w) || w <= 0) throw new Error("Invalid input: viewport.width must be a positive number");
    let h;
    if (hasHeight) {
      h = Math.floor(Number(vp.height));
      if (!Number.isFinite(h) || h <= 0) throw new Error("Invalid input: viewport.height must be a positive number");
    } else if (!fullPage) {
      throw new Error("Invalid input: viewport.height is required when fullPage is false");
    } else {
      h = 1080;
    }
    normalizedViewport = { width: w, height: h };
  }

  const vpLog = normalizedViewport ? `${normalizedViewport.width}x${normalizedViewport.height}` : "default";
  console.error(`📸  target screenshot: targetId=${args.targetId} format=${normalizedFormat} quality=${normalizedQuality ?? "default"} fullPage=${fullPage} viewport=${vpLog} timeout=${timeoutMs}ms`);

  let prevViewport = null;
  let didOverride = false;
  if (normalizedViewport) {
    try {
      prevViewport = state.page.viewport();
    } catch {}
    if (!prevViewport && state.viewport) prevViewport = { ...state.viewport };
    if (!prevViewport) prevViewport = { width: 1920, height: 1080 };
    console.error(`📸  target viewport override: ${prevViewport.width || "?"}x${prevViewport.height || "?"} → ${normalizedViewport.width}x${normalizedViewport.height}`);
    try {
      await state.page.setViewport(normalizedViewport);
      didOverride = true;
    } catch (e) {
      console.error(`📸  setViewport failed: ${String(e?.message || e)}`);
      throw e;
    }
  }

  let screenshot;
  try {
    screenshot = await Promise.race([
      state.page.screenshot({
        type: normalizedFormat,
        encoding: "base64",
        fullPage,
        ...(normalizedFormat === "jpeg" && normalizedQuality ? { quality: normalizedQuality } : {})
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Screenshot timed out after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  } catch (error) {
    console.error(`📸  target screenshot failed: targetId=${args.targetId} error=${String(error?.message || error)}`);
    if (error?.stack) console.error(`📸  stack: ${String(error.stack).slice(0, 500)}`);
    throw error;
  } finally {
    if (didOverride && prevViewport) {
      try {
        await state.page.setViewport(prevViewport);
        console.error(`📸  target viewport restored: ${prevViewport.width}x${prevViewport.height}`);
      } catch (e) {
        console.error(`📸  restore viewport failed: ${String(e?.message || e)}`);
      }
    }
  }

  const [resolvedUrl, pageTitle] = await Promise.all([
    Promise.resolve(state.page.url()),
    state.page.title()
  ]);

  await refreshTitle(state);

  return {
    targetId: state.targetId,
    url: resolvedUrl,
    title: pageTitle,
    format: normalizedFormat,
    contentType: normalizedFormat === "jpeg" ? "image/jpeg" : "image/png",
    sizeBytes: Buffer.byteLength(screenshot, "base64"),
    captureTimestamp: new Date().toISOString(),
    screenshotBase64: screenshot
  };
}

async function navigatePage(args = {}) {
  assertString(args.targetId, "targetId");
  assertString(args.url, "url");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  let state;
  try {
    state = getTargetState(args.targetId);
  } catch (error) {
    if (String(error?.message || "").includes("Unknown targetId")) {
      state = await createTarget({ targetId: args.targetId.trim(), url: args.url.trim() });
      return { ...state, created: true };
    }
    throw error;
  }
  await state.page.goto(args.url.trim(), {
    waitUntil: manager.config.navWaitUntil,
    timeout: manager.config.browserOpTimeoutMs
  });
  await refreshTitle(state);
  return { ...buildTargetSummary(state), created: false };
}

async function reloadPage(args = {}) {
  assertString(args.targetId, "targetId");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const ignoreCache = Boolean(args.ignoreCache);
  let cacheToggled = false;

  if (ignoreCache) {
    try {
      await state.page.setCacheEnabled(false);
      cacheToggled = true;
    } catch {
      // Some browser backends do not implement Network.setCacheDisabled.
    }
  }

  try {
    await state.page.reload({
      waitUntil: manager.config.navWaitUntil,
      timeout: manager.config.browserOpTimeoutMs
    });
  } finally {
    if (cacheToggled) {
      try {
        await state.page.setCacheEnabled(true);
      } catch {
        // Best-effort cache restoration after a supported hard refresh.
      }
    }
  }

  await refreshTitle(state);
  return { ...buildTargetSummary(state), reloaded: true, ignoreCache: cacheToggled };
}

async function goHistory(args = {}, direction) {
  assertString(args.targetId, "targetId");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const options = {
    waitUntil: manager.config.navWaitUntil,
    timeout: manager.config.browserOpTimeoutMs
  };
  const before = state.page.url();
  const response = direction === "forward"
    ? await state.page.goForward(options)
    : await state.page.goBack(options);
  await refreshTitle(state);
  const navigated = Boolean(response) || state.page.url() !== before;
  return { ...buildTargetSummary(state), direction, navigated };
}

async function dispatchKeyEvent(args = {}) {
  assertString(args.targetId, "targetId");
  assertString(args.key, "key");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const modifiers = Array.isArray(args.modifiers) ? args.modifiers.map(String) : [];

  for (const modifier of modifiers) await state.page.keyboard.down(modifier);
  try {
    await state.page.keyboard.press(args.key, args.text ? { text: String(args.text) } : {});
  } finally {
    for (const modifier of [...modifiers].reverse()) await state.page.keyboard.up(modifier);
  }

  await new Promise((resolve) => setTimeout(resolve, manager.config.humanTypingDelay || 0));
  return { ...buildTargetSummary(state), pressed: args.key, modifiers };
}

async function getNetworkRequests(args = {}) {
  assertString(args.targetId, "targetId");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const limit = Math.min(Math.max(1, Math.floor(Number(args.limit)) || 25), MAX_NETWORK_REQUESTS);
  const filter = typeof args.filter === "string" && args.filter.trim()
    ? args.filter.trim().toLowerCase()
    : null;
  const failedOnly = Boolean(args.failedOnly);
  const statusFilter = Number.isFinite(Number(args.status)) ? Number(args.status) : null;

  let entries = state.networkRequests;
  if (failedOnly) entries = entries.filter((entry) => entry.failed);
  if (filter) entries = entries.filter((entry) => entry.url.toLowerCase().includes(filter));
  if (statusFilter !== null) entries = entries.filter((entry) => entry.status === statusFilter);

  return {
    targetId: state.targetId,
    url: state.page.url(),
    total: state.networkRequests.length,
    shown: Math.min(entries.length, limit),
    failed: entries.filter((entry) => entry.failed).length,
    requests: entries.slice(-limit).reverse()
  };
}

async function evaluateRuntime(args = {}) {
  assertString(args.targetId, "targetId");
  assertString(args.expression, "expression");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const timeoutMs = Math.max(1000, Number(manager.config.browserOpTimeoutMs) || 60000);
  const result = await Promise.race([
    state.page.evaluate(async (expression) => {
    function cleanWhitespaceInner(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function cssPath(element) {
      if (!(element instanceof Element)) return null;
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
        let segment = node.tagName.toLowerCase();
        if (node.id) {
          segment += `#${node.id}`;
          parts.unshift(segment);
          break;
        }
        const siblings = node.parentElement
          ? Array.from(node.parentElement.children).filter((child) => child.tagName === node.tagName)
          : [];
        if (siblings.length > 1) {
          const index = siblings.indexOf(node);
          segment += `:nth-of-type(${index + 1})`;
        }
        parts.unshift(segment);
        node = node.parentElement;
      }
      return parts.join(" > ");
    }

    function xpathFor(element) {
      if (!(element instanceof Element)) return null;
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE) {
        let index = 1;
        let sibling = node.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === node.tagName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
        node = node.parentElement;
      }
      return `/${parts.join("/")}`;
    }

    function truncateText(value, maxChars) {
      const text = String(value || "");
      if (text.length <= maxChars) return text;
      return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
    }

    function elementAttributes(element) {
      const attrs = {};
      for (const attr of Array.from(element.attributes)) attrs[attr.name] = attr.value;
      return attrs;
    }

    function describeElement(element) {
      const rect = element.getBoundingClientRect();
      return {
        tagName: element.tagName.toLowerCase(),
        text: truncateText(cleanWhitespaceInner(element.innerText || element.textContent || ""), 500),
        value: "value" in element ? String(element.value || "") : "",
        selector: cssPath(element),
        xpath: xpathFor(element),
        attributes: elementAttributes(element),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    }

    function serialize(value, depth = 0, seen = new WeakSet()) {
      if (value === null || value === undefined) return value;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
      if (value instanceof Date) return value.toISOString();
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: String(value.stack || "").slice(0, 2000)
        };
      }
      if (value instanceof Element) return describeElement(value);
      if (value instanceof NodeList || value instanceof HTMLCollection || Array.isArray(value)) {
        const list = Array.from(value)
          .slice(0, 25)
          .map((item) => serialize(item, depth + 1, seen));
        const total = value.length;
        if (total > 25) list.push(`[+${total - 25} more]`);
        return list;
      }
      if (typeof value === "object") {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
        if (depth >= 4) return "[MaxDepth]";
        const out = {};
        const keys = Object.keys(value);
        for (const key of keys.slice(0, 25)) {
          out[key] = serialize(value[key], depth + 1, seen);
        }
        if (keys.length > 25) out["[+more keys]"] = keys.length - 25;
        return out;
      }
      return String(value);
    }

    let raw;
    try {
      raw = globalThis.eval(expression);
    } catch (evalError) {
      if (evalError instanceof SyntaxError) {
        raw = await new Function('return (async () => (' + expression + '))()')();
      } else {
        throw evalError;
      }
    }
    const awaited = raw && typeof raw.then === "function" ? await raw : raw;
    return serialize(awaited);
  }, args.expression),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Runtime evaluation timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);

  return {
    targetId: state.targetId,
    result
  };
}

async function getConsoleMessages(args = {}) {
  assertString(args.targetId, "targetId");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 30));
  return {
    targetId: state.targetId,
    count: state.consoleMessages.length,
    messages: state.consoleMessages.slice(-limit)
  };
}

async function getDocument(args = {}) {
  assertString(args.targetId, "targetId");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const limit = Math.max(1, Math.min(MAX_QUERY_RESULTS, Number(args.limit) || 15));
  const timeoutMs = Math.max(1000, Number(manager.config.browserOpTimeoutMs) || 60000);
  const result = await Promise.race([
    state.page.evaluate((limitValue) => {
    function cleanWhitespaceInner(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function cssPath(element) {
      if (!(element instanceof Element)) return null;
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
        let segment = node.tagName.toLowerCase();
        if (node.id) {
          segment += `#${node.id}`;
          parts.unshift(segment);
          break;
        }
        const siblings = node.parentElement
          ? Array.from(node.parentElement.children).filter((child) => child.tagName === node.tagName)
          : [];
        if (siblings.length > 1) {
          const index = siblings.indexOf(node);
          segment += `:nth-of-type(${index + 1})`;
        }
        parts.unshift(segment);
        node = node.parentElement;
      }
      return parts.join(" > ");
    }

    function xpathFor(element) {
      if (!(element instanceof Element)) return null;
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE) {
        let index = 1;
        let sibling = node.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === node.tagName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
        node = node.parentElement;
      }
      return `/${parts.join("/")}`;
    }

    function visible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function truncateText(value, maxChars) {
      const text = String(value || "");
      if (text.length <= maxChars) return text;
      return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
    }

    function elementAttributes(element) {
      const attrs = {};
      for (const attr of Array.from(element.attributes)) attrs[attr.name] = attr.value;
      return attrs;
    }

    function describe(element) {
      const rect = element.getBoundingClientRect();
      return {
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        text: truncateText(cleanWhitespaceInner(element.innerText || element.textContent || ""), 300),
        selector: cssPath(element),
        xpath: xpathFor(element),
        attributes: elementAttributes(element),
        value: "value" in element ? String(element.value || "") : "",
        visible: visible(element),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    }

    const selectors = [
      "main",
      "article",
      "h1",
      "h2",
      "button",
      "a[href]",
      "input",
      "textarea",
      "select",
      "[role='button']",
      "[role='link']",
      "[data-testid]"
    ];

    const nodes = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const key = cssPath(element);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        nodes.push(describe(element));
        if (nodes.length >= limitValue) break;
      }
      if (nodes.length >= limitValue) break;
    }

    return {
      title: document.title || "",
      url: location.href,
      readyState: document.readyState,
      elements: nodes
    };
  }, limit),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`getDocument timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);

  return {
    targetId: state.targetId,
    ...result
  };
}

async function querySelector(args = {}, multiple = false) {
  assertString(args.targetId, "targetId");
  if (!args.selector && !args.xpath) {
    throw new Error("Invalid input: provide selector or xpath");
  }

  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const limit = Math.max(1, Math.min(MAX_QUERY_RESULTS, Number(args.limit) || 10));
  const timeoutMs = Math.max(1000, Number(manager.config.browserOpTimeoutMs) || 60000);
  const rawSelector = typeof args.selector === "string" ? args.selector : "";
  const selector = rawSelector ? cleanCssSelector(rawSelector) : "";
  if (rawSelector && !selector) {
    throw new Error(
      `Invalid selector "${rawSelector}": only Playwright pseudo-classes (:has-text, :text, :visible, :hidden) were found, which the browser does not understand. ` +
      `Use a standard CSS selector (tag, .class, #id, [attribute]) or Runtime.evaluate for complex matching.`
    );
  }
  const result = await Promise.race([
    state.page.evaluate(({ selector, xpath, multiple: wantsMany, limit: limitValue }) => {
    function cleanWhitespaceInner(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function cssPath(element) {
      if (!(element instanceof Element)) return null;
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
        let segment = node.tagName.toLowerCase();
        if (node.id) {
          segment += `#${node.id}`;
          parts.unshift(segment);
          break;
        }
        const siblings = node.parentElement
          ? Array.from(node.parentElement.children).filter((child) => child.tagName === node.tagName)
          : [];
        if (siblings.length > 1) {
          const index = siblings.indexOf(node);
          segment += `:nth-of-type(${index + 1})`;
        }
        parts.unshift(segment);
        node = node.parentElement;
      }
      return parts.join(" > ");
    }

    function xpathFor(element) {
      if (!(element instanceof Element)) return null;
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE) {
        let index = 1;
        let sibling = node.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === node.tagName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
        node = node.parentElement;
      }
      return `/${parts.join("/")}`;
    }

    function visible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function truncateText(value, maxChars) {
      const text = String(value || "");
      if (text.length <= maxChars) return text;
      return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
    }

    function elementAttributes(element) {
      const attrs = {};
      for (const attr of Array.from(element.attributes)) attrs[attr.name] = attr.value;
      return attrs;
    }

    function describe(element) {
      const rect = element.getBoundingClientRect();
      return {
        tagName: element.tagName.toLowerCase(),
        text: truncateText(cleanWhitespaceInner(element.innerText || element.textContent || ""), 300),
        selector: cssPath(element),
        xpath: xpathFor(element),
        visible: visible(element),
        attributes: elementAttributes(element),
        value: "value" in element ? String(element.value || "") : "",
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    }

    function nodesFromXpath(expression) {
      const results = [];
      const snapshot = document.evaluate(expression, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let index = 0; index < snapshot.snapshotLength; index += 1) {
        const node = snapshot.snapshotItem(index);
        if (node instanceof Element) results.push(node);
      }
      return results;
    }

    const nodes = selector
      ? Array.from(document.querySelectorAll(selector))
      : nodesFromXpath(xpath);
    const described = nodes.slice(0, limitValue).map((node) => describe(node));
    return wantsMany ? described : described[0] || null;
  }, {
    selector,
    xpath: args.xpath || "",
    multiple,
    limit
  }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`querySelector timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);

  return {
    targetId: state.targetId,
    ...(multiple ? { count: result.length, elements: result } : { element: result })
  };
}

async function getOuterHtml(args = {}) {
  assertString(args.targetId, "targetId");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const maxChars = parseMaxChars(args.maxChars, DEFAULT_HTML_LIMIT);
  const timeoutMs = Math.max(1000, Number(manager.config.browserOpTimeoutMs) || 60000);
  const result = await Promise.race([
    state.page.evaluate(({ selector, xpath, maxChars: limit }) => {
    function cssPath(element) {
      if (!(element instanceof Element)) return null;
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
        let segment = node.tagName.toLowerCase();
        if (node.id) {
          segment += `#${node.id}`;
          parts.unshift(segment);
          break;
        }
        const siblings = node.parentElement
          ? Array.from(node.parentElement.children).filter((child) => child.tagName === node.tagName)
          : [];
        if (siblings.length > 1) {
          const index = siblings.indexOf(node);
          segment += `:nth-of-type(${index + 1})`;
        }
        parts.unshift(segment);
        node = node.parentElement;
      }
      return parts.join(" > ");
    }

    function xpathFor(element) {
      if (!(element instanceof Element)) return null;
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE) {
        let index = 1;
        let sibling = node.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === node.tagName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
        node = node.parentElement;
      }
      return `/${parts.join("/")}`;
    }

    function firstXpath(expression) {
      const node = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      return node instanceof Element ? node : null;
    }

    const smartRoot = document.querySelector("main, article, [role='main'], #content, .content") || document.documentElement;
    const element = selector
      ? document.querySelector(selector)
      : xpath
        ? firstXpath(xpath)
        : smartRoot;

    if (!(element instanceof Element)) {
      return {
        found: false,
        url: location.href,
        title: document.title,
        attempted: selector ? `selector=${selector}` : xpath ? `xpath=${xpath}` : "auto"
      };
    }

    const html = element.outerHTML || "";
    return {
      found: true,
      selector: cssPath(element),
      xpath: xpathFor(element),
      tagName: element.tagName.toLowerCase(),
      truncated: html.length > limit,
      html: html.length > limit ? `${html.slice(0, Math.max(0, limit - 3))}...` : html
    };
  }, {
    selector: args.selector || "",
    xpath: args.xpath || "",
    maxChars
  }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`getOuterHTML timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);

  if (!result || result.found === false) {
    const where = result?.attempted || (args.selector ? `selector=${args.selector}` : `xpath=${args.xpath}`);
    throw new Error(
      `Could not resolve element for DOM.getOuterHTML — ${where} matched nothing on ${result?.url || state.page.url()} (${result?.title || "no title"}). ` +
      `Use DOM.getDocument first to find a selector that exists on the current page.`
    );
  }

  return {
    targetId: state.targetId,
    ...result
  };
}

async function getCompactHtml(args = {}) {
  assertString(args.targetId, "targetId");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const maxChars = parseMaxChars(args.maxChars, DEFAULT_HTML_LIMIT);
  const timeoutMs = Math.max(1000, Number(manager.config.browserOpTimeoutMs) || 60000);
  const result = await Promise.race([
    state.page.evaluate(({ selector, xpath, maxChars: limit }) => {
      const KEEP_ATTRS = new Set([
        "href", "src", "alt", "title", "name", "type", "value", "role", "placeholder",
        "for", "target", "rel", "checked", "selected", "disabled", "readonly",
        "contenteditable", "width", "height", "colspan", "rowspan", "headers", "scope"
      ]);
      const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
      const NOISE_TAGS = new Set(["script", "style", "noscript", "template", "link", "meta", "iframe", "object", "embed", "canvas", "svg", "video", "audio"]);
      const PRESERVE_WS = new Set(["pre", "code", "textarea"]);

      function cssPath(element) {
        if (!(element instanceof Element)) return null;
        const parts = [];
        let node = element;
        while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
          let segment = node.tagName.toLowerCase();
          if (node.id) {
            segment += `#${node.id}`;
            parts.unshift(segment);
            break;
          }
          const siblings = node.parentElement
            ? Array.from(node.parentElement.children).filter((child) => child.tagName === node.tagName)
            : [];
          if (siblings.length > 1) {
            const index = siblings.indexOf(node);
            segment += `:nth-of-type(${index + 1})`;
          }
          parts.unshift(segment);
          node = node.parentElement;
        }
        return parts.join(" > ");
      }

      function xpathFor(element) {
        if (!(element instanceof Element)) return null;
        const parts = [];
        let node = element;
        while (node && node.nodeType === Node.ELEMENT_NODE) {
          let index = 1;
          let sibling = node.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === node.tagName) index += 1;
            sibling = sibling.previousElementSibling;
          }
          parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
          node = node.parentElement;
        }
        return `/${parts.join("/")}`;
      }

      function firstXpath(expression) {
        const node = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return node instanceof Element ? node : null;
      }

      function isNoiseAttr(name) {
        const low = name.toLowerCase();
        if (low === "id" || low === "class") return false;
        if (low === "style" || low.startsWith("on")) return true;
        if (low.startsWith("data-") || low.startsWith("aria-")) return false;
        return !KEEP_ATTRS.has(low);
      }

      function compact(node) {
        const root = node.cloneNode(true);
        const doomed = Array.from(root.querySelectorAll(Array.from(NOISE_TAGS).join(",")));
        const head = root.querySelector("head");
        if (head) doomed.push(head);
        doomed.forEach((el) => el.remove());

        const comments = [];
        const commentWalker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
        while (commentWalker.nextNode()) comments.push(commentWalker.currentNode);
        comments.forEach((c) => c.remove());

        const textNodes = [];
        const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (textWalker.nextNode()) textNodes.push(textWalker.currentNode);
        for (const textNode of textNodes) {
          const parentTag = textNode.parentElement ? textNode.parentElement.tagName.toLowerCase() : "";
          if (PRESERVE_WS.has(parentTag)) continue;
          if (!textNode.nodeValue.trim()) {
            textNode.remove();
            continue;
          }
          textNode.nodeValue = textNode.nodeValue.replace(/\s+/g, " ").trim();
        }

        let pass = 0;
        while (pass++ < 10) {
          let removed = false;
          for (const el of Array.from(root.querySelectorAll("*"))) {
            if (VOID_TAGS.has(el.tagName.toLowerCase())) continue;
            if (el.id) continue;
            if (el.children.length === 0 && !el.textContent.trim()) {
              el.remove();
              removed = true;
            }
          }
          if (!removed) break;
        }

        const all = [root, ...root.querySelectorAll("*")];
        for (const el of all) {
          for (const attr of Array.from(el.attributes)) {
            if (isNoiseAttr(attr.name)) el.removeAttribute(attr.name);
          }
          const cls = el.getAttribute("class");
          if (cls && cls.length > 120) el.setAttribute("class", cls.slice(0, 120));
        }

        return root;
      }

      const smartRoot = document.querySelector("main, article, [role='main'], #content, .content") || document.documentElement;
      const element = selector
        ? document.querySelector(selector)
        : xpath
          ? firstXpath(xpath)
          : smartRoot;

      if (!(element instanceof Element)) {
        return {
          found: false,
          url: location.href,
          title: document.title,
          attempted: selector ? `selector=${selector}` : xpath ? `xpath=${xpath}` : "auto"
        };
      }

      const charsBefore = element.outerHTML.length;
      const clean = compact(element);
      const html = clean.outerHTML || "";
      return {
        found: true,
        title: document.title || "",
        selector: cssPath(element),
        xpath: xpathFor(element),
        tagName: element.tagName.toLowerCase(),
        charsBefore,
        charsAfter: html.length,
        truncated: html.length > limit,
        html: html.length > limit ? `${html.slice(0, Math.max(0, limit - 3))}...` : html
      };
    }, {
      selector: args.selector || "",
      xpath: args.xpath || "",
      maxChars
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`getCompactHTML timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);

  if (!result || result.found === false) {
    const where = result?.attempted || (args.selector ? `selector=${args.selector}` : `xpath=${args.xpath}`);
    throw new Error(
      `Could not resolve element for DOM.getCompactHTML — ${where} matched nothing on ${result?.url || state.page.url()} (${result?.title || "no title"}). ` +
      `Use DOM.getDocument first to find a selector that exists on the current page.`
    );
  }

  return {
    targetId: state.targetId,
    ...result
  };
}

async function scrollIntoViewIfNeeded(args = {}) {
  assertString(args.targetId, "targetId");
  if (!args.selector && !args.xpath) {
    throw new Error("Invalid input: provide selector or xpath");
  }

  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const timeoutMs = Math.max(1000, Number(manager.config.browserOpTimeoutMs) || 60000);
  const result = await Promise.race([
    state.page.evaluate(({ selector, xpath }) => {
    function firstXpath(expression) {
      const node = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      return node instanceof Element ? node : null;
    }

    function elementAttributes(element) {
      const attrs = {};
      for (const attr of Array.from(element.attributes)) attrs[attr.name] = attr.value;
      return attrs;
    }

    const element = selector
      ? document.querySelector(selector)
      : firstXpath(xpath);
    if (!(element instanceof Element)) {
      return {
        found: false,
        url: location.href,
        title: document.title,
        attempted: selector ? `selector=${selector}` : `xpath=${xpath}`,
        candidates: Array.from(document.querySelectorAll("input, textarea, select, button, a[href], [role='button'], [role='link']"))
          .slice(0, 10)
          .map((el) => ({ tag: el.tagName.toLowerCase(), attrs: elementAttributes(el) }))
      };
    }
    element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    const rect = element.getBoundingClientRect();
    return {
      found: true,
      tagName: element.tagName.toLowerCase(),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }, {
    selector: args.selector || "",
    xpath: args.xpath || ""
  }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`scrollIntoViewIfNeeded timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);

  if (!result || result.found === false) {
    const attempted = args.selector ? `selector=${args.selector}` : `xpath=${args.xpath}`;
    const hint = result?.candidates?.length
      ? ` Matches nothing; interactive elements present: ${JSON.stringify(result.candidates)}`
      : "";
    throw new Error(
      `Could not resolve element for DOM.scrollIntoViewIfNeeded — ${attempted} matched nothing on ${result?.url || state.page.url()} (${result?.title || "no title"}).${hint} ` +
      `Use DOM.getDocument first to find a selector that exists on the current page.`
    );
  }

  return {
    targetId: state.targetId,
    ...result
  };
}

function isNavigationError(error) {
  return /execution context was destroyed|cannot find context with specified id|target closed/i.test(String((error && error.message) || error));
}

async function dispatchMouseEvent(args = {}) {
  assertString(args.targetId, "targetId");
  if (!args.selector && !args.xpath) {
    throw new Error("Invalid input: provide selector or xpath");
  }

  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const button = ["left", "right", "middle"].includes(String(args.button || "").toLowerCase())
    ? String(args.button).toLowerCase()
    : "left";
  const clickCount = Math.max(1, Math.min(3, Number(args.clickCount) || 1));
  const timeoutMs = Math.max(1000, Number(manager.config.browserOpTimeoutMs) || 60000);
  const attempted = args.selector ? `selector=${args.selector}` : `xpath=${args.xpath}`;

  const withTimeout = (task, label) =>
    Promise.race([
      task(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);

  const resolvePoint = () =>
    withTimeout(
      () =>
        state.page.evaluate(
          ({ selector, xpath }) => {
            function firstXpath(expression) {
              const node = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
              return node instanceof Element ? node : null;
            }

            function elementAttributes(element) {
              const attrs = {};
              for (const attr of Array.from(element.attributes)) attrs[attr.name] = attr.value;
              return attrs;
            }

            const element = selector
              ? document.querySelector(selector)
              : firstXpath(xpath);
            if (!(element instanceof Element)) {
              return {
                found: false,
                url: location.href,
                title: document.title,
                attempted: selector ? `selector=${selector}` : `xpath=${xpath}`,
                candidates: Array.from(document.querySelectorAll("button, a[href], [role='button'], [role='link'], input[type='button'], input[type='submit']"))
                  .slice(0, 10)
                  .map((el) => ({ tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || "").trim().slice(0, 60), attrs: elementAttributes(el) }))
              };
            }
            element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
            const rect = element.getBoundingClientRect();
            return {
              found: true,
              x: rect.left + Math.max(1, rect.width / 2),
              y: rect.top + Math.max(1, rect.height / 2),
              tagName: element.tagName.toLowerCase()
            };
          },
          { selector: args.selector || "", xpath: args.xpath || "" }
        ),
      "Element resolution"
    );

  const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

  // Resolving the click point can itself race a navigation (e.g. the tab was
  // just created and is still committing). Retry once against the settled page
  // so the caller can act on the page that actually finished loading.
  let point;
  try {
    point = await resolvePoint();
  } catch (error) {
    if (!isNavigationError(error)) throw error;
    await settle();
    try {
      point = await resolvePoint();
    } catch (error2) {
      if (!isNavigationError(error2)) throw error2;
      throw new Error(`Input.dispatchMouseEvent — page kept navigating; could not resolve ${attempted}.`);
    }
  }

  if (!point || point.found === false) {
    const hint = point?.candidates?.length
      ? ` Matches nothing; clickable elements present: ${JSON.stringify(point.candidates)}`
      : "";
    throw new Error(
      `Could not resolve element for Input.dispatchMouseEvent — ${attempted} matched nothing on ${point?.url || state.page.url()} (${point?.title || "no title"}).${hint} ` +
      `Use DOM.getDocument first to find a selector that exists on the current page.`
    );
  }

  // A click on a navigation link (or an element that triggers a SPA route) can
  // destroy the execution context before the mouse event finishes — Puppeteer
  // then reports e.g. "Execution context was destroyed, most likely because the
  // page navigated". The click itself succeeded. Track main-frame navigations
  // across the click, downgrade that specific failure to a success result, and
  // tell the caller where the page went so the LLM stays in the loop.
  const beforeUrl = state.page.url();
  let mainFrameNavigated = false;
  const onFrameNavigated = (frame) => {
    if (frame === state.page.mainFrame()) mainFrameNavigated = true;
  };
  state.page.on("framenavigated", onFrameNavigated);

  try {
    await withTimeout(() => state.page.mouse.click(point.x, point.y, { button, clickCount }), "Mouse click");
  } catch (error) {
    if (!isNavigationError(error)) throw error;
    // Give the new document a beat to commit before judging navigation state.
    await settle();
    const navigated = mainFrameNavigated || state.page.url() !== beforeUrl;
    if (!navigated) throw error;
    await refreshTitle(state).catch(() => {});
    return {
      targetId: state.targetId,
      clicked: true,
      button,
      clickCount,
      point,
      navigated: true,
      url: state.page.url(),
      title: state.lastTitle,
      note: "Click triggered a navigation; the execution context was destroyed mid-click (expected)."
    };
  } finally {
    state.page.off("framenavigated", onFrameNavigated);
  }

  await refreshTitle(state);
  const navigated = mainFrameNavigated || state.page.url() !== beforeUrl;
  return {
    targetId: state.targetId,
    clicked: true,
    button,
    clickCount,
    point,
    navigated,
    url: state.page.url(),
    title: state.lastTitle
  };
}

async function insertText(args = {}) {
  assertString(args.targetId, "targetId");
  assertString(args.text, "text");
  if (!args.selector && !args.xpath) {
    throw new Error("Invalid input: provide selector or xpath");
  }

  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(args.targetId);
  const timeoutMs = Math.max(1000, Number(manager.config.browserOpTimeoutMs) || 60000);
  const point = await Promise.race([
    state.page.evaluate(({ selector, xpath }) => {
    function firstXpath(expression) {
      const node = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      return node instanceof Element ? node : null;
    }

    function elementAttributes(element) {
      const attrs = {};
      for (const attr of Array.from(element.attributes)) attrs[attr.name] = attr.value;
      return attrs;
    }

    const element = selector
      ? document.querySelector(selector)
      : firstXpath(xpath);
    if (!(element instanceof HTMLElement)) {
      return {
        found: false,
        url: location.href,
        title: document.title,
        attempted: selector ? `selector=${selector}` : `xpath=${xpath}`,
        candidates: Array.from(document.querySelectorAll("input, textarea, select, [contenteditable='true']"))
          .slice(0, 10)
          .map((el) => ({ tag: el.tagName.toLowerCase(), attrs: elementAttributes(el) }))
      };
    }
    element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    const rect = element.getBoundingClientRect();
    element.focus();
    const focused = document.activeElement === element || (document.activeElement || {}).contains?.(element) === true;
    const isContentEditable = element.isContentEditable === true;
    const hadValue = "value" in element ? Boolean(element.value) : isContentEditable ? Boolean(element.textContent) : false;
    if ("value" in element) {
      element.value = "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (isContentEditable) {
      element.textContent = "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return {
      found: true,
      x: rect.left + Math.max(1, rect.width / 2),
      y: rect.top + Math.max(1, rect.height / 2),
      tagName: element.tagName.toLowerCase(),
      focused,
      clearedExistingValue: hadValue,
      readonly: Boolean(element.getAttribute?.("readonly")) || Boolean(element.getAttribute?.("disabled"))
    };
  }, {
    selector: args.selector || "",
    xpath: args.xpath || ""
  }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Element resolution timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);

  if (!point || point.found === false) {
    const attempted = args.selector ? `selector=${args.selector}` : `xpath=${args.xpath}`;
    const hint = point?.candidates?.length
      ? ` Matches nothing; editable elements present: ${JSON.stringify(point.candidates)}`
      : "";
    throw new Error(
      `Could not resolve element for Input.insertText — ${attempted} matched nothing on ${point?.url || state.page.url()} (${point?.title || "no title"}).${hint} ` +
      `Use DOM.getDocument first to find a selector that exists on the current page.`
    );
  }

  await Promise.race([
    state.page.mouse.click(point.x, point.y, { button: "left", clickCount: 1 }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Mouse click timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
  await Promise.race([
    state.page.keyboard.type(args.text, { delay: manager.config.humanTypingDelay }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Keyboard type timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);

  let finalValue = null;
  try {
    finalValue = await Promise.race([
      state.page.evaluate(({ selector, xpath }) => {
        function firstXpath(expression) {
          const node = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          return node instanceof Element ? node : null;
        }
        const element = selector
          ? document.querySelector(selector)
          : firstXpath(xpath);
        if (!(element instanceof Element)) return null;
        return {
          value: "value" in element ? String(element.value || "") : (element.textContent || ""),
          tagName: element.tagName.toLowerCase()
        };
      }, { selector: args.selector || "", xpath: args.xpath || "" }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Value readback timed out after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  } catch (error) {
    console.error(`⌨️  insertText value readback failed: ${String(error?.message || error)}`);
  }

  return {
    targetId: state.targetId,
    insertedText: true,
    length: args.text.length,
    point,
    focused: Boolean(point.focused),
    clearedExistingValue: Boolean(point.clearedExistingValue),
    finalValue: finalValue?.value ?? null,
    valueReadback: finalValue?.value !== undefined
  };
}

export const devtoolsToolDefinitions = [
  {
    name: "Target.createTarget",
    description: "Create a persistent browser tab for interactive testing. Provide a url, ref_id, and optional viewport to apply before navigation. Targets close automatically after 5 minutes of no interaction. The tab opens in the browser given by the `browser` param (chromium default, or an add-on name from list_browsers); when omitted, browsers with a devtools role are preferred, falling back to chromium.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Optional custom target id. If omitted, a random id is generated." },
        url: { type: "string", description: "Optional starting URL. Defaults to about:blank." },
        ref_id: { type: "number", description: "Optional numeric reference from a prior web_search or web_fetch to open. Overridden by url when both are given." },
        browser: { type: "string", description: "Browser to use (chromium default, or an add-on name from list_browsers)." },
        viewport: {
          type: "object",
          description: "Optional page viewport applied before navigation, e.g. { width: 390, height: 844 }.",
          properties: {
            width: { type: "number", description: "Viewport width in CSS pixels." },
            height: { type: "number", description: "Viewport height in CSS pixels." }
          },
          required: ["width", "height"],
          additionalProperties: false
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "Target.getTargets",
    description: "List open persistent testing tabs created through Target.createTarget.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "Target.closeTarget",
    description: "Close a persistent testing tab.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string" }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "Page.navigate",
    description: "Navigate an existing testing tab to a new URL. If the targetId does not exist, a new tab is created with that id (the response includes created: true).",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        url: { type: "string", description: "The URL to navigate to." }
      },
      required: ["targetId", "url"],
      additionalProperties: false
    }
  },
  {
    name: "Page.reload",
    description: "Reload the current page in an existing testing tab. Set ignoreCache: true for a hard refresh that bypasses the HTTP cache during the reload.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        ignoreCache: { type: "boolean", default: false, description: "Hard refresh: disable the HTTP cache for this reload, then re-enable it." }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "Page.goBack",
    description: "Navigate to the previous entry in the tab's session history (browser back button). Returns navigated: false when there is no back history.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "Page.goForward",
    description: "Navigate to the next entry in the tab's session history (browser forward button). Returns navigated: false when there is no forward history.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "Runtime.evaluate",
    description: "Evaluate a JavaScript expression in the page context and return the result serialized as JSON. Objects/arrays are capped at 25 entries (with a [+more] marker) and depth 4; [Circular] and [MaxDepth] markers indicate truncation.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        expression: { type: "string", description: "JavaScript expression to evaluate in the page." }
      },
      required: ["targetId", "expression"],
      additionalProperties: false
    }
  },
  {
    name: "Runtime.getConsoleMessages",
    description: "Read captured console, page error, and request failure messages for a testing tab.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string" },
        limit: { type: "number", default: 30 }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "Network.getRequests",
    description: "List the network requests the tab has made (per-target rolling buffer of the last 200). Each entry shows method, url, status, resourceType, ok/failed, and fromCache. Filter by URL substring, failed-only, or exact status. Useful to see what a page actually loaded and which requests failed.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        limit: { type: "number", default: 25, description: "Max requests to return (newest first), 1-200." },
        filter: { type: "string", description: "Case-insensitive substring matched against the request URL." },
        failedOnly: { type: "boolean", default: false, description: "Return only failed requests." },
        status: { type: "number", description: "Return only requests with this HTTP status (e.g. 404)." }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "DOM.getDocument",
    description: "Return an LLM-friendly page snapshot with important elements, selectors, and xpaths. The attributes map reflects the element's REAL DOM attributes (only attributes that actually exist on the element are listed) plus a value field for form fields. Use this before selector-based tools to discover valid selectors.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        limit: { type: "number", default: 15, description: "Max elements to include in the snapshot." }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "DOM.querySelector",
    description: "Query a single element by CSS selector or xpath and return its selector, xpath, text, attributes (real DOM attributes only), value, and bounding rect. Returns an error with the page URL and candidate elements if nothing matches.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        selector: { type: "string", description: "CSS selector, e.g. \"input[type='password']\"." },
        xpath: { type: "string", description: "XPath, e.g. \"/html/body/form/div[2]/input\"." }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "DOM.querySelectorAll",
    description: "Query multiple elements and return LLM-friendly descriptors (selector, xpath, text, attributes, value).",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        selector: { type: "string", description: "CSS selector to match many elements." },
        xpath: { type: "string", description: "XPath to match many elements." },
        limit: { type: "number", default: 10, description: "Max descriptors to return." }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "DOM.getOuterHTML",
    description: "Get outerHTML for a selector/xpath, or smart main content HTML when no locator is provided. The truncated field reports whether maxChars cut the output.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        selector: { type: "string", description: "CSS selector, e.g. \"main\"." },
        xpath: { type: "string", description: "XPath." },
        maxChars: { type: "number", default: DEFAULT_HTML_LIMIT, description: "Max characters of HTML to return." }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "DOM.getCompactHTML",
    description: "Get minimized HTML for a selector/xpath, or smart main content HTML when no locator is provided. Strips scripts, styles, comments, svg, iframes, head, and non-essential attributes; collapses whitespace; drops empty elements. Returns a single-line minified string — use for fast DOM debugging without raw-page noise. The truncated field reports whether maxChars cut the output.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        selector: { type: "string", description: "CSS selector, e.g. \"main\"." },
        xpath: { type: "string", description: "XPath." },
        maxChars: { type: "number", default: DEFAULT_HTML_LIMIT, description: "Max characters of HTML to return." }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "DOM.scrollIntoViewIfNeeded",
    description: "Scroll an element into view using selector or xpath. Returns an error listing interactive elements on the page if the selector matches nothing.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        selector: { type: "string", description: "CSS selector." },
        xpath: { type: "string", description: "XPath." }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "Input.dispatchMouseEvent",
    description: "Click an element by selector or xpath using the page mouse. Returns an error with the page URL and candidate clickable elements if the selector matches nothing.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        selector: { type: "string", description: "CSS selector of the element to click." },
        xpath: { type: "string", description: "XPath of the element to click." },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          default: "left"
        },
        clickCount: { type: "number", default: 1 }
      },
      required: ["targetId"],
      additionalProperties: false
    }
  },
  {
    name: "Input.insertText",
    description: "Focus an input-like element, clear any existing value, and type text into it via the keyboard. Requires selector or xpath. The response reports focused, clearedExistingValue, and finalValue (the element's value read back after typing). Returns an error with the page URL and editable element candidates if the selector matches nothing.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        selector: { type: "string", description: "CSS selector of the editable element, e.g. \"input[type='password']\"." },
        xpath: { type: "string", description: "XPath of the editable element." },
        text: { type: "string", description: "The text to type. Clears any existing value first." }
      },
      required: ["targetId", "text"],
      additionalProperties: false
    }
  },
  {
    name: "Input.dispatchKeyEvent",
    description: "Press a keyboard key in the page, such as Enter, Tab, Escape, Backspace, ArrowUp, F1-F12, Space, or a character, optionally with modifier keys held down. Synthetic key events cannot trigger browser-level shortcuts such as Ctrl+R or F12; use Page.reload for refreshing.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Target id from Target.createTarget." },
        key: { type: "string", description: "Key to press: a single character or a key name such as Enter, Tab, Escape, ArrowUp, F1-F12, Space, Meta, Control, Shift, or Alt." },
        modifiers: { type: "array", items: { type: "string" }, description: "Modifier keys to hold during the press, e.g. [\"Shift\", \"Control\"]. Pressed in array order and released in reverse." },
        text: { type: "string", description: "Optional text to inject for the key (used for keys that insert text)." }
      },
      required: ["targetId", "key"],
      additionalProperties: false
    }
  }
];

export { createTarget, closeTarget, navigatePage };

export async function getPageContent(targetId) {
  assertString(targetId, "targetId");
  const manager = await getBrowserManager();
  assertEnabled(manager);
  const state = getTargetState(targetId);
  const html = await state.page.content();
  return html;
}

export async function handleDevtoolsToolCall(name, args = {}) {
  if (name === "Target.createTarget") return createTarget(args);
  if (name === "Target.getTargets") return listTargets(args);
  if (name === "Target.closeTarget") return closeTarget(args);
  if (name === "Page.navigate") return navigatePage(args);
  if (name === "Page.reload") return reloadPage(args);
  if (name === "Page.goBack") return goHistory(args, "back");
  if (name === "Page.goForward") return goHistory(args, "forward");
  if (name === "Runtime.evaluate") return evaluateRuntime(args);
  if (name === "Runtime.getConsoleMessages") return getConsoleMessages(args);
  if (name === "Network.getRequests") return getNetworkRequests(args);
  if (name === "DOM.getDocument") return getDocument(args);
  if (name === "DOM.querySelector") return querySelector(args, false);
  if (name === "DOM.querySelectorAll") return querySelector(args, true);
  if (name === "DOM.getOuterHTML") return getOuterHtml(args);
  if (name === "DOM.getCompactHTML") return getCompactHtml(args);
  if (name === "DOM.scrollIntoViewIfNeeded") return scrollIntoViewIfNeeded(args);
  if (name === "Input.dispatchMouseEvent") return dispatchMouseEvent(args);
  if (name === "Input.insertText") return insertText(args);
  if (name === "Input.dispatchKeyEvent") return dispatchKeyEvent(args);
  throw new Error(`Unknown developer browser tool: ${name}`);
}

export function formatDevtoolsToolResponse(name, payload) {
  const lines = [name];
  lines.push("", "```json", JSON.stringify(payload, null, 2), "```");
  return {
    content: [
      {
        type: "text",
        text: lines.join("\n")
      }
    ]
  };
}
