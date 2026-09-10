import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseApiKeys, parseBoolean, parseBrowsersEnv, parseEngines, parsePostProcessorModels, parseToolList } from "./config.js";
import { clearDomainHintCache } from "./domain-hints.js";

const WAIT_UNTIL_VALUES = new Set(["load", "domcontentloaded", "networkidle0", "networkidle2"]);
const defaultHintsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "domain-hints.json");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseWithType(type, entry, raw) {
  const values = entry.values;
  switch (type) {
    case "string":
      return { valid: typeof raw === "string", value: String(raw) };
    case "boolean": {
      const value = parseBoolean(raw, undefined);
      return { valid: value !== undefined, value };
    }
    case "number": {
      const parsed = Number(raw);
      const value = Number.isFinite(parsed) ? parsed : undefined;
      return { valid: value !== undefined && value >= (entry.min ?? 1), value };
    }
    case "integer": {
      const parsed = Number(raw);
      const value = Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
      return { valid: value !== undefined && value >= (entry.min ?? 1), value };
    }
    case "engines": {
      const text = String(raw ?? "").trim();
      if (!text) return { valid: true, value: [] };
      const value = parseEngines(text, null);
      return { valid: value !== null, value };
    }
    case "toolList":
      return { valid: true, value: parseToolList(String(raw)) };
    case "apiKeys":
      return { valid: true, value: parseApiKeys(String(raw)) };
    case "enum": {
      const normalized = String(raw).trim().toLowerCase();
      return { valid: Array.isArray(values) && values.includes(normalized), value: normalized };
    }
    case "json": {
      try {
        const value = JSON.parse(String(raw));
        return { valid: true, value: JSON.stringify(value) };
      } catch {
        return { valid: false, value: undefined };
      }
    }
    default:
      return { valid: false, value: undefined };
  }
}

export function validateConfigValue(entry, raw) {
  if (!entry) return { valid: false, error: "unknown variable" };
  if (entry.key === "BROWSERS") {
    try {
      parseBrowsersEnv(String(raw));
      return { valid: true, value: String(raw) };
    } catch (error) {
      return { valid: false, error: error?.message || "invalid BROWSERS value" };
    }
  }
  return parseWithType(entry.type, entry, raw);
}

const HOT_APPLYERS = {
  SEARCH_ROUTE_WARMUP_ENGINES: (config, value) => { config.searchRouteWarmupEngines = value; },
  SEARCH_ENABLED_ENGINES: (config, value) => {
    let engines = value.length ? value : null;
    if (engines) {
      if (!config.exaApiKey) engines = engines.filter((e) => e !== "exa_api");
      if (!config.linkupApiKey) engines = engines.filter((e) => e !== "linkup_api");
      if (!config.tavilyApiKey) engines = engines.filter((e) => e !== "tavily_api");
      if (!config.firecrawlApiKey) engines = engines.filter((e) => e !== "firecrawl_api");
      if (!engines.length) engines = null;
    }
    config.searchEnabledEngines = engines;
  },
  EXA_API_KEY: (config, value) => {
    const key = String(value || "").trim();
    config.exaApiKey = key;
    process.env.EXA_API_KEY = key;
    if (Array.isArray(config.searchEnabledEngines)) {
      const hasExa = config.searchEnabledEngines.includes("exa_api");
      if (key && !hasExa && !process.env.SEARCH_ENABLED_ENGINES) {
        config.searchEnabledEngines = [...config.searchEnabledEngines, "exa_api"];
      } else if (!key && hasExa) {
        const filtered = config.searchEnabledEngines.filter((e) => e !== "exa_api");
        config.searchEnabledEngines = filtered.length ? filtered : null;
      }
    }
  },
  LINKUP_API_KEY: (config, value) => {
    const key = String(value || "").trim();
    config.linkupApiKey = key;
    process.env.LINKUP_API_KEY = key;
    if (Array.isArray(config.searchEnabledEngines)) {
      const hasLinkup = config.searchEnabledEngines.includes("linkup_api");
      if (key && !hasLinkup && !process.env.SEARCH_ENABLED_ENGINES) {
        config.searchEnabledEngines = [...config.searchEnabledEngines, "linkup_api"];
      } else if (!key && hasLinkup) {
        const filtered = config.searchEnabledEngines.filter((e) => e !== "linkup_api");
        config.searchEnabledEngines = filtered.length ? filtered : null;
      }
    }
  },
  TAVILY_API_KEY: (config, value) => {
    const key = String(value || "").trim();
    config.tavilyApiKey = key;
    process.env.TAVILY_API_KEY = key;
    if (Array.isArray(config.searchEnabledEngines)) {
      const hasTavily = config.searchEnabledEngines.includes("tavily_api");
      if (key && !hasTavily && !process.env.SEARCH_ENABLED_ENGINES) {
        config.searchEnabledEngines = [...config.searchEnabledEngines, "tavily_api"];
      } else if (!key && hasTavily) {
        const filtered = config.searchEnabledEngines.filter((e) => e !== "tavily_api");
        config.searchEnabledEngines = filtered.length ? filtered : null;
      }
    }
  },
  FIRECRAWL_API_KEY: (config, value) => {
    const key = String(value || "").trim();
    config.firecrawlApiKey = key;
    process.env.FIRECRAWL_API_KEY = key;
    if (Array.isArray(config.searchEnabledEngines)) {
      const hasFirecrawl = config.searchEnabledEngines.includes("firecrawl_api");
      if (key && !hasFirecrawl && !process.env.SEARCH_ENABLED_ENGINES) {
        config.searchEnabledEngines = [...config.searchEnabledEngines, "firecrawl_api"];
      } else if (!key && hasFirecrawl) {
        const filtered = config.searchEnabledEngines.filter((e) => e !== "firecrawl_api");
        config.searchEnabledEngines = filtered.length ? filtered : null;
      }
    }
  },
  SEARCH_ROUTE_CIRCUIT_OPEN_MS: (config, value) => { config.searchRouteCircuitOpenMs = value; },
  SEARCH_KEEP_MIN_WORKING_WINDOWS: (config, value) => {
    config.searchKeepMinWorkingWindows = clamp(value, 0, 20);
    config.searchMaxWorkingWindows = Math.max(config.searchKeepMinWorkingWindows, config.searchMaxWorkingWindows);
  },
  SEARCH_MAX_WORKING_WINDOWS: (config, value) => {
    config.searchMaxWorkingWindows = Math.max(config.searchKeepMinWorkingWindows, clamp(value, 1, 30));
  },
  SEARCH_QUEUE_MIN_INTERVAL_MS: (config, value) => {
    config.searchQueueMinIntervalMs = Math.max(1000, value);
    config.searchQueueMaxIntervalMs = Math.max(config.searchQueueMinIntervalMs, config.searchQueueMaxIntervalMs);
  },
  SEARCH_QUEUE_MAX_INTERVAL_MS: (config, value) => {
    config.searchQueueMaxIntervalMs = Math.max(config.searchQueueMinIntervalMs, Math.max(1000, value));
  },
  SEARCH_QUEUE_ESCALATION_FACTOR: (config, value) => { config.searchQueueEscalationFactor = Math.max(1, value); },
  SEARCH_QUEUE_W_LATENCY: (config, value) => { config.searchQueueWLatency = Math.max(0, value); },
  OPEN_PAGE_MAX_PARALLEL: (config, value) => { config.openPageMaxParallel = clamp(value, 1, 20); },
  MAX_CONCURRENT_PAGE_OPS: (config, value) => { config.maxConcurrentPageOps = clamp(value, 1, 30); },
  HUMAN_TYPING_DELAY: (config, value) => { config.humanTypingDelay = clamp(value, 0, 500); },
  BROWSER_OP_TIMEOUT_MS: (config, value) => { config.browserOpTimeoutMs = value; },
  NAV_WAIT_UNTIL: (config, value) => {
    if (WAIT_UNTIL_VALUES.has(String(value).toLowerCase())) config.navWaitUntil = String(value).toLowerCase();
  },
  WEB_FETCH_MAX_CHARS: (config, value) => { config.maxChars = value; },
  LINK_REFS: (config, value) => { config.enableLinkRefs = value; },
  DEBUG: (config, value) => { config.debug = value; },
  LOG_TOOL_ERRORS: (config, value) => { config.logToolErrors = value; },
  DISABLE_TOOLS: (config, value) => { config.disableTools = value; },
  ENABLE_HANG_RESTART: (config, value) => { config.enableHangRestart = value; },
  HANG_RESTART_TIMEOUT_MS: (config, value) => { config.hangRestartTimeoutMs = value; },
  ENABLE_VNC: (config, value) => { config.vncEnabled = value; },
  VNC_PORT: (config, value) => { config.vncPort = value; },
  NOVNC_PORT: (config, value) => { config.novncPort = value; },
  MCP_API_KEYS: (config, value) => { config.mcpApiKeys = value; },
  MCP_ALLOW_UNAUTHENTICATED: (config, value) => { config.mcpAllowUnauthenticated = value; },
  POST_PROCESSOR_MODELS: (config, value) => {
    config.postProcessorModels = parsePostProcessorModels(value) || [];
  },
  BROWSERS: (config, value) => {
    config.browsers = parseBrowsersEnv(String(value));
  },
  HEADLESS: (config, value) => { config.headless = value; },
  CHROME_PATH: (config, value) => { config.chromePath = String(value); },
  CHROME_USER_DATA_DIR: (config, value) => { config.chromeUserDataDir = String(value); },
  CHROME_PROFILE_DIR: (config, value) => { config.chromeProfileDir = String(value); },
  PRELAUNCH_BROWSER: (config, value) => { config.prelaunchBrowser = value; },
  STARTUP_URL: (config, value) => { config.startupUrl = String(value); },
  BROWSER_USER_AGENT: (config, value) => { config.userAgent = String(value); },
  SEARCH_QUEUE_ERROR_GAP_PERCENTILE: (config, value) => { config.searchQueueErrorGapPercentile = Math.min(1, value); },
  SEARCH_QUEUE_ERROR_GAP_SAFETY: (config, value) => { config.searchQueueErrorGapSafety = Math.max(1, value); },
  SEARCH_QUEUE_DECAY_PER_SUCCESS: (config, value) => { config.searchQueueDecayPerSuccess = Math.min(1, value); },
  SEARCH_QUEUE_PROFILE_PATH: (config, value) => { config.searchQueueProfilePath = String(value); },
  SEARCH_QUEUE_W_SUCCESS: (config, value) => { config.searchQueueWSuccess = value; },
  SEARCH_QUEUE_W_RESULTS: (config, value) => { config.searchQueueWResults = value; },
  SEARCH_QUEUE_W_STABILITY: (config, value) => { config.searchQueueWStability = value; },
  SEARCH_QUEUE_W_RECENCY: (config, value) => { config.searchQueueWRecency = value; },
  SEARCH_QUEUE_W_RECOVERY: (config, value) => { config.searchQueueWRecovery = value; },
  DOMAIN_HINTS_PATH: (config, value) => {
    const p = String(value || "").trim();
    config.domainHintsPath = p ? path.resolve(p) : defaultHintsPath;
    clearDomainHintCache();
  },
  ENABLE_WEB_CONSOLE: (config, value) => { config.enableWebConsole = value; },
  ENABLE_HTTP_HEALTH: (config, value) => { config.enableHttpHealth = value; },
  ENABLE_HTTP_MCP: (config, value) => { config.enableHttpMcp = value; },
  ENABLE_STDIO_MCP: (config, value) => { config.enableStdioMcp = value; },
  ENABLE_DEVTOOLS_MCP: (config, value) => { config.enableDevtoolsMcp = value; },
  MCP_API_PORT: (config, value) => { config.mcpApiPort = value; },
  MCP_API_HOST: (config, value) => { config.mcpApiHost = String(value); },
  ENABLE_SCREENSHOT_DOWNLOAD_LINK: (config, value) => { config.enableScreenshotDownloadLink = value; },
  ENABLE_SCREENSHOT_PATH: (config, value) => { config.screenshotPathPrefix = String(value || "").trim() || null; }
};

export function hotApplyConfig(config, key, value) {
  const applier = HOT_APPLYERS[key];
  if (!applier) return false;
  applier(config, value);
  return true;
}

export function isHotKey(entry) {
  return Boolean(entry && entry.applies === "hot" && HOT_APPLYERS[entry.key]);
}
