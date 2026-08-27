import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SUPPORTED_ENGINES } from "./engines/index.js";
import { getEnvFilePath, parseEnvFile, readEnvFile } from "./env-file.js";

const execFileAsync = promisify(execFile);

const WAIT_UNTIL_VALUES = new Set([
  "load",
  "domcontentloaded",
  "networkidle0",
  "networkidle2"
]);

const SEARCH_ENGINE_VALUES = new Set(SUPPORTED_ENGINES);

const BROWSER_BACKEND_VALUES = new Set(["chromium", "cloakbrowser", "lightpanda"]);

const BROWSER_ROLE_VALUES = new Set(["default", "search", "fetch", "screenshot", "devtools"]);

const STABILIZE_STRATEGY_VALUES = new Set([
  "network_idle",
  "content_idle",
  "mutation",
  "none"
]);

export function parseStabilizeStrategy(value, fallback) {
  if (value && STABILIZE_STRATEGY_VALUES.has(value)) return value;
  return fallback;
}

export function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function parseNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function parseInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function parsePort(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return fallback;
  return parsed;
}

export function parseEngines(value, fallback) {
  if (!value || typeof value !== "string") return fallback;
  const parsed = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .filter((item) => SEARCH_ENGINE_VALUES.has(item));
  return parsed.length ? [...new Set(parsed)] : fallback;
}

export function parseToolList(value) {
  if (!value || typeof value !== "string") return [];
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(parsed)];
}

export function parseSelectorList(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (!text) return [];
  const parsed = text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(parsed)];
}

export function parseApiKeys(value) {
  if (!value || typeof value !== "string") return [];
  return [...new Set(value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean))];
}

const POST_PROCESSOR_KINDS = new Set(["chat", "mineru", "api"]);
const POST_PROCESSOR_INPUTS = new Set(["html", "text", "screenshot"]);

export function parsePostProcessorKind(value, fallback = "chat") {
  const normalized = String(value || "").trim().toLowerCase();
  return POST_PROCESSOR_KINDS.has(normalized) ? normalized : fallback;
}

export function parsePostProcessorInputs(value) {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(",").map((s) => s.trim()).filter(Boolean);
  const valid = raw.filter((v) => POST_PROCESSOR_INPUTS.has(v));
  return valid.length ? valid : undefined;
}

const deprecatedWarned = new Set();

// Read a config env var with one or more deprecated fallbacks. Newest name wins;
// using an old name logs a one-time warning so the migration is visible but not noisy.
export function readConfigEnv(newKey, ...legacyKeys) {
  if (process.env[newKey] !== undefined) return process.env[newKey];
  for (const legacyKey of legacyKeys) {
    if (process.env[legacyKey] !== undefined) {
      if (!deprecatedWarned.has(legacyKey)) {
        deprecatedWarned.add(legacyKey);
        console.warn(`[config] ${legacyKey} is deprecated — use ${newKey} instead. It still works but will be removed in a future release.`);
      }
      return process.env[legacyKey];
    }
  }
  return undefined;
}

export function parsePostProcessorModels(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const entries = parsed
      .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim())
      .map((entry) => ({
        id: String(entry.id).trim(),
        label: typeof entry.label === "string" && entry.label.trim()
          ? String(entry.label).trim()
          : String(entry.id).trim(),
        model: typeof entry.model === "string" && entry.model.trim()
          ? String(entry.model).trim()
          : null,
        baseUrl: typeof entry.baseUrl === "string" && entry.baseUrl.trim()
          ? String(entry.baseUrl).trim().replace(/\/+$/, "")
          : null,
        kind: parsePostProcessorKind(entry.kind),
        inputs: parsePostProcessorInputs(entry.inputs),
        path: typeof entry.path === "string" ? entry.path : undefined,
        method: typeof entry.method === "string" ? entry.method : undefined,
        body: entry.body,
        headers: entry.headers && typeof entry.headers === "object" ? entry.headers : undefined,
        outputField: typeof entry.outputField === "string" ? entry.outputField : undefined,
        outputType: typeof entry.outputType === "string" ? entry.outputType : undefined,
        prompt: typeof entry.prompt === "string" ? entry.prompt : undefined,
        timeoutMs: typeof entry.timeoutMs === "number" && entry.timeoutMs > 0 ? entry.timeoutMs : undefined,
        maxInputChars: typeof entry.maxInputChars === "number" && entry.maxInputChars > 0 ? entry.maxInputChars : undefined,
        maxTokens: typeof entry.maxTokens === "number" && entry.maxTokens > 0 ? entry.maxTokens : undefined,
      }))
      .filter((entry) => (entry.kind === "api" ? entry.baseUrl : entry.model && entry.baseUrl));
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

export function parseBrowserBackend(value, fallback = "cloakbrowser") {
  const normalizedFallback = BROWSER_BACKEND_VALUES.has(fallback) ? fallback : "cloakbrowser";
  const normalized = String(value || "").trim().toLowerCase();
  return BROWSER_BACKEND_VALUES.has(normalized) ? normalized : normalizedFallback;
}

export function parseBrowsers(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;

    const browsers = parsed
      .filter((entry) => entry && typeof entry === "object" && typeof entry.name === "string" && entry.name.trim())
      .map((entry, idx) => {
        const name = String(entry.name).trim();

        // Parse role array
        let role = ["default"];
        if (Array.isArray(entry.role)) {
          role = entry.role
            .filter((r) => typeof r === "string" && BROWSER_ROLE_VALUES.has(r.trim().toLowerCase()))
            .map((r) => r.trim().toLowerCase());
          if (!role.length) role = ["default"];
        } else if (typeof entry.role === "string" && BROWSER_ROLE_VALUES.has(entry.role.trim().toLowerCase())) {
          role = [entry.role.trim().toLowerCase()];
        }

        // Parse index (priority order — lower = tried first)
        const index = typeof entry.index === "number" && entry.index >= 0 ? entry.index : idx;

        // Parse cdpUrl (presence makes this an add-on)
        const cdpUrl = typeof entry.cdpUrl === "string" && entry.cdpUrl.trim()
          ? String(entry.cdpUrl).trim()
          : undefined;

        // Parse connect (built-in driver type for add-ons)
        const connect = typeof entry.connect === "string" && entry.connect.trim()
          ? String(entry.connect).trim().toLowerCase()
          : undefined;

        return { name, role, index, cdpUrl, connect, addOn: !!cdpUrl };
      })
      .filter((entry) => entry.name);

    return browsers.length ? browsers : null;
  } catch {
    return null;
  }
}

function ensureChromiumPresent(browsers) {
  if (!browsers) browsers = [];
  if (!browsers.some((b) => b.name === "chromium")) {
    const maxIndex = browsers.reduce((max, b) => Math.max(max, b.index), -1);
    browsers.push({
      name: "chromium",
      role: ["default"],
      index: maxIndex + 1,
      cdpUrl: undefined,
      connect: undefined,
      addOn: false,
    });
  }
  return browsers;
}

export function formatBrowserBackendShort(value) {
  const backend = parseBrowserBackend(value);
  if (backend === "cloakbrowser") return "cb";
  if (backend === "chromium") return "ch";
  return "lp";
}

async function canAccess(path) {
  try {
    await fs.access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutableInPath(command) {
  try {
    const { stdout } = await execFileAsync("which", [command]);
    const resolved = stdout.trim();
    if (!resolved) return null;
    return (await canAccess(resolved)) ? resolved : null;
  } catch {
    return null;
  }
}

export async function resolveChromePath() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && (await canAccess(fromEnv))) {
    return fromEnv;
  }

  const knownPaths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];

  for (const candidate of knownPaths) {
    if (await canAccess(candidate)) {
      return candidate;
    }
  }

  const pathCandidates = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
  for (const candidate of pathCandidates) {
    const resolved = await findExecutableInPath(candidate);
    if (resolved) return resolved;
  }

  throw new Error(
    "Could not resolve Chromium executable. Set CHROME_PATH to a valid browser binary."
  );
}

export async function findCloakbrowserPath() {
  const fromEnv = process.env.CLOAKBROWSER_BINARY_PATH;
  if (fromEnv && (await canAccess(fromEnv))) {
    return fromEnv;
  }

  const homeDir = os.homedir?.() || process.env.HOME || "/root";
  const knownPaths = [
    `${homeDir}/.cloakbrowser/chromium-146.0.7680.177.5/chrome`,
    `${homeDir}/.cloakbrowser/chromium-*/chrome`,
    "/usr/local/bin/cloakbrowser-chrome"
  ];

  for (const candidate of knownPaths) {
    if (candidate.includes("*")) {
      const parts = candidate.split("*");
      const prefix = parts[0];
      try {
        const entries = await fs.readdir(path.dirname(prefix));
        const matching = entries
          .filter((entry) => entry.startsWith(path.basename(prefix)))
          .sort()
          .reverse();
        for (const match of matching) {
          const fullPath = path.join(path.dirname(prefix), match, "chrome");
          if (await canAccess(fullPath)) return fullPath;
        }
      } catch {
        continue;
      }
    } else if (await canAccess(candidate)) {
      return candidate;
    }
  }

  try {
    await import("cloakbrowser/puppeteer");
    const { ensureBinary } = await import("cloakbrowser/dist/download.js");
    const binaryPath = await ensureBinary();
    return binaryPath;
  } catch {
    return null;
  }
}

export async function findLightpandaPath() {
  const fromEnv = process.env.LIGHTPANDA_PATH;
  if (fromEnv && (await canAccess(fromEnv))) {
    return fromEnv;
  }

  const knownPaths = [
    "/usr/local/bin/lightpanda",
    "/usr/bin/lightpanda"
  ];

  for (const candidate of knownPaths) {
    if (await canAccess(candidate)) {
      return candidate;
    }
  }

  const pathCandidates = ["lightpanda", "stealthpanda"];
  for (const candidate of pathCandidates) {
    const resolved = await findExecutableInPath(candidate);
    if (resolved) return resolved;
  }

  return null;
}

const headlessDefault = !process.env.DISPLAY;
export const DEFAULT_MAX_CHARS = parseInteger(process.env.WEB_FETCH_MAX_CHARS, 90000);
export const DEFAULT_SEARCH_ENABLED_ENGINES = Object.freeze([
  "duckduckgo_api",
  "brave",
  "google",
  "duckduckgo",
  "bing",
  "mojeek",
  "yahoo",
  "startpage"
]);

async function applyEnvFileToProcessEnv() {
  try {
    const filePath = getEnvFilePath();
    const text = await readEnvFile(filePath);
    if (!text) return;
    const { keyToLine } = parseEnvFile(text);
    for (const [key, entry] of keyToLine) {
      if (entry.hasValue) process.env[key] = entry.value;
    }
  } catch (error) {
    // Keep process.env as-is if the env file is missing or unreadable.
  }
}

function synthesizeBrowsersFromLegacy() {
  const defaultBackend = parseBrowserBackend(process.env.BROWSER_BACKEND, "chromium");
  const devtoolsBackend = parseBrowserBackend(
    process.env.DEVTOOLS_BROWSER_BACKEND,
    defaultBackend
  );

  const browsers = [];
  const seen = new Set();

  // Default backend (does everything)
  if (!seen.has(defaultBackend)) {
    browsers.push({ name: defaultBackend, role: ["default"], index: 0, cdpUrl: undefined, connect: undefined, addOn: false });
    seen.add(defaultBackend);
  }
  // Devtools backend
  if (!seen.has(devtoolsBackend)) {
    browsers.push({ name: devtoolsBackend, role: ["devtools"], index: browsers.length, cdpUrl: undefined, connect: undefined, addOn: false });
    seen.add(devtoolsBackend);
  }
  // Lightpanda for search
  if (!seen.has("lightpanda")) {
    browsers.push({ name: "lightpanda", role: ["search"], index: browsers.length, cdpUrl: undefined, connect: undefined, addOn: false });
    seen.add("lightpanda");
  }

  // Ensure Chromium is always present
  if (!browsers.some((b) => b.name === "chromium")) {
    browsers.push({ name: "chromium", role: ["default"], index: browsers.length, cdpUrl: undefined, connect: undefined, addOn: false });
  }

  console.warn(
    "⚠️  BROWSERS env var not set. Using legacy defaults. " +
    "Set BROWSERS to configure browsers explicitly."
  );

  return browsers;
}

export async function loadConfig() {
  await applyEnvFileToProcessEnv();
  const navWaitUntilRaw = process.env.NAV_WAIT_UNTIL || "domcontentloaded";
  const navWaitUntil = WAIT_UNTIL_VALUES.has(navWaitUntilRaw)
    ? navWaitUntilRaw
    : "networkidle2";

  const screenshotPathPrefix = process.env.ENABLE_SCREENSHOT_PATH || "";
  const searchKeepMinWorkingWindowsRaw = Number(process.env.SEARCH_KEEP_MIN_WORKING_WINDOWS ?? 2);
  const searchKeepMinWorkingWindows = Number.isFinite(searchKeepMinWorkingWindowsRaw)
    ? Math.max(0, Math.min(20, Math.floor(searchKeepMinWorkingWindowsRaw)))
    : 2;
  const searchMaxWorkingWindowsRaw = parseInteger(process.env.SEARCH_MAX_WORKING_WINDOWS, 10);
  const searchMaxWorkingWindows = Math.max(
    searchKeepMinWorkingWindows,
    Math.max(1, Math.min(30, searchMaxWorkingWindowsRaw))
  );

  const chromePath = await resolveChromePath();
  const lightpandaPath = await findLightpandaPath();
  const cloakbrowserPath = await findCloakbrowserPath();

  const defaultHintsPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "domain-hints.json"
  );
  const hintsPathCustom = process.env.DOMAIN_HINTS_PATH;
  const domainHintsPath = hintsPathCustom
    ? path.resolve(hintsPathCustom)
    : defaultHintsPath;
  const vncEnabled = parseBoolean(process.env.ENABLE_VNC, false);
  let headless = parseBoolean(process.env.HEADLESS, headlessDefault);
  if (!headless && !vncEnabled) {
    console.error("⚠️  HEADLESS=false requires ENABLE_VNC=1; starting headless instead");
    headless = true;
  }

  // Parse BROWSERS array (new format) or synthesize from legacy env vars
  const browsersRaw = parseBrowsers(process.env.BROWSERS);
  const browsers = ensureChromiumPresent(
    browsersRaw || synthesizeBrowsersFromLegacy()
  );

  // Sort by index for consistent ordering
  browsers.sort((a, b) => a.index - b.index);

  // Derive convenience fields from browsers array
  const defaultBackend = browsers.find((b) => b.role.includes("default"))?.name || "chromium";
  const devtoolsBackend = browsers.find((b) => b.role.includes("devtools"))?.name || defaultBackend;

  return {
    chromePath,
    chromeUserDataDir: process.env.CHROME_USER_DATA_DIR || "/data/chrome",
    chromeProfileDir: process.env.CHROME_PROFILE_DIR || "Default",
    lightpandaPath,
    lightpandaPort: parsePort(process.env.LIGHTPANDA_PORT, 1997),
    cloakbrowserPath,
    browsers,
    defaultBackend,
    devtoolsBackend,
    browserOpTimeoutMs: parseNumber(process.env.BROWSER_OP_TIMEOUT_MS, 60000),
    navWaitUntil,
    headless,
    userAgent:
      process.env.BROWSER_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    mcpApiPort: parseNumber(process.env.MCP_API_PORT || process.env.HEALTH_PORT, 1994),
    mcpApiHost: process.env.MCP_API_HOST || "http://localhost",
    enableHttpHealth: parseBoolean(process.env.ENABLE_HTTP_HEALTH, false),
    enableHttpMcp: parseBoolean(process.env.ENABLE_HTTP_MCP, true),
    mcpApiKeys: parseApiKeys(process.env.MCP_API_KEYS),
    mcpAllowUnauthenticated: parseBoolean(process.env.MCP_ALLOW_UNAUTHENTICATED, true),
    enableStdioMcp: parseBoolean(process.env.ENABLE_STDIO_MCP, false),
    enableDevtoolsMcp: parseBoolean(process.env.ENABLE_DEVTOOLS_MCP, true),
    enableScreenshotDownloadLink: parseBoolean(process.env.ENABLE_SCREENSHOT_DOWNLOAD_LINK, false),
    screenshotPathPrefix: screenshotPathPrefix.trim() || null,
    enableWebConsole: parseBoolean(process.env.ENABLE_WEB_CONSOLE, true),
    vncEnabled,
    vncPort: parseNumber(process.env.VNC_PORT, 1995),
    novncPort: parseNumber(process.env.NOVNC_PORT, 1996),
    searchKeepMinWorkingWindows,
    searchMaxWorkingWindows,
    maxChars: DEFAULT_MAX_CHARS,
    searchRouteCircuitOpenMs: parseNumber(process.env.SEARCH_ROUTE_CIRCUIT_OPEN_MS, 300000),
    searchQueueMinIntervalMs: Math.max(1000, parseNumber(process.env.SEARCH_QUEUE_MIN_INTERVAL_MS, 30000)),
    searchQueueMaxIntervalMs: Math.max(1000, parseNumber(process.env.SEARCH_QUEUE_MAX_INTERVAL_MS, 1800000)),
    searchQueueEscalationFactor: Math.max(1, parseNumber(process.env.SEARCH_QUEUE_ESCALATION_FACTOR, 2)),
    searchQueueErrorGapPercentile: Math.min(1, parseNumber(process.env.SEARCH_QUEUE_ERROR_GAP_PERCENTILE, 0.75)),
    searchQueueErrorGapSafety: Math.max(1, parseNumber(process.env.SEARCH_QUEUE_ERROR_GAP_SAFETY, 1.25)),
    searchQueueDecayPerSuccess: Math.min(1, parseNumber(process.env.SEARCH_QUEUE_DECAY_PER_SUCCESS, 0.75)),
    searchQueueProfilePath: process.env.SEARCH_QUEUE_PROFILE_PATH || ".cache/search-engine-profiles.json",
    searchQueueWSuccess: parseNumber(process.env.SEARCH_QUEUE_W_SUCCESS, 0.45),
    searchQueueWResults: parseNumber(process.env.SEARCH_QUEUE_W_RESULTS, 0.15),
    searchQueueWStability: parseNumber(process.env.SEARCH_QUEUE_W_STABILITY, 0.25),
    searchQueueWRecency: parseNumber(process.env.SEARCH_QUEUE_W_RECENCY, 0.1),
    searchQueueWRecovery: parseNumber(process.env.SEARCH_QUEUE_W_RECOVERY, 0.05),
    searchQueueWLatency: parseNumber(process.env.SEARCH_QUEUE_W_LATENCY, 0.2),
    openPageMaxParallel: Math.max(1, Math.min(20, parseInteger(process.env.OPEN_PAGE_MAX_PARALLEL, 6))),
    maxConcurrentPageOps: Math.max(1, Math.min(30, parseInteger(process.env.MAX_CONCURRENT_PAGE_OPS, 30))),
    humanTypingDelay: Math.max(0, Math.min(500, parseInteger(process.env.HUMAN_TYPING_DELAY, 15))),
    prelaunchBrowser: parseBoolean(process.env.PRELAUNCH_BROWSER, true),
    enableHangRestart: parseBoolean(process.env.ENABLE_HANG_RESTART, false),
    hangRestartTimeoutMs: parseNumber(process.env.HANG_RESTART_TIMEOUT_MS, 120000),
    startupUrl: process.env.STARTUP_URL || "about:blank",
    toolCacheTtlMs: parseNumber(process.env.TOOL_CACHE_TTL_MS, 5 * 60 * 1000),
    debug: parseBoolean(process.env.DEBUG, false),
    logToolErrors: parseBoolean(process.env.LOG_TOOL_ERRORS, true),
    enableInstantAnswers: parseBoolean(process.env.ENABLE_INSTANT_ANSWERS, true),
    enableLinkRefs: parseBoolean(process.env.LINK_REFS, true),
    disableTools: parseToolList(process.env.DISABLE_TOOLS),
    domainHintsPath,
    searchRouteWarmupEngines: process.env.SEARCH_ROUTE_WARMUP_ENGINES === undefined
      ? ["brave", "duckduckgo_api", "duckduckgo"]
      : parseEngines(process.env.SEARCH_ROUTE_WARMUP_ENGINES, []),
    searchEnabledEngines: (() => {
      const parsed = parseEngines(
        process.env.SEARCH_ENABLED_ENGINES,
        DEFAULT_SEARCH_ENABLED_ENGINES
      );
      const exaApiKey = String(process.env.EXA_API_KEY || "").trim();
      const linkupApiKey = String(process.env.LINKUP_API_KEY || "").trim();
      const tavilyApiKey = String(process.env.TAVILY_API_KEY || "").trim();
      const firecrawlApiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
      const hasExplicit = process.env.SEARCH_ENABLED_ENGINES !== undefined && String(process.env.SEARCH_ENABLED_ENGINES).trim() !== "";
      let next = [...parsed];
      if (!hasExplicit) {
        if (exaApiKey && !next.includes("exa_api")) next.push("exa_api");
        if (linkupApiKey && !next.includes("linkup_api")) next.push("linkup_api");
        if (tavilyApiKey && !next.includes("tavily_api")) next.push("tavily_api");
        if (firecrawlApiKey && !next.includes("firecrawl_api")) next.push("firecrawl_api");
      }
      if (!exaApiKey) next = next.filter((engine) => engine !== "exa_api");
      if (!linkupApiKey) next = next.filter((engine) => engine !== "linkup_api");
      if (!tavilyApiKey) next = next.filter((engine) => engine !== "tavily_api");
      if (!firecrawlApiKey) next = next.filter((engine) => engine !== "firecrawl_api");
      return next;
    })(),
    exaApiKey: String(process.env.EXA_API_KEY || "").trim(),
    linkupApiKey: String(process.env.LINKUP_API_KEY || "").trim(),
    tavilyApiKey: String(process.env.TAVILY_API_KEY || "").trim(),
    firecrawlApiKey: String(process.env.FIRECRAWL_API_KEY || "").trim(),
    postProcessorModels: resolvePostProcessorModels()
  };
}

function resolvePostProcessorModels() {
  const configured = parsePostProcessorModels(readConfigEnv("POST_PROCESSOR_MODELS", "AI_EXTRACTOR_MODELS", "READER_LM_MODELS"));
  if (configured) return configured;
  const baseUrl = (readConfigEnv("POST_PROCESSOR_BASE_URL", "AI_EXTRACTOR_BASE_URL", "READER_LM_BASE_URL") || "").trim().replace(/\/+$/, "");
  if (!baseUrl) return [];
  const model = (readConfigEnv("POST_PROCESSOR_MODEL", "AI_EXTRACTOR_MODEL", "READER_LM_MODEL") || "reader-lm:0.5b").trim();
  return [{ id: "reader_lm", label: model, model, baseUrl, kind: "chat" }];
}
