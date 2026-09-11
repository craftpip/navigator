import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_MAX_CHARS } from "./config.js";
import { getBrowserManager, resolveBrowserParam, browserOwnership, builtinBrowserPrompt } from "./browser.js";
import { relayServer } from "./relay-server.js";
import { initCdpSharing, getCdpDiscoveryPayload, authorizeCdpKey, parseAllowedBrowsers, listShareableBrowserNames, cdpBaseUrl } from "./cdp-share.js";
import { CONFIG_SCHEMA } from "./config-schema.js";
import { validateConfigValue, hotApplyConfig } from "./config-manager.js";
import { getEnvFilePath, readEnvFile, writeEnvFile, upsertEnvText, removeEnvKeysText, backupEnvFile, revertEnvFile, recordEnvChange, getEnvChangeHistory, latestBackupPath } from "./env-file.js";
import { vncManager } from "./vnc-manager.js";
import { browserOpenAndExtract, browserSearch, browserCaptureScreenshot, getSearchBackendHealth, getActivityCounters, getEngineAttemptStats, getEngineProfiles, resetSearchEngine } from "./search.js";
import { getActivityTrend, getMcpCallForActivity, getPageOpDetail, getRecentActivity, getSearchDetail, recordActivityEvent, recordMcpCall, recordPageOp, recordPageOpStart } from "./activity.js";
import { mcpCallContext } from "./activity.js";
import { createMcpApiKey, getUsageTotals, incrementUsageTotal, initDb, initializeMcpApiKeys, listMcpApiKeys, renameMcpApiKey, revokeMcpApiKey, setMcpApiKeyTools, setMcpApiKeyBrowsers } from "./db.js";
import { devtoolsToolDefinitions, formatDevtoolsToolResponse, handleDevtoolsToolCall, captureTargetScreenshot, getDevtoolsCounters, createTarget, closeTarget, getPageContent, navigatePage, listTargets, getTargetState, getLastUsedBackend } from "./devtools.js";
import { transform as asciiTransform } from "./ascii.js";
import { SAMPLE_PIXELS_CODE, asciiGridDims } from "./pixel-sampler.js";
import { svgExtractor, capturePageAsSvg } from "./svg.js";
import { rememberLink, getUrlForRefId, getLinkRefByUrl, getRememberedLinkRecord } from "./ref-memory.js";
import { SUPPORTED_ENGINES, getEngineMetadata } from "./engines/index.js";
import { getAuthorizedMcpKey, getMcpApiKey, isAuthorizedMcpRequest } from "./mcp-api-auth.js";
import { findDomainHint, getDomainHints, loadRawDomainHints, saveDomainHints, validateHintRule, WILDCARD_DOMAIN, ensureWildcardHint } from "./domain-hints.js";
import { getPostProcessorModels } from "./post-processor.js";

const require = createRequire(import.meta.url);
const PACKAGE_JSON = require("../package.json");

const webConsoleDir = path.join(process.cwd(), "src", "web-console", "dist");
const webConsoleIndexPath = path.join(webConsoleDir, "index.html");

const docsDistDir = path.join(process.cwd(), "docs-dist");
const docsDistIndexPath = path.join(docsDistDir, "index.html");

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim().slice(0, 100);
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim().slice(0, 100);
  return (req.socket?.remoteAddress || "").slice(0, 100);
}

function getMcpCallKeyInfo(headers) {
  const rawKey = getMcpApiKey(headers);
  if (!rawKey) return { id: null, name: null, preview: null };
  const keys = listMcpApiKeys();
  const match = keys.find((k) => k.secret === rawKey);
  if (match) {
    return { id: match.id, name: match.name, preview: maskApiKey(match.secret) };
  }
  // Fallback: show preview of provided key even if not found (e.g., console key)
  return { id: null, name: null, preview: maskApiKey(rawKey) };
}
const WEB_CONSOLE_CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const CONSOLE_ENGINE_REGISTRY = SUPPORTED_ENGINES.map((id) => {
  const meta = getEngineMetadata(id);
  return {
    id,
    pool: meta.pool,
    homeUrl: meta.homeUrl,
    isBrowser: meta.isBrowser
  };
});
const CONSOLE_ENGINE_BY_ID = new Map(
  CONSOLE_ENGINE_REGISTRY.map((engine) => [engine.id, engine])
);

const screenshotDownloadById = new Map();
const screenshotStorageDir = path.join(process.cwd(), "screenshots");
const CONSOLE_API_KEY = `nvg_console_${randomBytes(32).toString("base64url")}`;
const WEB_TOOL_NAMES = new Set(["web_search", "web_fetch", "web_page_screenshot", "web_page_links", "web_page_ascii", "web_page_svg", "list_browsers"]);
let toolCacheTtlMs = 5 * 60 * 1000; // updated from manager.config after boot
const SCREENSHOT_DOWNLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const MAX_SCREENSHOT_DOWNLOADS = 200;
const MAX_TOOL_CACHE_ENTRIES = 200;
const TOOL_ERROR_LOG_PATH = path.join(process.cwd(), "logs", "tool-errors.log");
const MAX_TOOL_ERROR_LOG_BYTES = 5 * 1024 * 1024;
const SENSITIVE_ARG_KEY_RE = /password|passwd|token|secret|api[_-]?key|authorization|bearer|cookie/i;
const toolResultCache = {
  web_search: new Map(),
  web_fetch: new Map()
};
const cacheCounters = { hits: 0, misses: 0 };
const extractHtmlCache = new Map();

const REQUEST_LOG_MAX = 20000;
const REQUEST_PERIODS = [
  { key: "5m", ms: 5 * 60 * 1000 },
  { key: "15m", ms: 15 * 60 * 1000 },
  { key: "1h", ms: 60 * 60 * 1000 },
  { key: "24h", ms: 24 * 60 * 60 * 1000 },
  { key: "all", ms: Infinity }
];
const requestLog = [];
const requestCounters = { total: 0, ok: 0, err: 0 };

function recordRequest(tool, ok, errorMsg) {
  requestCounters.total += 1;
  if (ok) requestCounters.ok += 1;
  else requestCounters.err += 1;
  requestLog.push({ t: Date.now(), tool, ok, err: ok ? "" : String(errorMsg || "error").slice(0, 300) });
  if (requestLog.length > REQUEST_LOG_MAX) {
    requestLog.splice(0, requestLog.length - REQUEST_LOG_MAX);
  }
}

function activityCategoryForTool(name) {
  return ["Target.", "Page.", "Runtime.", "DOM.", "Input.", "Network."].some((prefix) => String(name).startsWith(prefix))
    ? "devtools"
    : "web";
}

function recordActivityRequest(tool, ok, errorMsg) {
  incrementUsageTotal("toolCalls");
  recordRequest(tool, ok, errorMsg);
  recordActivityEvent({ tool, category: activityCategoryForTool(tool), ok, error: errorMsg });
}

function getRequestStats() {
  const now = Date.now();
  const byPeriod = {};
  const byTool = {};

  for (const e of requestLog) {
    const tool = (byTool[e.tool] ||= { total: 0, ok: 0, err: 0 });
    tool.total += 1;
    if (e.ok) tool.ok += 1;
    else tool.err += 1;

    const age = now - e.t;
    for (const p of REQUEST_PERIODS) {
      if (age <= p.ms) {
        const window = (byPeriod[p.key] ||= { total: 0, ok: 0, err: 0 });
        window.total += 1;
        if (e.ok) window.ok += 1;
        else window.err += 1;
      }
    }
  }

  const recentErrors = [];
  for (let i = requestLog.length - 1; i >= 0 && recentErrors.length < 8; i -= 1) {
    const e = requestLog[i];
    if (!e.ok) {
      recentErrors.push({
        minutesAgo: Math.round((now - e.t) / 60000),
        tool: e.tool,
        error: e.err
      });
    }
  }

  return { ...requestCounters, byPeriod, byTool, recentErrors };
}

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function getCacheKey(args) {
  return stableStringify(args || {});
}

function getCacheArgs(args) {
  if (!args || typeof args !== "object") return args;
  const { bypassCache, ...cacheArgs } = args;
  return cacheArgs;
}

function excludeMaxChars(args) {
  if (!args || typeof args !== "object") return args;
  const { maxChars, ...rest } = args;
  return rest;
}

function getCachedToolResult(toolName, args) {
  const bucket = toolResultCache[toolName];
  if (!bucket) return null;
  pruneToolCacheBucket(bucket);
  const key = getCacheKey(args);
  const entry = bucket.get(key);
  if (!entry) {
    cacheCounters.misses += 1;
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    bucket.delete(key);
    cacheCounters.misses += 1;
    return null;
  }
  cacheCounters.hits += 1;
  return entry.value;
}

function setCachedToolResult(toolName, args, value) {
  const bucket = toolResultCache[toolName];
  if (!bucket) return;
  pruneToolCacheBucket(bucket);
  const key = getCacheKey(args);
  bucket.set(key, {
    value,
    expiresAt: Date.now() + toolCacheTtlMs
  });
  while (bucket.size > MAX_TOOL_CACHE_ENTRIES) {
    const oldestKey = bucket.keys().next().value;
    if (!oldestKey) break;
    bucket.delete(oldestKey);
  }
}

function pruneToolCacheBucket(bucket) {
  const now = Date.now();
  for (const [key, entry] of bucket.entries()) {
    if (!entry || entry.expiresAt <= now) {
      bucket.delete(key);
    }
  }
}

function asMarkdownContent(text) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

function truncateForDisplay(value, maxChars = 400) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function assertString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid input: ${field} must be a non-empty string`);
  }
}

function parseEngineList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

function normalizeSearchEngineSelection(engines, engine) {
  const fromList = parseEngineList(engines);
  const fromSingle = typeof engine === "string" ? String(engine).trim().toLowerCase() : "";
  const requested = [...fromList, ...(fromSingle ? [fromSingle] : [])].filter(Boolean);
  if (!requested.length) return [];
  if (requested.includes("select_best")) return [];
  return fromList.length ? fromList : [fromSingle];
}

function parseQueryList(value) {
  if (typeof value === "string") return [String(value).trim()].filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function parseSearchLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(20, Math.floor(parsed));
}

function parseMaxChars(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(200000, Math.floor(parsed));
}

function parseBooleanParam(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid input: ${field} must be a positive number`);
  }
  return Math.floor(parsed);
}

function parseScreenshotViewport(value, fullPage) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid input: viewport must be an object with width and height");
  }
  const hasWidth = Object.prototype.hasOwnProperty.call(value, "width");
  const hasHeight = Object.prototype.hasOwnProperty.call(value, "height");
  if (!hasWidth) {
    throw new Error("Invalid input: viewport.width is required");
  }
  const width = Math.floor(Number(value.width));
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error("Invalid input: viewport.width must be a positive number");
  }
  let height = null;
  if (hasHeight) {
    height = Math.floor(Number(value.height));
    if (!Number.isFinite(height) || height <= 0) {
      throw new Error("Invalid input: viewport.height must be a positive number");
    }
  } else if (fullPage === false) {
    throw new Error("Invalid input: viewport.height is required when fullPage is false");
  } else {
    // fullPage true → height is ignored, default to 1080 for viewport setup
    height = 1080;
  }
  return { width, height };
}

function sendJson(res, status, payload, extraHeaders) {
  const headers = { "content-type": "application/json", ...extraHeaders };
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

async function serveWebConsoleAsset(res, pathname) {
  const relativePath = pathname.startsWith("/console/assets/")
    ? pathname.slice("/console/".length)
    : "index.html";
  const assetPath = path.resolve(webConsoleDir, relativePath);
  if (!assetPath.startsWith(`${webConsoleDir}${path.sep}`) && assetPath !== webConsoleIndexPath) {
    sendJson(res, 403, { ok: false, error: "Invalid console asset path" });
    return;
  }

  try {
    const content = await fs.readFile(assetPath);
    const extension = path.extname(assetPath);
    res.writeHead(200, {
      "cache-control": assetPath === webConsoleIndexPath ? "no-store" : "public, max-age=31536000, immutable",
      "content-type": WEB_CONSOLE_CONTENT_TYPES[extension] || "application/octet-stream"
    });
    res.end(content);
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendJson(res, 404, { ok: false, error: "Web console not available. Run npm run console:build." });
      return;
    }
    throw error;
  }
}

async function serveDocsAsset(res, pathname) {
  const docsPrefix = "/docs/";
  const relativePath = pathname.startsWith(docsPrefix)
    ? pathname.slice(docsPrefix.length)
    : "";
  const assetPath = path.resolve(docsDistDir, relativePath || "index.html");
  if (!assetPath.startsWith(`${docsDistDir}${path.sep}`) && assetPath !== docsDistIndexPath) {
    sendJson(res, 403, { ok: false, error: "Invalid docs asset path" });
    return;
  }

  try {
    const content = await fs.readFile(assetPath);
    const extension = path.extname(assetPath);
    res.writeHead(200, {
      "cache-control": "no-store",
      "content-type": WEB_CONSOLE_CONTENT_TYPES[extension] || "application/octet-stream"
    });
    res.end(content);
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendJson(res, 404, { ok: false, error: "Docs not available. Run docs build inside the container." });
      return;
    }
    throw error;
  }
}

function setCorsHeaders(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, accept, authorization, x-api-key, mcp-session-id");
  res.setHeader("access-control-expose-headers", "mcp-session-id");
}

function sendMarkdown(res, status, payload) {
  res.writeHead(status, { "content-type": "text/markdown; charset=utf-8" });
  res.end(payload);
}

function getConfigEnvSubset() {
  const out = {};
  for (const entry of CONFIG_SCHEMA) {
    const value = process.env[entry.key];
    if (value !== undefined) out[entry.key] = value;
  }
  return out;
}

function probePort(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

const vncRunningCache = { at: 0, running: false };
async function isVncRunning(novncPort = 1996) {
  const now = Date.now();
  if (now - vncRunningCache.at < 5000) return vncRunningCache.running;
  vncRunningCache.at = now;
  vncRunningCache.running = await probePort(novncPort);
  return vncRunningCache.running;
}

const ENV_KEY_TO_CONFIG_KEY = {
  BROWSERS: "browsers"
};

function envKeyToConfigKey(key) {
  if (ENV_KEY_TO_CONFIG_KEY[key]) return ENV_KEY_TO_CONFIG_KEY[key];
  return key.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

const envFileState = { mtimeMs: null, size: null, changed: false };
async function checkEnvFileChanged(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (envFileState.mtimeMs !== null && (stat.mtimeMs !== envFileState.mtimeMs || stat.size !== envFileState.size)) {
      envFileState.changed = true;
    }
    envFileState.mtimeMs = stat.mtimeMs;
    envFileState.size = stat.size;
  } catch {
    // env file missing — not an error
  }
  return envFileState.changed;
}

async function getConsoleConfigPayload(manager) {
  const envPath = getEnvFilePath();
  const backupPath = await latestBackupPath(envPath);
  const enabledEngines = manager.config.searchEnabledEngines || SUPPORTED_ENGINES;
  return {
    config: manager.config,
    env: getConfigEnvSubset(),
    configValues: Object.fromEntries(
      CONFIG_SCHEMA.map((entry) => [
        entry.key,
        entry.key === "POST_PROCESSOR_MODELS"
          ? (process.env.POST_PROCESSOR_MODELS ?? JSON.stringify(manager.config.postProcessorModels ?? []))
          : entry.key === "DOMAIN_HINTS_PATH"
            ? (process.env.DOMAIN_HINTS_PATH ?? entry.fallback)
            : manager.config[envKeyToConfigKey(entry.key)]
      ])
    ),
    envFile: { path: envPath, changedOnDisk: envFileState.changed, backup: backupPath },
    postProcessorModels: getPostProcessorModels(manager.config),
    engines: enabledEngines.map((id) => CONSOLE_ENGINE_BY_ID.get(id)).filter(Boolean),
    availableEngines: CONSOLE_ENGINE_REGISTRY,
    tools: [...new Set([...WEB_TOOL_NAMES, ...devtoolsToolDefinitions.map((tool) => tool.name)])].sort(),
    package: { name: PACKAGE_JSON.name, version: PACKAGE_JSON.version },
    schema: CONFIG_SCHEMA,
    envPath,
    changeHistory: getEnvChangeHistory()
  };
}

function maskApiKey(key) {
  if (key.length <= 24) return "********";
  return `${key.slice(0, 12)}...${key.slice(-12)}`;
}

function parseAllowedTools(value) {
  if (!value) return null;
  try {
    const tools = JSON.parse(value);
    return Array.isArray(tools) ? tools.filter((tool) => typeof tool === "string") : [];
  } catch {
    return [];
  }
}

function getToolGroups() {
  const available = getToolsListResponse().tools.map((tool) => tool.name);
  return [
    { id: "web", label: "Web", tools: available.filter((name) => WEB_TOOL_NAMES.has(name)) },
    { id: "dev", label: "Dev", tools: available.filter((name) => !WEB_TOOL_NAMES.has(name)) }
  ].filter((group) => group.tools.length);
}

function getAllowedToolsForRequest(headers, config) {
  const key = getMcpApiKey(headers);
  if (!key || key === CONSOLE_API_KEY) return null;
  const authorizedKey = getAuthorizedMcpKey(headers, config);
  if (!authorizedKey) return null;
  const record = listMcpApiKeys().find((entry) => entry.secret === authorizedKey);
  const allowedTools = record ? parseAllowedTools(record.allowed_tools) : null;
  return allowedTools === null ? null : new Set(allowedTools);
}

async function getConsoleApiKeysPayload(manager) {
  const health = await manager.getHealth().catch(() => null);
  return {
    ok: true,
    allowUnauthenticated: manager.config.mcpAllowUnauthenticated,
    toolGroups: getToolGroups(),
    browsers: (health?.browsers || []).map((b) => ({
      name: b.name,
      type: b.type,
      role: b.role,
      status: b.status,
      connected: Boolean(b.connected)
    })),
    cdpHost: (() => {
      try { return new URL(manager.config.mcpApiHost || "http://localhost").hostname || "127.0.0.1"; }
      catch { return "127.0.0.1"; }
    })(),
    cdpPort: manager.config.mcpApiPort,
    cdpBase: cdpBaseUrl(manager.config),
    keys: listMcpApiKeys().map((key) => ({
      id: key.id,
      name: key.name,
      preview: maskApiKey(key.secret),
      createdAt: key.created_at,
      allowedTools: parseAllowedTools(key.allowed_tools),
      allowedBrowsers: parseAllowedBrowsers(key.allowed_browsers)
    }))
  };
}

function syncMcpApiKeys(manager) {
  const keys = initializeMcpApiKeys(Array.isArray(manager.config.mcpApiKeys) ? manager.config.mcpApiKeys : []);
  manager.config.mcpApiKeys = keys.map((key) => key.secret);
}

async function persistMcpApiAuth(manager, { allowUnauthenticated = manager.config.mcpAllowUnauthenticated }) {
  const envPath = getEnvFilePath();
  const envText = await readEnvFile(envPath);
  const updated = upsertEnvText(envText, {
    MCP_ALLOW_UNAUTHENTICATED: allowUnauthenticated ? "1" : "0"
  });
  const backup = await backupEnvFile(envPath);
  await writeEnvFile(envPath, updated.text);
  manager.config.mcpAllowUnauthenticated = Boolean(allowUnauthenticated);
  await checkEnvFileChanged(envPath);
  envFileState.changed = false;
  recordEnvChange({ action: "update_mcp_api_auth", keys: ["MCP_ALLOW_UNAUTHENTICATED"] });
  return { backup };
}

const CONSOLE_TOOLS_KEY_NAME = "Web Tools UI";

function ensureConsoleToolsApiKey() {
  const existing = listMcpApiKeys().find((key) => key.name === CONSOLE_TOOLS_KEY_NAME);
  if (existing) return existing;
  return createMcpApiKey({
    name: CONSOLE_TOOLS_KEY_NAME,
    secret: `nvg_${randomBytes(32).toString("base64url")}`
  });
}

async function handleConsoleApiKeys(manager, body) {
  const action = body?.action;
  if (action === "create") {
    const name = String(body?.name || "").trim();
    if (!name || name.length > 80) {
      return { ok: false, error: "Key name must be between 1 and 80 characters" };
    }
    const key = `nvg_${randomBytes(32).toString("base64url")}`;
    const availableTools = new Set(getToolGroups().flatMap((group) => group.tools));
    const allowedTools = Array.isArray(body?.allowedTools)
      ? [...new Set(body.allowedTools.filter((tool) => availableTools.has(tool)))]
      : [...availableTools];
    const availableBrowsers = new Set(listShareableBrowserNames(manager));
    const allowedBrowsers = Array.isArray(body?.allowedBrowsers)
      ? [...new Set(body.allowedBrowsers.filter((name) => availableBrowsers.has(name)))]
      : [...availableBrowsers];
    createMcpApiKey({ name, secret: key, allowedTools, allowedBrowsers });
    syncMcpApiKeys(manager);
    return { ok: true, key, ...await getConsoleApiKeysPayload(manager) };
  }

  if (action === "revoke") {
    const id = Number(body?.id);
    if (!Number.isInteger(id) || !revokeMcpApiKey(id)) {
      return { ok: false, error: "Unknown API key" };
    }
    syncMcpApiKeys(manager);
    return getConsoleApiKeysPayload(manager);
  }

  if (action === "rename") {
    const id = Number(body?.id);
    const name = String(body?.name || "").trim();
    if (!name || name.length > 80) {
      return { ok: false, error: "Key name must be between 1 and 80 characters" };
    }
    if (!Number.isInteger(id) || !renameMcpApiKey(id, name)) {
      return { ok: false, error: "Unknown API key" };
    }
    syncMcpApiKeys(manager);
    return getConsoleApiKeysPayload(manager);
  }

  if (action === "set_tools") {
    const id = Number(body?.id);
    const availableTools = new Set(getToolGroups().flatMap((group) => group.tools));
    const allowedTools = Array.isArray(body?.allowedTools)
      ? [...new Set(body.allowedTools.filter((tool) => availableTools.has(tool)))]
      : [];
    if (!Number.isInteger(id) || !setMcpApiKeyTools(id, allowedTools)) {
      return { ok: false, error: "Unknown API key" };
    }
    return getConsoleApiKeysPayload(manager);
  }

  if (action === "set_browsers") {
    const id = Number(body?.id);
    const availableBrowsers = new Set(listShareableBrowserNames(manager));
    const allowedBrowsers = Array.isArray(body?.allowedBrowsers)
      ? [...new Set(body.allowedBrowsers.filter((name) => availableBrowsers.has(name)))]
      : [];
    if (!Number.isInteger(id) || !setMcpApiKeyBrowsers(id, allowedBrowsers)) {
      return { ok: false, error: "Unknown API key" };
    }
    return getConsoleApiKeysPayload(manager);
  }

  if (action === "set_allow_unauthenticated") {
    if (typeof body?.allowUnauthenticated !== "boolean") {
      return { ok: false, error: "allowUnauthenticated must be a boolean" };
    }
    await persistMcpApiAuth(manager, { allowUnauthenticated: body.allowUnauthenticated });
    return getConsoleApiKeysPayload(manager);
  }

  return { ok: false, error: "Unknown API key action" };
}

function sendMcpUnauthorized(res) {
  res.setHeader("www-authenticate", 'Bearer realm="navigator-mcp"');
  sendJson(res, 401, {
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: provide a valid Bearer token or X-API-Key." },
    id: null
  });
}

async function applyConfigUpdates(manager, body) {
  const updates = body?.updates && typeof body.updates === "object" ? body.updates : null;
  const resets = Array.isArray(body?.reset) ? body.reset.map((key) => String(key).toUpperCase()) : [];
  const revert = body?.revert === true;
  const envPath = getEnvFilePath();
  const payload = { ok: true, hotApplied: [], restartRequired: [], invalid: [], unchanged: [], envWritten: false, backup: null, reverted: false };

  if (revert) {
    const backupPath = await revertEnvFile(envPath);
    if (!backupPath) {
      payload.ok = false;
      payload.error = "No backup available to revert to";
      return payload;
    }
    payload.reverted = true;
    payload.backup = backupPath;
    recordEnvChange({ action: "revert", backup: backupPath });
    await checkEnvFileChanged(envPath);
    envFileState.changed = false;
    return payload;
  }

  const changedKeys = new Set();
  let envText = await readEnvFile(envPath);

  const validated = [];
  if (updates) {
    for (const [rawKey, rawValue] of Object.entries(updates)) {
      const key = String(rawKey).toUpperCase();
      const entry = CONFIG_SCHEMA.find((item) => item.key === key);
      if (!entry) {
        payload.invalid.push({ key, error: "unknown variable" });
        continue;
      }
      const parsed = validateConfigValue(entry, rawValue);
      if (!parsed.valid) {
        const detail = parsed.error ? ` — ${parsed.error}` : "";
        payload.invalid.push({ key, error: `invalid value for ${entry.type}${detail}` });
        continue;
      }
      validated.push({ key, entry, parsed });
    }
  }

  if (payload.invalid.length) {
    return { ok: false, error: `${payload.invalid.length} invalid value(s)`, invalid: payload.invalid };
  }

  for (const { key, entry, parsed } of validated) {
    if (entry.applies === "hot") {
      const applied = hotApplyConfig(manager.config, key, parsed.value);
      if (applied) {
        payload.hotApplied.push(key);
        changedKeys.add(key);
      } else {
        payload.restartRequired.push(key);
      }
    } else {
      payload.restartRequired.push(key);
      changedKeys.add(key);
    }
  }

  if (resets.length) {
    const { text: afterReset, removed } = removeEnvKeysText(envText, resets);
    if (removed.length) {
      envText = afterReset;
      for (const key of removed) {
        changedKeys.add(key);
        const entry = CONFIG_SCHEMA.find((item) => item.key === key);
        if (entry && entry.applies === "hot") {
          hotApplyConfig(manager.config, key, entry.fallback);
          payload.hotApplied.push(`${key}→default`);
          delete process.env[key];
        } else {
          payload.restartRequired.push(`${key}→default`);
        }
      }
    }
  }

  if (changedKeys.size) {
    if (updates) {
      const updated = upsertEnvText(envText, Object.fromEntries(
        Object.entries(updates).map(([rawKey, rawValue]) => [String(rawKey).toUpperCase(), String(rawValue)])
      ));
      envText = updated.text;
      payload.unchanged = updated.unchanged;
    }
    const backup = await backupEnvFile(envPath);
    if (backup) payload.backup = backup;
    await writeEnvFile(envPath, envText);
    if (updates) {
      for (const [rawKey, rawValue] of Object.entries(updates)) {
        const key = String(rawKey).toUpperCase();
        if (changedKeys.has(key)) {
          process.env[key] = String(rawValue);
        }
      }
    }
    payload.envWritten = true;
    await checkEnvFileChanged(envPath);
    envFileState.changed = false;
    recordEnvChange({
      action: "update",
      keys: [...changedKeys],
      hotApplied: payload.hotApplied.slice(),
      restartRequired: payload.restartRequired.slice()
    });
  }

  return payload;
}

async function handleConsoleVnc(manager, body) {
  const action = body?.action;
  if (action !== "enable" && action !== "disable") {
    return { ok: false, error: "action must be 'enable' or 'disable'" };
  }
  const envPath = getEnvFilePath();

  if (action === "enable") {
    process.env.DISPLAY = vncManager.display;
    const start = await vncManager.start();
    if (!start.ok) {
      return { ok: false, error: start.error, steps: vncManager.steps };
    }
    const relaunch = await manager.relaunchDefaultBackend(false);
    manager.config.vncEnabled = true;
    let envText = await readEnvFile(envPath);
    envText = upsertEnvText(envText, { ENABLE_VNC: "1", HEADLESS: "false" }).text;
    const backup = await backupEnvFile(envPath);
    await writeEnvFile(envPath, envText);
    vncRunningCache.at = 0;
    await checkEnvFileChanged(envPath);
    envFileState.changed = false;
    return { ok: true, action, steps: vncManager.steps, relaunch, running: true, headed: !manager.config.headless, backup };
  }

  if (action === "disable") {
    await vncManager.stop();
    delete process.env.DISPLAY;
    const relaunch = await manager.relaunchDefaultBackend(true);
    manager.config.vncEnabled = false;
    let envText = await readEnvFile(envPath);
    envText = upsertEnvText(envText, { ENABLE_VNC: "0", HEADLESS: "true" }).text;
    const backup = await backupEnvFile(envPath);
    await writeEnvFile(envPath, envText);
    vncRunningCache.at = 0;
    await checkEnvFileChanged(envPath);
    envFileState.changed = false;
    return { ok: true, action, steps: vncManager.steps, relaunch, running: false, headed: !manager.config.headless, backup };
  }

  return { ok: false, error: "unreachable" };
}

async function handleConsoleLogs(manager, url) {
  const rawN = parseInt(url.searchParams.get("n") || "50", 10);
  const n = Math.max(1, Math.min(200, Number.isFinite(rawN) && rawN > 0 ? rawN : 50));
  const logPath = TOOL_ERROR_LOG_PATH;
  let lines = [];
  try {
    const text = await fs.readFile(logPath, "utf8");
    lines = text.trim().split("\n").filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { ts: "", level: "tool_error", tool: "?", error: line };
      }
    });
  } catch {
    // no log file yet
  }
  return { ok: true, n, entries: lines.slice(-n).reverse() };
}

let hintWriteQueue = Promise.resolve();
function queueHintMutation(task) {
  const run = hintWriteQueue.then(task, task);
  hintWriteQueue = run.catch(() => {});
  return run;
}

function hintDuplicateKey(hint) {
  const domain = String(hint?.domain || "").toLowerCase();
  const pathPattern = hint?.pathPattern || "/**";
  const requireSelector = String(hint?.requireSelector || "").trim();
  return `${domain}|${pathPattern}|${requireSelector}`;
}

function findHintDuplicate(hints, hint, excludeIndex) {
  const key = hintDuplicateKey(hint);
  for (let index = 0; index < hints.length; index += 1) {
    if (index === excludeIndex) continue;
    const entry = hints[index];
    if (!entry || typeof entry !== "object") continue;
    if (hintDuplicateKey(entry) === key) {
      const entryHint = entry;
      const require = entryHint.requireSelector ? ` require:${entryHint.requireSelector}` : "";
      return { index, key, label: `${entryHint.domain || "?"} ${entryHint.pathPattern || "/**"}${require}` };
    }
  }
  return null;
}

async function createHint(hintsPath, rawHint, aiModelIds, browserNames = null) {
  if (!rawHint || typeof rawHint !== "object" || Array.isArray(rawHint)) {
    return { ok: false, error: "hint must be an object" };
  }
  const hint = { ...rawHint };
  if (hint.domain === WILDCARD_DOMAIN) {
    return { ok: false, error: "wildcard hints cannot be created manually — they are auto-managed" };
  }
  if (hint.pathPattern === undefined || hint.pathPattern === null || hint.pathPattern === "") {
    hint.pathPattern = "/**";
  }
  const validation = validateHintRule(hint, { scope: "static", aiModelIds, browserNames });
  if (validation.errors.length) {
    return { ok: false, error: "invalid hint", validation };
  }
  return queueHintMutation(async () => {
    const hints = await loadRawDomainHints(hintsPath);
    const duplicate = findHintDuplicate(hints, hint, -1);
    if (duplicate) {
      return { ok: false, error: `duplicate hint: ${hint.domain} ${hint.pathPattern}${hint.requireSelector ? ` require:${hint.requireSelector}` : ""} collides with #${duplicate.index} (${duplicate.label})`, validation: { errors: [{ field: "pathPattern", message: `collides with hint #${duplicate.index} (${duplicate.label})` }], warnings: [] } };
    }
    hints.push(hint);
    const save = await saveDomainHints(hints, hintsPath);
    if (!save.ok) return save;
    return { ok: true, index: hints.length - 1, hint, hintsPath: save.hintsPath };
  });
}

async function updateHint(hintsPath, index, rawHint, aiModelIds, browserNames = null) {
  if (!Number.isInteger(index) || index < 0) {
    return { ok: false, error: "invalid index" };
  }
  if (!rawHint || typeof rawHint !== "object" || Array.isArray(rawHint)) {
    return { ok: false, error: "hint must be an object" };
  }
  const hint = { ...rawHint };
  if (hint.pathPattern === undefined || hint.pathPattern === null || hint.pathPattern === "") {
    hint.pathPattern = "/**";
  }
  const validation = validateHintRule(hint, { scope: "static", aiModelIds, browserNames });
  if (validation.errors.length) {
    return { ok: false, error: "invalid hint", validation };
  }
  return queueHintMutation(async () => {
    const hints = await loadRawDomainHints(hintsPath);
    if (index >= hints.length) {
      return { ok: false, error: `index ${index} out of range (${hints.length} hints)` };
    }
    const duplicate = findHintDuplicate(hints, hint, index);
    if (duplicate) {
      return { ok: false, error: `duplicate hint: ${hint.domain} ${hint.pathPattern}${hint.requireSelector ? ` require:${hint.requireSelector}` : ""} collides with #${duplicate.index} (${duplicate.label})`, validation: { errors: [{ field: "pathPattern", message: `collides with hint #${duplicate.index} (${duplicate.label})` }], warnings: [] } };
    }
    hints[index] = hint;
    const save = await saveDomainHints(hints, hintsPath);
    if (!save.ok) return save;
    return { ok: true, index, hint, hintsPath: save.hintsPath };
  });
}

async function deleteHint(hintsPath, index) {
  if (!Number.isInteger(index) || index < 0) {
    return { ok: false, error: "invalid index" };
  }
  return queueHintMutation(async () => {
    const hints = await loadRawDomainHints(hintsPath);
    if (index >= hints.length) {
      return { ok: false, error: `index ${index} out of range (${hints.length} hints)` };
    }
    if (hints[index]?.domain === WILDCARD_DOMAIN) {
      return { ok: false, error: "cannot delete the wildcard default hint" };
    }
    const [removed] = hints.splice(index, 1);
    const save = await saveDomainHints(hints, hintsPath);
    if (!save.ok) return save;
    return { ok: true, index, removed, count: save.count, hintsPath: save.hintsPath };
  });
}

const LOG_MAP = {
  booting:               ["🚀", "Server starting"],
  "boot.config":         ["⚙️",  (p) => `Search route warmup engines: ${p?.searchRouteWarmupEngines?.join(", ") || "?"}`],
  "boot.ready":          ["🚀",  (p) => p?.transport === "stdio" ? "Ready (stdio)" : `Ready  ${(p?.host || "?").replace(/^https?:\/\//, "")}:${p?.port || "?"}`],
  "prelaunch.ready":     ["✅",  "Browser warmed"],
  "prelaunch.error":     ["❌",  "Browser warmup failed"],
  "boot.start":          ["", ""],
  shutdown:              ["🛑",  "Shutting down"],
  "shutdown.error":      ["❌",  "Shutdown error"],
  "process.uncaught_exception":  ["💥", "Uncaught exception"],
  "process.unhandled_rejection": ["⚠️", "Unhandled rejection"]
};

function logEvent(label, payload) {
  const entry = LOG_MAP[label];
  if (!entry) return;
  const [emoji, msg] = entry;
  const text = typeof msg === "function" ? msg(payload) : msg;
  if (!text && !emoji) return;
  if (!text) { console.error(`${emoji}  ${label}`); return; }
  console.error(`${emoji}  ${text}`);
}

function truncateStr(s, max = 80) {
  if (!s || s.length <= max) return s || "";
  return s.slice(0, max) + "...";
}

export function redactArgs(args = {}) {
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_ARG_KEY_RE.test(key)) {
      out[key] = "[REDACTED]";
    } else if (key === "text" && typeof value === "string") {
      out[key] = `<${value.length} chars>`;
    } else {
      out[key] = typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}...` : value;
    }
  }
  return out;
}

async function appendToolErrorLog(filePath, line, maxBytes) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let stats = null;
    try {
      stats = await fs.stat(filePath);
    } catch (_) {}
    if (stats && stats.size >= maxBytes) {
      const backup = `${filePath}.1`;
      await fs.rm(backup, { force: true });
      await fs.rename(filePath, backup);
    }
    await fs.appendFile(filePath, line, "utf8");
  } catch (error) {
    console.error(`📝  tool error log write failed: ${String(error?.message || error)}`);
  }
}

export async function logToolError({ tool, args, error, ms, transport, sessionId, logToolErrors, logPath, maxBytes }) {
  if (logToolErrors === undefined) logToolErrors = manager?.config?.logToolErrors;
  if (!logToolErrors) return;
  const entry = {
    ts: new Date().toISOString(),
    level: "tool_error",
    tool,
    transport,
    ...(sessionId ? { sessionId } : {}),
    ...(Number.isFinite(ms) ? { ms } : {}),
    args: redactArgs(args),
    error: String(error?.message || error),
    ...(error?.stack ? { stack: truncateStr(String(error.stack), 2000) } : {})
  };
  await appendToolErrorLog(logPath || TOOL_ERROR_LOG_PATH, JSON.stringify(entry) + "\n", maxBytes || MAX_TOOL_ERROR_LOG_BYTES);
}

function getDomain(u) {
  try { return new URL(u).hostname; } catch { return ""; }
}

function mcpRequestSummary(body) {
  if (!body) return "?";
  const m = body?.method || "";
  if (m !== "tools/call") return m;
  const name = body?.params?.name || "?";
  const args = body?.params?.arguments || {};
  const isPage = name === "web_fetch" || name === "web_page_screenshot";
  const parts = [name];
  if (args.query) parts.push(`"${truncateStr(args.query, 60)}"`);
  if (args.queries) parts.push(truncateStr(args.queries.join(" | "), 60));
  if (args.url) {
    const domain = getDomain(args.url);
    parts.push(isPage && domain ? domain : truncateStr(args.url, 60));
  }
  if (args.urls) {
    const domain = getDomain(args.urls[0]);
    parts.push(`${args.urls.length} urls${domain ? ` · ${domain}` : ""}`);
  }
  if (args.ref_id !== void 0) parts.push(`ref #${args.ref_id}`);
  if (args.ref_ids) parts.push(`${args.ref_ids.length} refs`);
  const pageBrowser = typeof args.browser === "string" && args.browser.trim()
    ? String(args.browser).trim()
    : "chromium";
  const engine = typeof args.engine === "string" ? String(args.engine).trim().toLowerCase() : "";
  const eng = isPage ? pageBrowser : engine && engine !== "select_best" ? engine : "";
  if (eng) parts.push(`[${eng}]`);
  if (args.limit && args.limit !== 5) parts.push(`limit=${args.limit}`);
  if (args.maxChars && args.maxChars !== DEFAULT_MAX_CHARS) parts.push(`maxc=${args.maxChars}`);
  if (args.bypassCache === true) parts.push("no-cache");
  if (args.format) parts.push(args.format);
  if (args.fullPage === false) parts.push("no-fullpage");
  return parts.join("  ");
}

function firstResultTitle(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("- **")) {
      const match = lines[i].match(/\*\*(.+?)\*\*/);
      if (match) return truncateStr(match[1], 60);
    }
  }
  return "";
}

function extractDomains(text) {
  const domains = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.match(/URL:\s*(https?:\/\/([^/\s]+))/);
    if (m && !domains.includes(m[2])) domains.push(m[2]);
  }
  if (!domains.length) {
    const m = text.match(/\[([^\]\s/]+)\]\(\d+\)/);
    if (m && m[1] && !domains.includes(m[1])) domains.push(m[1]);
  }
  return domains.join(", ");
}

function mcpResponseSummary(resp) {
  if (!resp) return "";
  if (resp.error) return `error: ${truncateStr(resp.error.message || "", 80)}`;
  const result = resp.result;
  if (!result) return "";
  if (result.isError) return "error";
  const text = result?.content?.[0]?.text || "";
  if (!text) return "ok";
  const refs = text.match(/^\s*- \*\*.+?\*\* \[[^\]]+\]\(\d+\)/gm);
  if (refs) {
    const hint = firstResultTitle(text);
    const domains = extractDomains(text);
    const domainsPart = domains ? ` · ${domains}` : "";
    return `${refs.length} results${hint ? ` · “${hint}”` : ""}${domainsPart}`;
  }
  const okCount = (text.match(/Status: Success/g) || []).length;
  const failCount = (text.match(/Status: Failed/g) || []).length;
  if (okCount || failCount) {
    const domains = extractDomains(text);
    const domainsPart = domains ? ` · ${domains}` : "";
    return `${okCount + failCount} pages (${okCount} ok, ${failCount} err)${domainsPart}`;
  }
  return `${Math.round(text.length / 1000)}k chars`;
}

function createExecutionTimer() {
  const startedAtMs = performance.now();
  return {
    step() { return performance.now(); },
    end() { return Math.max(0, Math.round(performance.now() - startedAtMs)); }
  };
}

function logBootConfig(config) {
  logEvent("boot.config", { searchRouteWarmupEngines: config.searchRouteWarmupEngines });
}

function truncateLink(value, maxChars = 50) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function cleanTitle(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const withoutUrl = text.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
  return withoutUrl || text;
}

function buildApiBaseUrl(config) {
  let host = String(config?.mcpApiHost || "http://localhost").trim();
  if (!/^https?:\/\//i.test(host)) {
    host = `http://${host}`;
  }
  host = host.replace(/\/+$/, "");
  const hasPort = /:\d+$/.test(host);
  if (!hasPort && config?.mcpApiPort) {
    host = `${host}:${config.mcpApiPort}`;
  }
  return host;
}

function resolveDisplayPath(filePath, prefix) {
  if (!filePath) return null;
  if (!prefix) return filePath;
  const relative = path.relative(screenshotStorageDir, filePath);
  const trimmed = prefix.replace(/[\\/]+$/, "");
  const suffix = path.basename(trimmed);
  if (suffix.toLowerCase() === "screenshots") {
    return path.join(trimmed, relative);
  }
  return path.join(trimmed, "screenshots", relative);
}

async function storeScreenshotDownload(entry, config, { enableDownload }) {
  if (!entry?.screenshotBase64) return null;
  await pruneScreenshotDownloads();
  await pruneStoredScreenshotFiles();
  await fs.mkdir(screenshotStorageDir, { recursive: true });
  const format = entry?.format === "jpeg" ? "jpeg" : "png";
  const extension = format === "jpeg" ? "jpg" : "png";
  const downloadId = randomUUID();
  const filename = `screenshot-${downloadId}.${extension}`;
  const filePath = path.join(screenshotStorageDir, filename);
  const buffer = Buffer.from(entry.screenshotBase64, "base64");
  await fs.writeFile(filePath, buffer);

  let downloadUrl = null;
  if (enableDownload) {
    screenshotDownloadById.set(downloadId, {
      path: filePath,
      filename,
      contentType: entry?.contentType || (format === "jpeg" ? "image/jpeg" : "image/png"),
      createdAt: Date.now()
    });
    const baseUrl = buildApiBaseUrl(config);
    downloadUrl = `${baseUrl}/download/${downloadId}`;
  }

  return {
    downloadId,
    downloadUrl,
    bytes: buffer.length,
    filePath
  };
}

async function deleteScreenshotRecord(downloadId, record) {
  screenshotDownloadById.delete(downloadId);
  if (!record?.path) return;
  try {
    await fs.rm(record.path, { force: true });
  } catch {
    // ignore cleanup errors
  }
}

async function pruneScreenshotDownloads() {
  const now = Date.now();
  for (const [downloadId, record] of screenshotDownloadById.entries()) {
    if (!record?.createdAt || now - record.createdAt > SCREENSHOT_DOWNLOAD_TTL_MS) {
      await deleteScreenshotRecord(downloadId, record);
    }
  }

  while (screenshotDownloadById.size > MAX_SCREENSHOT_DOWNLOADS) {
    const oldestEntry = screenshotDownloadById.entries().next().value;
    if (!oldestEntry) break;
    const [downloadId, record] = oldestEntry;
    await deleteScreenshotRecord(downloadId, record);
  }
}

async function storeSvgDownload(svgText, config, { enableDownload }) {
  if (!svgText) return null;
  await pruneScreenshotDownloads();
  await pruneStoredScreenshotFiles();
  await fs.mkdir(screenshotStorageDir, { recursive: true });
  const downloadId = randomUUID();
  const filename = `svg-${downloadId}.svg`;
  const filePath = path.join(screenshotStorageDir, filename);
  await fs.writeFile(filePath, svgText, "utf8");
  let downloadUrl = null;
  if (enableDownload) {
    screenshotDownloadById.set(downloadId, {
      path: filePath,
      filename,
      contentType: "image/svg+xml",
      createdAt: Date.now()
    });
    const baseUrl = buildApiBaseUrl(config);
    downloadUrl = `${baseUrl}/download/${downloadId}`;
  }
  return {
    downloadId,
    downloadUrl,
    bytes: Buffer.byteLength(svgText, "utf8"),
    filePath
  };
}

async function pruneStoredScreenshotFiles() {
  try {
    const entries = await fs.readdir(screenshotStorageDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("screenshot-") && !entry.name.startsWith("svg-")) continue;
      const filePath = path.join(screenshotStorageDir, entry.name);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > SCREENSHOT_DOWNLOAD_TTL_MS) {
          await fs.rm(filePath, { force: true });
        }
      } catch {
        // ignore cleanup errors
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

function decorateResultLinks(results) {
  if (!Array.isArray(results)) return results;

  return results.map((item) => {
    const rawUrl = String(item?.url || "").trim();
    if (!rawUrl) return item;

    const ref = rememberLink(rawUrl);
    const display = `[${truncateLink(rawUrl, 50)}](${ref})`;
    const domain = getDomain(rawUrl);

    return {
      ...item,
      ref_id: ref,
      domain,
      link: display,
      url: display
    };
  });
}

function decorateSearchPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;

  const output = {
    ...payload,
    results: decorateResultLinks(payload.results)
  };

  if (Array.isArray(payload.queryResults)) {
    output.queryResults = payload.queryResults.map((entry) => ({
      ...entry,
      results: decorateResultLinks(entry.results)
    }));
  }

  return output;
}

function formatSearchMarkdown(payload) {
  const lines = [];

  const multiQuery = Array.isArray(payload?.queryResults) && payload.queryResults.length > 1;
  if (multiQuery) {
    payload.queryResults.forEach((entry, sectionIndex) => {
      if (sectionIndex > 0) lines.push("");
      const queryLabel = entry?.query ? String(entry.query) : "";
      lines.push(`**Queries:** ${queryLabel}`);

      if (Array.isArray(entry?.directAnswers) && entry.directAnswers.length) {
        lines.push("", "**Instant Answer:**");
        entry.directAnswers.forEach((answer) => {
          const snippet = truncateForDisplay(answer?.text || "", 400);
          const link = answer?.url ? ` (${answer.url})` : "";
          lines.push(`- ${snippet}${link}`.trim());
        });
      }

      const results = Array.isArray(entry?.results) ? entry.results : [];
      if (results.length) {
        lines.push("", `**Results (${results.length}):**`);
        results.forEach((result, index) => {
          const refId = result?.ref_id;
          const titleText = cleanTitle(result?.title || "");
          const title = titleText ? `**${titleText}**` : "Untitled";
          const linkText = result?.domain || titleText || "link";
          const refLabel = refId ? `[${linkText}](${refId})` : `${index + 1}.`;
          const snippet = truncateForDisplay(result?.snippet || "", 450);
          const queryVariants = Array.isArray(result?.queryVariants) && result.queryVariants.length
            ? ` _(queries: ${result.queryVariants.join(", ")})_`
            : queryLabel
              ? ` _(queries: ${queryLabel})_`
              : "";

          const bullet = `- ${title} ${refLabel}${queryVariants}`;
          lines.push(bullet.trim());
          if (snippet) {
            lines.push(`  - ${snippet}`);
          }
        });
      } else {
        lines.push("", "No results returned.");
      }

      if (Array.isArray(entry?.errors) && entry.errors.length) {
        lines.push("", "**Errors:**");
        entry.errors.forEach((entryError) => {
          if (!entryError?.error) return;
          lines.push(`- ${entryError.error}`);
        });
      }
    });

    lines.push("", "*Link destinations in parentheses are ref_ids.*");
    return lines.filter(Boolean).join("\n");
  }

  if (payload?.query) {
    lines.push(`**Query:** ${payload.query}`);
  } else if (Array.isArray(payload?.queries) && payload.queries.length) {
    lines.push(`**Queries:** ${payload.queries.join(", ")}`);
  }

  if (Array.isArray(payload?.directAnswers) && payload.directAnswers.length) {
    lines.push("", "**Instant Answer:**");
    payload.directAnswers.forEach((answer) => {
      const snippet = truncateForDisplay(answer?.text || "", 400);
      const link = answer?.url ? ` (${answer.url})` : "";
      lines.push(`- ${snippet}${link}`.trim());
    });
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (results.length) {
    lines.push("", `**Results (${results.length}):**`);
    results.forEach((result, index) => {
      const refId = result?.ref_id;
      const titleText = cleanTitle(result?.title || "");
      const title = titleText ? `**${titleText}**` : "Untitled";
      const linkText = result?.domain || titleText || "link";
      const refLabel = refId ? `[${linkText}](${refId})` : `${index + 1}.`;
      const snippet = truncateForDisplay(result?.snippet || "", 450);
      const queryVariants = Array.isArray(result?.queryVariants) && result.queryVariants.length
        ? ` _(queries: ${result.queryVariants.join(", ")})_`
        : "";

      const bullet = `- ${title} ${refLabel}${queryVariants}`;
      lines.push(bullet.trim());
      if (snippet) {
        lines.push(`  - ${snippet}`);
      }
    });
    lines.push("", "*Link destinations in parentheses are ref_ids.*");
  } else {
    lines.push("", "No results returned.");
  }

  if (Array.isArray(payload?.errors) && payload.errors.length) {
    lines.push("", "**Errors:**");
    payload.errors.forEach((entry) => {
      if (!entry?.error) return;
      lines.push(`- ${entry.error}`);
    });
  }

  return lines.filter(Boolean).join("\n");
}

function formatSearchResponse(payload) {
  return asMarkdownContent(formatSearchMarkdown(payload));
}

function normalizeResultEntries(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.results)) return payload.results;
  if (typeof payload === "object" && ("ok" in payload || "text" in payload || "error" in payload)) {
    return [payload];
  }
  return [];
}

async function applyScreenshotStorage(payload, config, { outputMode } = {}) {
  if (outputMode === "base64") return payload;

  const entries = normalizeResultEntries(payload);
  if (!entries.length) return payload;

  if (outputMode === "file") {
    for (const entry of entries) {
      if (!entry?.ok || !entry?.screenshotBase64) continue;
      const download = await storeScreenshotDownload(entry, config, { enableDownload: false });
      if (!download) continue;
      entry.bytes = download.bytes;
      entry.filePath = resolveDisplayPath(download.filePath, config?.screenshotPathPrefix);
      delete entry.screenshotBase64;
    }
    return payload;
  }

  if (outputMode === "url") {
    for (const entry of entries) {
      if (!entry?.ok || !entry?.screenshotBase64) continue;
      const download = await storeScreenshotDownload(entry, config, { enableDownload: true });
      if (!download) continue;
      entry.downloadId = download.downloadId;
      entry.downloadUrl = download.downloadUrl;
      entry.bytes = download.bytes;
      delete entry.screenshotBase64;
    }
    return payload;
  }

  const wantsDownload = Boolean(config?.enableScreenshotDownloadLink);
  const wantsPath = Boolean(config?.screenshotPathPrefix);
  if (!wantsDownload && !wantsPath) return payload;

  for (const entry of entries) {
    if (!entry?.ok || !entry?.screenshotBase64) continue;
    const download = await storeScreenshotDownload(entry, config, { enableDownload: wantsDownload });
    if (!download) continue;
    if (wantsDownload) {
      entry.downloadId = download.downloadId;
      entry.downloadUrl = download.downloadUrl;
    }
    entry.bytes = download.bytes;
    if (wantsPath) {
      entry.filePath = resolveDisplayPath(download.filePath, config.screenshotPathPrefix);
    }
    delete entry.screenshotBase64;
  }

  return payload;
}

function truncateResultsText(payload, maxChars) {
  if (!payload || !maxChars || !Number.isFinite(maxChars) || maxChars <= 0) return payload;

  const entries = normalizeResultEntries(payload);
  if (!entries.length) return payload;

  const needsTruncation = entries.some((e) => e?.text && e.text.length > maxChars);
  if (!needsTruncation) return payload;

  const truncate = (e) => {
    if (!e || !e.text || e.text.length <= maxChars) return e;
    const size = e.textOriginalLength || e.text.length;
    return { ...e, text: e.text.slice(0, maxChars).trimEnd() + `\n\n*(Response truncated — full page is ${size} chars, increase maxChars to see more)*` };
  };

  if (payload.results) {
    return { ...payload, results: payload.results.map(truncate) };
  }
  return truncate(payload);
}

function formatOpenPageResponse(payload) {
  const entries = normalizeResultEntries(payload);
  if (!entries.length) {
    return asMarkdownContent([]);
  }

  const successCount = entries.filter((entry) => entry?.ok !== false).length;
  const total = payload?.count ?? entries.length;
  const lines = [`Processed ${total} page(s); ${successCount} succeeded.`];

  entries.forEach((entry, index) => {
    const title = entry?.title || entry?.url || `Page ${index + 1}`;
    const refLabel = entry?.ref_id ? `[${title}](${entry.ref_id})` : `#${index + 1} ${title}`;
    lines.push("", `### ${refLabel}`);
    lines.push(`- Status: ${entry?.ok === false ? "Failed" : "Success"}`);
    if (entry?.url) {
      lines.push(`- URL: ${entry.url}`);
    }
    if (entry?.browser) {
      lines.push(`- Browser: ${entry.browser}`);
    }
    if (entry?.browserNote) {
      lines.push(`- Browser: ${entry.browserNote}`);
    }
    if (entry?.pageType) {
      const conf = entry.confidence != null ? ` | confidence: ${entry.confidence.toFixed(2)}` : "";
      lines.push(`- Page type: ${entry.pageType}${conf}`);
    }
    if (entry?.warnings?.length) {
      for (const warning of entry.warnings) {
        lines.push(`- ⚠ ${warning}`);
      }
    }
    if (entry?.error) {
      lines.push(`- Error: ${entry.error}`);
      return;
    }
    if (entry?.tables?.length) {
      lines.push(`- Tables extracted: ${entry.tables.length}`);
    } else if (entry?.text) {
      const tableCount = (entry.text.match(/^### Table \d/gm) || []).length
        || (entry.text.match(/^# Table \d/gm) || []).length;
      if (tableCount) lines.push(`- Tables extracted: ${tableCount}`);
    }
    if (entry?.text) {
      lines.push("", entry.text.trim());
    }
  });

  return asMarkdownContent(lines.join("\n"));
}

function formatScreenshotResponse(payload) {
  const entries = normalizeResultEntries(payload);
  if (!entries.length) {
    return asMarkdownContent("No screenshot data available.");
  }

  const successCount = entries.filter((entry) => entry?.ok !== false).length;
  const total = payload?.count ?? entries.length;
  const lines = [`Captured ${total} screenshot(s); ${successCount} succeeded.`];

  entries.forEach((entry, index) => {
    const title = entry?.title || entry?.url || `Screenshot ${index + 1}`;
    const refLabel = entry?.ref_id ? `[${title}](${entry.ref_id})` : `#${index + 1} ${title}`;
    lines.push("", `### ${refLabel}`);
    lines.push(`- Status: ${entry?.ok === false ? "Failed" : "Success"}`);
    if (entry?.url) {
      lines.push(`- URL: ${entry.url}`);
    }
    if (entry?.browser) {
      lines.push(`- Browser: ${entry.browser}`);
    }
    if (entry?.browserNote) {
      lines.push(`- Browser: ${entry.browserNote}`);
    }
    if (entry?.error) {
      lines.push(`- Error: ${entry.error}`);
      return;
    }
    if (entry?.contentType) {
      lines.push(`- Content-Type: ${entry.contentType}`);
    }
    if (entry?.bytes) {
      lines.push(`- Size: ${entry.bytes} bytes`);
    }
    if (entry?.filePath) {
      lines.push(`- File: ${entry.filePath}`);
    }
    if (entry?.downloadUrl) {
      lines.push(`- Download: ${entry.downloadUrl}`);
    }
    if (!entry?.downloadUrl && entry?.screenshotBase64) {
      const mime = entry.contentType || (entry.format === "jpeg" ? "image/jpeg" : "image/png");
      const dataUrl = `data:${mime};base64,${entry.screenshotBase64}`;
      lines.push("", `![${title}](${dataUrl})`);
    }
  });

  return asMarkdownContent(lines.join("\n"));
}

function resolveOpenTarget(args) {
  const normalizedRef = args?.ref_id ?? args?.ref;
  const normalizedRefs = args?.ref_ids ?? args?.refs;
  const hasUrl = args && Object.prototype.hasOwnProperty.call(args, "url");
  const hasUrls = args && Object.prototype.hasOwnProperty.call(args, "urls");
  const hasRef = args && (Object.prototype.hasOwnProperty.call(args, "ref_id") || Object.prototype.hasOwnProperty.call(args, "ref"));
  const hasRefs = args && (Object.prototype.hasOwnProperty.call(args, "ref_ids") || Object.prototype.hasOwnProperty.call(args, "refs"));

  if (hasUrls) {
    if (Array.isArray(args.urls) && args.urls.length) {
      const normalizedUrls = args.urls.map((item) => {
        assertString(item, "urls[]");
        return String(item).trim();
      }).filter(Boolean);

      if (normalizedUrls.length) {
        return normalizedUrls;
      }
    }
  }

  if (hasRefs) {
    if (Array.isArray(normalizedRefs) && normalizedRefs.length) {
      return normalizedRefs.map((item) => {
        const ref = parsePositiveInt(item, "ref_ids[]");
        const remembered = getRememberedLinkRecord(ref);
        if (!remembered?.url) {
          throw new Error(`No link found in memory for ref ${ref}`);
        }
        return remembered.url;
      });
    }
  }

  if (hasRef) {
    if (normalizedRef !== undefined && normalizedRef !== null && String(normalizedRef).trim() && Number(normalizedRef) > 0) {
      const ref = parsePositiveInt(normalizedRef, "ref_id");
      const remembered = getRememberedLinkRecord(ref);
      if (!remembered?.url) {
        throw new Error(`No link found in memory for ref ${ref}`);
      }
      return [remembered.url];
    }
  }

  if (hasUrl) {
    if (typeof args.url === "string" && args.url.trim()) {
      return [String(args.url).trim()];
    }
  }

  throw new Error("Invalid input: provide one of url, urls, ref_id/ref, or ref_ids/refs");
}

function buildBatchResultPayload(targetUrls, opened) {
  const payload = {
    count: opened.length,
    successCount: opened.filter((item) => item.ok).length,
    results: opened
  };

  if (targetUrls.length === 1 && opened[0]?.ok) {
    return { ...opened[0], results: undefined };
  }

  return payload;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const values = Array.from(items || []);
  const limit = Math.max(1, Math.min(concurrency, values.length || 1));
  const results = new Array(values.length);
  let cursor = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

async function openTargetsParallel(targetUrls, maxParallel, includeSeoAnalysis = false, debug = false, opts = {}) {
  const opened = await mapWithConcurrency(
    targetUrls,
    maxParallel,
    async (targetUrl, index) => {
      const tUrl = debug ? performance.now() : 0;
      try {
        const page = await browserOpenAndExtract({
          url: targetUrl,
          includeSeoAnalysis,
          hintOverride: opts?.hintOverride || null,
          cachedHtml: opts?.cachedHtmlByUrl?.get(targetUrl) || null,
          captureHtml: opts?.captureHtml === true,
          browser: opts?.browser || ""
        });
        if (debug) console.log(`[web_fetch] [${targetUrl}] openTargetsParallel process (post-extract): ${Math.round(performance.now() - tUrl)}ms`);
        const result = {
          index,
          ok: true,
          ref_id: rememberLink(targetUrl),
          ...page
        };

        // Replace markdown links [text](url) with [text](ref_id) inline
        if (opts.enableLinkRefs !== false && page.links?.length && result.text) {
          for (const link of page.links) {
            rememberLink(link.href);
          }
          const enrichedTextByUrl = new Map();
          for (const link of page.links) {
            enrichedTextByUrl.set(link.href, link.text);
          }
          result.text = result.text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
            const ref = getLinkRefByUrl(url);
            if (!ref) return match;
            const enriched = enrichedTextByUrl.get(url);
            const isNumeric = /^\d+$/.test(text);
            return `[${isNumeric && enriched ? enriched : text}](${ref})`;
          });
        }

        return result;
      } catch (error) {
        return {
          index,
          ok: false,
          ref_id: rememberLink(targetUrl),
          url: targetUrl,
          error: String(error?.message || error)
        };
      }
    }
  );

  return buildBatchResultPayload(targetUrls, opened);
}

async function captureScreenshotsParallel(targetUrls, maxParallel, captureOptions = {}) {
  const opened = await mapWithConcurrency(
    targetUrls,
    maxParallel,
    async (targetUrl, index) => {
      try {
        const capture = await browserCaptureScreenshot({ url: targetUrl, browser: captureOptions?.browser || "", ...captureOptions });
        return {
          index,
          ok: true,
          ref_id: rememberLink(targetUrl),
          ...capture
        };
      } catch (error) {
        return {
          index,
          ok: false,
          ref_id: rememberLink(targetUrl),
          url: targetUrl,
          error: String(error?.message || error)
        };
      }
    }
  );

  return buildBatchResultPayload(targetUrls, opened);
}

function parseHttpExtractTargets(searchParams) {
  const refsParam = String(searchParams.get("ref_ids") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (refsParam.length) {
    return refsParam.map((item) => {
      const ref = parsePositiveInt(item, "ref_ids[]");
      const remembered = getRememberedLinkRecord(ref);
      if (!remembered?.url) {
        throw new Error(`No link found in memory for ref ${ref}`);
      }
      return remembered.url;
    });
  }

  const urlsParam = String(searchParams.get("urls") || "")
    .split("||")
    .map((item) => item.trim())
    .filter(Boolean);
  if (urlsParam.length) {
    return urlsParam;
  }

  const refParam = searchParams.get("ref_id");
  if (refParam && refParam.trim()) {
    const ref = parsePositiveInt(refParam, "ref_id");
    const remembered = getRememberedLinkRecord(ref);
    if (!remembered?.url) {
      throw new Error(`No link found in memory for ref ${ref}`);
    }
    return [remembered.url];
  }

  const urlParam = String(searchParams.get("url") || "").trim();
  if (urlParam) return [urlParam];

  throw new Error("Missing url, urls, ref_id, or ref_ids query parameter");
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_HTTP_BODY_BYTES) {
      const error = new Error(`Request body too large (max ${MAX_HTTP_BODY_BYTES} bytes)`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }

  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function getDisabledToolsSet() {
  const list = manager?.config?.disableTools || [];
  return new Set(list.map((name) => String(name).trim().toLowerCase()).filter(Boolean));
}

function isToolDisabled(name) {
  return getDisabledToolsSet().has(String(name).toLowerCase());
}

function getToolsListResponse(allowedTools = null) {
  const devtoolsEnabled = Boolean(manager?.config?.enableDevtoolsMcp);
  const disabledTools = getDisabledToolsSet();
  return {
    tools: [
      {
        name: "web_search",
        description:
          "Search the web for any user request and return ranked results with numeric result ids. By default, send `engine: \"select_best\"` or omit engine entirely unless the user explicitly asks about engines or requests a specific one. `select_best` means the server will choose the best engine automatically using its fallback and circuit-breaker logic. Use this for general research, fact lookup, docs, tutorials, comparisons, news, and discovery before opening pages.",
        inputSchema: {
          type: "object",
          properties: {
            queries: {
              type: "array",
              items: { type: "string" },
              description: "One or more search queries to run (query variations)"
            },
            limit: { type: "number", default: 5 },
            bypassCache: {
              type: "boolean",
              default: false,
              description: "Skip cached data and refresh the cached response"
            },
            engine: {
              type: "string",
              default: "select_best",
              description: "Preferred default: `select_best`, which uses only SEARCH_ENABLED_ENGINES. A registered route may be named explicitly even when it is not enabled for `select_best`."
            }
          },
          description: "Provide queries (string[]). Use queries for one or more search variations.",
          additionalProperties: false
        }
      },
      {
        name: "web_fetch",
        description:
          "Fetch one or more pages and return clean readable text for analysis. Use this after web_search via ref_ids or with direct urls for summarization, extraction, QA, and synthesis.",
        inputSchema: {
          type: "object",
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              description: "One or more URLs to open"
            },
            ref_ids: {
              type: "array",
              items: { type: "number" },
              description: "Result ids returned by a previous web_search call"
            },
            maxChars: { type: "number", default: DEFAULT_MAX_CHARS },
            bypassCache: {
              type: "boolean",
              default: false,
              description: "Skip cached data and refresh the cached response"
            },
            browser: {
              type: "string",
              description: "Browser to use (chromium default, or an add-on name from list_browsers). Defaults to the matching hint's browserEngine. NOTE: a navigator-cdp browser (ownership \"user\") is the user's real, visible, non-headless window."
            }
          },
          description: "Provide one of: urls (string[]) or ref_ids (number[]) from a previous web_search call. Prefer ref_ids when available.",
          additionalProperties: false
        }
      },
      {
        name: "web_page_screenshot",
        description:
          "Open one or more pages and return screenshots (JPEG). Use this to capture visual snapshots of results discovered via web_search. Alternatively, pass a targetId from Target.createTarget to screenshot an existing persistent tab.",
        inputSchema: {
          type: "object",
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              description: "One or more URLs to open"
            },
            ref_ids: {
              type: "array",
              items: { type: "number" },
              description: "Result ids returned by a previous web_search call"
            },
            targetId: {
              type: "string",
              description: "Target id from Target.createTarget. Screenshots the existing tab instead of opening a new one."
            },
            browser: {
              type: "string",
              description: "Browser to use (chromium default, or an add-on name from list_browsers). Screenshots an existing tab for a targetId when no value is set. NOTE: a navigator-cdp browser (ownership \"user\") is the user's real, visible, non-headless window."
            },
            viewport: {
              type: "object",
              properties: {
                width: { type: "number", description: "Viewport width in CSS pixels" },
                height: { type: "number", description: "Viewport height in CSS pixels" }
              },
              additionalProperties: false,
              description:
                "Viewport size for the screenshot (same style as Target.createTarget viewport). When fullPage is true only width matters — height is ignored and defaults to 1080 if omitted. When fullPage is false both width and height define the viewport."
            },
            quality: {
              type: "string",
              enum: ["low", "medium", "high"],
              default: "medium",
              description:
                "JPEG quality preset: low (30, small file), medium (55, balanced), high (75, detailed)."
            },
            fullPage: {
              type: "boolean",
              default: true,
              description: "Capture the entire page, not just the viewport"
            },
            output: {
              type: "string",
              enum: (() => {
                const options = ["base64"];
                if (manager?.config?.screenshotPathPrefix) options.push("file");
                if (manager?.config?.enableScreenshotDownloadLink) options.push("url");
                return options;
              })(),
              default: "base64",
              description: "How to return the screenshot: 'base64' (inline data), 'file' (save to disk, returns path), 'url' (returns download URL). Available options depend on server configuration."
            }
          },
          description: "Provide one of: targetId, urls (string[]), or ref_ids (number[]) from a previous web_search call. Prefer ref_ids when available.",
          additionalProperties: false
        }
      },
      {
        name: "web_page_links",
        description:
          "Resolve one or more link ref_ids (shown inline in web_fetch output as [text](ref_id)) to their full URLs. Returns the URL for each ref_id.",
        inputSchema: {
          type: "object",
          properties: {
            ref_ids: {
              type: "array",
              items: { type: "number" },
              description: "Link ref_ids to resolve (e.g. [4, 5, 6])"
            }
          },
          additionalProperties: false
        }
      },
      {
        name: "web_page_ascii",
        description:
          "Capture a webpage as a chafa-style half-block render (real screenshot downscaled to block characters with truecolor ANSI codes) plus an element legend. Use this to understand page layout, colors, and where interactive elements sit. Pair with web_fetch for full text.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            ref_id: { type: "number" },
            width: {
              type: "number",
              default: 100,
              description: "Render width in characters (40-200)"
            },
            fullPage: {
              type: "boolean",
              default: false,
              description: "Capture full scrollable page (default: viewport only)"
            },
            mode: {
              type: "string",
              enum: ["color_ansi", "grayscale_ansi", "ascii"],
              default: "color_ansi",
              description: "Render mode: color_ansi (truecolor half-blocks), grayscale_ansi (gray half-blocks), ascii (plain char ramp, no escape codes)"
            },
            elementLimit: {
              type: "number",
              default: 25,
              description: "Max elements to annotate (1-100)"
            },
            includeSelector: { type: "boolean", default: true },
            includeXpath: { type: "boolean", default: true },
            browser: {
              type: "string",
              description: "Browser to use (chromium default, or an add-on name from list_browsers). NOTE: a navigator-cdp browser (ownership \"user\") is the user's real, visible, non-headless window."
            }
          },
          additionalProperties: false
        }
      },
      {
        name: "web_page_svg",
        description:
          "Capture a webpage as a faithful SVG render — each visible element is a filled rect (with optional rx for rounded corners) so the SVG looks like the screenshot, plus per-element g data-* attributes (data-tag, data-selector, data-xpath, data-x/y/width/height) and rect x/y/width/height rx so the agent can compute positions, containment, and flow without decoding pixels. Text inside each box is real text with computed color/font. Use instead of web_page_screenshot when you need both a render and layout geometry.",
        inputSchema: {
          type: "object",
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              description: "One or more URLs to snapshot"
            },
            ref_ids: {
              type: "array",
              items: { type: "number" },
              description: "Result ids from a previous web_search call"
            },
            targetId: {
              type: "string",
              description: "Target id from Target.createTarget — snapshots the live tab, reflecting JS-driven state"
            },
            fullPage: {
              type: "boolean",
              default: false,
              description: "false=viewport only (default), true=full scrollable document (like web_page_screenshot fullPage:true)"
            },
            elementLimit: {
              type: "number",
              default: 5000,
              description: "Max elements in the SVG (1-5000). Higher = more boxes but larger SVG."
            },
            viewport: {
              type: "object",
              properties: {
                width: { type: "number", description: "Viewport width in CSS pixels" },
                height: { type: "number", description: "Viewport height in CSS pixels" }
              },
              additionalProperties: false,
              description:
                "Viewport override (CSS px). fullPage:false requires both; fullPage:true only width matters (height→1080) — same contract as web_page_screenshot / Target.createTarget"
            },
            includeSelector: { type: "boolean", default: true },
            includeXpath: { type: "boolean", default: true },
            browser: {
              type: "string",
              description: "Browser to use (chromium default, or an add-on name from list_browsers). NOTE: a navigator-cdp browser (ownership \"user\") is the user's real, visible, non-headless window."
            },
            hybrid: { type: "boolean", default: false, description: "When true, SVG includes <foreignObject> with inlined HTML for 100% visual fidelity (hybrid: foreignObject visual + rect data-* geometry). Use for pixel-perfect replication of http://10.69.1.164:1994/." },
            output: {
              type: "string",
              enum: ["inline", "file", "url"],
              default: "inline",
              description: "inline=markdown ```svg block, file=save to screenshots/*.svg, url=download URL"
            }
          },
          additionalProperties: false
        }
      },
      {
        name: "list_browsers",
        description:
          "List all configured browser backends with their roles, connection status, type, and ownership. ownership \"user\" = a `navigator-cdp` relay browser — that is the USER's real, visible, NON-headless browser window; everything the agent does there (tabs, clicks, navigation, screenshots input) appears on the user's screen, so the user can see it. ownership \"agent\" = navigator-owned browsers (builtin Chromium, plain `cdp` add-ons like cloakbrowser/lightpanda) that are headless/invisible to the user. Use to discover available browsers and know whether activity is user-visible before routing devtools calls.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      },
      ...(devtoolsEnabled ? devtoolsToolDefinitions : [])
    ].filter((tool) => !disabledTools.has(String(tool.name).toLowerCase()) && (!allowedTools || allowedTools.has(tool.name)))
  };
}

async function handleToolCall(name, args = {}, allowedTools = null) {
  try {
    if (allowedTools && !allowedTools.has(name)) {
      throw new Error(`Tool "${name}" is not permitted for this API key`);
    }
    const result = await handleToolCallInner(name, args);
    recordActivityRequest(name, true);
    return result;
  } catch (error) {
    recordActivityRequest(name, false, error?.message || String(error));
    throw error;
  }
}

async function handleToolCallInner(name, args = {}) {
  const timer = createExecutionTimer("mcp.tool.timing", {
    tool: name,
    mode: "mcp"
  });
  let mark = performance.now();

  if (isToolDisabled(name)) {
    const msg = `Tool "${name}" is disabled (listed in DISABLE_TOOLS). Remove it from DISABLE_TOOLS in the environment to enable it.`;
    timer.step("disabled_tool", mark);
    timer.end({ status: "error", error: msg });
    throw new Error(msg);
  }

  if (name === "web_search") {
    const bypassCache = args.bypassCache === true;
    const cacheKeyArgs = getCacheArgs(args);
    const cached = bypassCache ? null : await getCachedToolResult(name, cacheKeyArgs);
    if (cached) {
      timer.step("cache_hit", mark);
      timer.end({ cacheHit: true, status: "ok" });
      return cached;
    }
    mark = timer.step("cache_miss", mark);
    const queries = parseQueryList(args.queries);
    if (!queries.length && typeof args.query === "string" && args.query.trim()) {
      queries.push(args.query.trim());
    }
    if (!queries.length) {
      throw new Error("Missing queries: provide at least one search query (string[])");
    }
    const limit = parseSearchLimit(args.limit, 5);
    const engine = typeof args.engine === "string" ? String(args.engine).trim().toLowerCase() : "";
    const engines = engine && engine !== "select_best" ? [engine] : [];
    mark = timer.step("validate_inputs", mark);

    const results = await runWithHangGuard(`mcp:${name}`, () =>
      browserSearch({
        queries,
        limit,
        ...(engines.length ? { engines } : {})
      })
    );
    mark = timer.step("browser_search", mark);
    const response = formatSearchResponse(decorateSearchPayload(results));
    mark = timer.step("format_response", mark);
    await setCachedToolResult(name, getCacheArgs(args), response);
    timer.step("cache_store", mark);
    timer.end({ cacheHit: false, status: "ok" });
    return response;
  }

  if (name === "web_fetch") {
    const manager = await getBrowserManager();
    const bypassCache = args.bypassCache === true;
    const cacheKeyArgs = excludeMaxChars(getCacheArgs(args));
    let targetUrls;
    try {
      targetUrls = resolveOpenTarget(args);
    } catch (error) {
      timer.step("resolve_targets_failed", mark);
      timer.end({ cacheHit: false, status: "error", error: String(error?.message || error) });
      logEvent("mcp.error", {
        tool: name,
        error: String(error?.message || error)
      });
      throw error;
    }
    mark = timer.step("resolve_targets", mark);

    const cached = bypassCache ? null : await getCachedToolResult(name, cacheKeyArgs);
    if (cached) {
      const maxChars = parseMaxChars(args.maxChars, manager.config.maxChars || DEFAULT_MAX_CHARS);
      const truncated = truncateResultsText(cached, maxChars);
      timer.step("cache_hit", mark);
      timer.end({ cacheHit: true, status: "ok" });
      return formatOpenPageResponse(truncated);
    }
    mark = timer.step("cache_miss", mark);
    const maxChars = parseMaxChars(args.maxChars, manager.config.maxChars || DEFAULT_MAX_CHARS);
    const includeSeoAnalysis = args.includeSeoAnalysis !== false;
    mark = timer.step("prepare_execution", mark);
    const fullResult = await runWithHangGuard(`mcp:${name}`, () =>
      openTargetsParallel(targetUrls, manager.config.openPageMaxParallel, includeSeoAnalysis, manager.config.debug, { enableLinkRefs: manager.config.enableLinkRefs, browser: args.browser || "" })
    );
    mark = timer.step("open_targets", mark);
    await setCachedToolResult(name, cacheKeyArgs, fullResult);
    timer.step("cache_store", mark);
    const truncated = truncateResultsText(fullResult, maxChars);
    const response = formatOpenPageResponse(truncated);
    mark = timer.step("format_response", mark);
    timer.end({ cacheHit: false, status: "ok" });
    return response;
  }

  if (name === "web_page_screenshot") {
    const screenshotStartedAt = performance.now();
    const hasTargetId = args && typeof args.targetId === "string" && args.targetId.trim();
    const format = "jpeg";
    let quality;
    if (typeof args.quality !== "undefined" && args.quality !== null) {
      const QUALITY_PRESETS = { low: 30, medium: 55, high: 75 };
      const preset = String(args.quality).trim().toLowerCase();
      if (preset in QUALITY_PRESETS) {
        quality = QUALITY_PRESETS[preset];
      } else {
        quality = parsePositiveInt(args.quality, "quality");
        quality = Math.min(100, Math.max(1, quality));
      }
    }
    if (quality === undefined) quality = 55;
    const fullPage = args.fullPage === undefined ? true : Boolean(args.fullPage);
    const viewport = parseScreenshotViewport(args.viewport, fullPage);

    const allowedOutputModes = ["base64"];
    if (manager?.config?.screenshotPathPrefix) allowedOutputModes.push("file");
    if (manager?.config?.enableScreenshotDownloadLink) allowedOutputModes.push("url");
    const outputMode = allowedOutputModes.includes(args.output) ? args.output : "base64";

    const screenshotCtx = {
      format,
      quality: quality ?? "default",
      fullPage,
      viewport: viewport || "default",
      target: hasTargetId ? args.targetId.trim() : (args.urls || args.ref_ids || "unknown")
    };
    console.error(`📸  screenshot context: ${JSON.stringify(screenshotCtx)}`);

    let result;
    if (hasTargetId) {
      mark = timer.step("prepare_execution", mark);
      const pageOpId = recordPageOpStart({ tool: name, url: args.targetId.trim(), backend: getLastUsedBackend(args.targetId.trim()) });
      try {
        result = await runWithHangGuard(`mcp:${name}`, () =>
          captureTargetScreenshot({
            targetId: args.targetId.trim(),
            format,
            fullPage,
            ...(quality ? { quality } : {}),
            ...(viewport ? { viewport } : {})
          })
        );
        recordPageOp({
          id: pageOpId,
          tool: name,
          url: result.url || args.targetId.trim(),
          backend: getLastUsedBackend(args.targetId.trim()),
          durationMs: performance.now() - screenshotStartedAt,
          responseChars: result.screenshotBase64?.length
        });
      } catch (error) {
        recordPageOp({
          id: pageOpId,
          tool: name,
          url: args.targetId.trim(),
          backend: getLastUsedBackend(args.targetId.trim()),
          durationMs: performance.now() - screenshotStartedAt,
          ok: false,
          error: String(error?.message || error)
        });
        console.error(`📸  screenshot failed [targetId]: ${JSON.stringify(screenshotCtx)}`);
        console.error(`📸  error: ${String(error?.message || error)}`);
        if (error?.stack) console.error(`📸  stack: ${truncateStr(error.stack, 500)}`);
        throw error;
      }
      result = { ...result, ok: true };
    } else {
      let targetUrls;
      try {
        targetUrls = resolveOpenTarget(args);
      } catch (error) {
        console.error(`📸  screenshot failed [resolve_targets]: ${String(error?.message || error)}`);
        timer.step("resolve_targets_failed", mark);
        timer.end({ status: "error", error: String(error?.message || error) });
        logEvent("mcp.error", {
          tool: name,
          error: String(error?.message || error)
        });
        throw error;
      }
      mark = timer.step("resolve_targets", mark);
      const manager = await getBrowserManager();
      mark = timer.step("prepare_execution", mark);

      try {
        result = await runWithHangGuard(`mcp:${name}`, () =>
          captureScreenshotsParallel(targetUrls, manager.config.openPageMaxParallel, {
            format,
            fullPage,
            ...(quality ? { quality } : {}),
            ...(viewport ? { viewport } : {}),
            browser: args.browser || ""
          })
        );
      } catch (error) {
        console.error(`📸  screenshot failed [url]: ${JSON.stringify(screenshotCtx)}`);
        console.error(`📸  urls: ${JSON.stringify(targetUrls)}`);
        console.error(`📸  error: ${String(error?.message || error)}`);
        if (error?.stack) console.error(`📸  stack: ${truncateStr(error.stack, 500)}`);
        throw error;
      }
    }
    mark = timer.step("capture_screenshots", mark);
    await applyScreenshotStorage(result, manager.config, { outputMode });
    mark = timer.step("store_screenshots", mark);
    const response = formatScreenshotResponse(result);
    timer.step("format_response", mark);
    timer.end({ status: "ok" });
    return response;
  }

  if (name === "web_page_ascii") {
    const targetUrls = (() => {
      try {
        return resolveOpenTarget(args);
      } catch (error) {
        timer.step("resolve_targets_failed", mark);
        timer.end({ status: "error", error: String(error?.message || error) });
        logEvent("mcp.error", { tool: name, error: String(error?.message || error) });
        throw error;
      }
    })();
    mark = timer.step("resolve_targets", mark);

    const width = Math.max(40, Math.min(200, args.width ? parsePositiveInt(args.width, "width") : 100));
    const elementLimit = Math.max(1, Math.min(100, args.elementLimit ? parsePositiveInt(args.elementLimit, "elementLimit") : 25));
    const fullPage = args.fullPage === true;
    const mode = ["color_ansi", "grayscale_ansi", "ascii"].includes(args.mode)
      ? args.mode
      : "color_ansi";
    const includeSelector = args.includeSelector !== false;
    const includeXpath = args.includeXpath !== false;

    const targetUrl = targetUrls[0];
    const manager = await getBrowserManager();
    mark = timer.step("prepare_execution", mark);

    const ELEMENT_EXTRACT_CODE = `
(function extractElements(limit) {
  function cssPath(element) {
    if (!(element instanceof Element)) return null;
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 10) {
      let segment = node.tagName.toLowerCase();
      if (node.id) {
        segment += '#' + node.id;
        parts.unshift(segment);
        break;
      }
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter(c => c.tagName === node.tagName)
        : [];
      if (siblings.length > 1) {
        const index = siblings.indexOf(node);
        segment += ':nth-of-type(' + (index + 1) + ')';
      }
      parts.unshift(segment);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function xpathFor(element) {
    if (!(element instanceof Element)) return null;
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(node.tagName.toLowerCase() + '[' + index + ']');
      node = node.parentElement;
    }
    return '/' + parts.join('/');
  }

  function visible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none';
  }

  const scrollX = window.scrollX || 0;
  const scrollY = window.scrollY || 0;
  const nodes = [];
  const seen = new Set();
  let index = 0;

  function addNode(el, kind, priority) {
    const key = cssPath(el);
    if (!key || seen.has(key)) return;
    seen.add(key);

    const rect = el.getBoundingClientRect();
    if (!visible(el)) return;

    let text = '';
    let link = '';

    if (kind === 'img') {
      link = el.src || el.getAttribute('data-src') || '';
      text = el.alt || link.split('/').pop() || 'image';
    } else {
      text = (el.innerText || el.textContent || '').trim().slice(0, 300);
      if (!text && el.placeholder) text = el.placeholder;
    }

    if (!text && kind === 'interactive') return;

    index++;
    nodes.push({
      index,
      kind,
      priority,
      tagName: el.tagName.toLowerCase(),
      selector: key,
      xpath: xpathFor(el),
      role: el.getAttribute('role') || '',
      text: text || '',
      link: link || '',
      href: el.href || '',
      rect: {
        x: Math.round(rect.x + scrollX),
        y: Math.round(rect.y + scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  }

  document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(el => {
    addNode(el, 'heading', 1);
  });

  document.querySelectorAll('p').forEach(el => {
    const text = (el.innerText || el.textContent || '').trim();
    if (text.length > 10) addNode(el, 'paragraph', 2);
  });

  document.querySelectorAll('img').forEach(el => {
    if (el.src && visible(el)) addNode(el, 'img', 3);
  });

  document.querySelectorAll('a[href]').forEach(el => {
    const text = (el.innerText || el.textContent || '').trim();
    if (text.length > 1) addNode(el, 'link', 4);
  });

  document.querySelectorAll('button, input, textarea, select, label, [role="button"]').forEach(el => {
    addNode(el, 'interactive', 5);
  });

  let liCount = 0;
  document.querySelectorAll('li').forEach(el => {
    if (liCount >= 20) return;
    const text = (el.innerText || el.textContent || '').trim();
    if (text.length > 5 && text.length < 200) {
      addNode(el, 'list-item', 6);
      liCount++;
    }
  });

  return {
    title: document.title,
    url: location.href,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pageWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
    elements: nodes.slice(0, limit),
  };
})
`;

    let asciiResult;
    let usedBrowser = "";
    let asciiBrowserNotes = [];
    try {
      asciiResult = await runWithHangGuard(`mcp:${name}`, () => manager.withPageSlot(async () => {
        const { page, browser: resolvedBrowser, rollbackNotes = [] } = await resolveBrowserParam({ browser: args.browser || "" }, manager.config, manager);
        usedBrowser = resolvedBrowser;
        asciiBrowserNotes = rollbackNotes;
        try {
          await page.goto(targetUrl, {
            waitUntil: manager.config.navWaitUntil,
            timeout: manager.config.browserOpTimeoutMs,
          });
          await page.waitForFunction(
            () => document.readyState === "complete" || document.readyState === "interactive",
            { timeout: 10000 }
          ).catch(() => {});
          await new Promise((r) => setTimeout(r, 1000));

          const elementFn = eval(ELEMENT_EXTRACT_CODE);
          const elementData = await Promise.race([
            page.evaluate(elementFn, elementLimit),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Element extraction timed out")), 15000))
          ]);

          const vw = elementData.viewportWidth;
          const vh = elementData.viewportHeight;
          const clipW = fullPage ? elementData.pageWidth : vw;
          const clipH = fullPage ? elementData.pageHeight : vh;
          const margin = 50;
          const visible = elementData.elements.filter((el) => {
            const r = el.rect;
            return r.x + r.width > -margin && r.x < clipW + margin
              && r.y + r.height > -margin && r.y < clipH + margin;
          });

          const { cols, rows } = asciiGridDims(clipW, clipH, width);

          const shot = await page.screenshot({
            type: "png",
            encoding: "base64",
            ...(fullPage ? { fullPage: true } : {}),
          });

          const sampleFn = eval(SAMPLE_PIXELS_CODE);
          const samples = await page.evaluate(sampleFn, shot, cols, rows);

          const filteredElements = visible.map((el) => ({
            ...el,
            ...(includeSelector ? {} : { selector: undefined }),
            ...(includeXpath ? {} : { xpath: undefined }),
          }));

          const result = asciiTransform(samples, cols, rows, filteredElements, clipW, clipH, {
            mode,
            includeSelector,
            includeXpath,
          });

          return {
            title: elementData.title,
            url: elementData.url,
            browser: resolvedBrowser,
            ...(rollbackNotes.length ? { browserNote: `Browser rollback: ${rollbackNotes.join(", ")}` } : {}),
            ansi: result.ansi,
            legend: result.legend,
            stats: {
              asciiCols: cols,
              asciiRows: rows,
              mode: result.stats.mode,
              fullPage,
              viewportWidth: vw,
              viewportHeight: vh,
              pageWidth: elementData.pageWidth,
              pageHeight: elementData.pageHeight,
              elementCount: elementData.elements.length,
              placedCount: result.stats.placedCount,
            },
          };
        } finally {
          if (!page.isClosed()) {
            await page.close();
          }
        }
      }));
    } catch (error) {
      console.error(`🖼️  ascii failed: url=${targetUrl} error=${String(error?.message || error)}`);
      if (error?.stack) console.error(`🖼️  stack: ${truncateStr(error.stack, 500)}`);
      throw error;
    }
    mark = timer.step("capture_ascii", mark);

    const isAscii = asciiResult.stats.mode === "ascii";
    const lines = [
      `### ${asciiResult.title || "Page"} — ${asciiResult.stats.mode === "color_ansi" ? "Chafa Render" : asciiResult.stats.mode === "grayscale_ansi" ? "Grayscale Render" : "ASCII Render"}`,
      "",
      `\`\`\`${isAscii ? "text" : "ansi"}`,
      asciiResult.ansi,
      "```",
      "",
      "### Element Legend",
      "",
      asciiResult.legend,
      "",
      `- Page: ${asciiResult.title} (${asciiResult.url})`,
      `- Browser: ${asciiResult.browser || "chromium"}${asciiResult.browserNote ? ` — ${asciiResult.browserNote}` : ""}`,
      `- Grid: ${asciiResult.stats.asciiCols}×${asciiResult.stats.asciiRows} cells${
        asciiResult.stats.fullPage ? " (full page)" : " (viewport)"
      } · mode: ${asciiResult.stats.mode}`,
      `- Elements: ${asciiResult.stats.elementCount} found, ${asciiResult.stats.placedCount} annotated`,
    ];

    const response = asMarkdownContent(lines.join("\n"));
    timer.step("format_response", mark);
    timer.end({ status: "ok" });
    return response;
  }

  if (name === "web_page_svg") {
    let elementLimit = Math.max(1, Math.min(5000, args.elementLimit ? parsePositiveInt(args.elementLimit, "elementLimit") : 5000));
    // webcontentextraction.org table was missed with limit 100 (0 td) — ensure fullPage captures all data tables
    if (args.fullPage === true && elementLimit < 500) elementLimit = 500;
    const fullPage = args.fullPage === true;
    const includeSelector = args.includeSelector !== false;
    const includeXpath = args.includeXpath !== false;
    const hybrid = args.hybrid === true;
    const output = ["inline", "file", "url"].includes(args.output) ? args.output : "inline";
    const hasTargetId = typeof args.targetId === "string" && args.targetId.trim().length > 0;

    // Viewport handling — independent, mirrors screenshot contract
    let viewportOverride = null;
    if (args.viewport !== undefined && args.viewport !== null) {
      const vp = args.viewport;
      if (!vp || typeof vp !== "object" || Array.isArray(vp)) throw new Error("Invalid input: viewport must be an object with width and height");
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
      viewportOverride = { width: w, height: h };
    }

    const managerSvg = await getBrowserManager();
    mark = timer.step("prepare_execution", mark);

    if (hasTargetId) {
      const targetId = String(args.targetId).trim();
      const state = await getTargetState(targetId);
      let prevViewport = null;
      let didOverride = false;
      if (viewportOverride) {
        try { prevViewport = state.page.viewport(); } catch {}
        if (!prevViewport) prevViewport = { width: 1920, height: 1080 };
        await state.page.setViewport(viewportOverride);
        didOverride = true;
      }
      let svgResult;
      try {
        const cap = await capturePageAsSvg(state.page, { elementLimit, fullPage, includeSelector, includeXpath, hybrid });
        svgResult = { svg: cap.svg, title: cap.data.title, url: cap.data.url, stats: { width: cap.clipW, height: cap.clipH, viewportWidth: cap.data.viewportWidth, viewportHeight: cap.data.viewportHeight, pageWidth: cap.data.pageWidth, pageHeight: cap.data.pageHeight, elementCount: cap.data.elements.length, filteredCount: cap.filtered.length, bytes: cap.built.stats.bytes, fullPage }, filteredCount: cap.filtered.length, elementCount: cap.data.elements.length, bytes: cap.built.stats.bytes };
        // keep cap.data for potential use
        svgResult._capData = cap.data;

        svgResult.targetId = targetId;
      } finally {
        if (didOverride && prevViewport) {
          try { await state.page.setViewport(prevViewport); } catch {}
        }
      }
      mark = timer.step("capture_svg", mark);

      if (output === "file" || output === "url") {
        const stored = await storeSvgDownload(svgResult.svg, managerSvg.config, { enableDownload: output === "url" });
        if (stored) {
          svgResult.filePath = stored.filePath;
          svgResult.bytes = stored.bytes;
          if (stored.downloadUrl) {
            svgResult.downloadUrl = stored.downloadUrl;
            svgResult.downloadId = stored.downloadId;
          }
          if (output === "file" || output === "url") {
            // keep svg inline for file/url too? Return metadata + file path
          }
        }
      }

      const lines = [
        `### ${svgResult.title || "Page"} — SVG Render (faithful)`,
        "",
        "```svg",
        output === "inline" ? svgResult.svg : `<!-- SVG saved to ${svgResult.filePath || "file"} — ${svgResult.stats.bytes} bytes -->`,
        "```",
        ...(output !== "inline" && svgResult.filePath ? ["", `SVG saved: \`${svgResult.filePath}\`${svgResult.downloadUrl ? ` — download: ${svgResult.downloadUrl}` : ""}`] : []),
        "",
        `- Page: ${svgResult.title} (${svgResult.url})${hasTargetId ? ` [target ${targetId}]` : ""}`,
        `- Canvas: ${svgResult.stats.width}×${svgResult.stats.height} ${svgResult.stats.fullPage ? "(full page)" : "(viewport)"} · mode: render (filled rects, rx for rounded)`,
        `- Elements: ${svgResult.stats.elementCount} found, ${svgResult.stats.filteredCount} in SVG`,
        `- Bytes: ${svgResult.stats.bytes}`,
        ...(svgResult.filePath ? [`- File: \`${svgResult.filePath}\``] : []),
        ...(svgResult.downloadUrl ? [`- Download: ${svgResult.downloadUrl}`] : [])
      ];
      timer.step("format_response", mark);
      timer.end({ status: "ok" });
      return asMarkdownContent(lines.join("\n"));
    }

    // Non-targetId path — ephemeral pages, batch support
    if (Object.prototype.hasOwnProperty.call(args, "url") || Object.prototype.hasOwnProperty.call(args, "ref_id")) {
      throw new Error('Invalid input: web_page_svg no longer accepts singular "url" / "ref_id" — use "urls" / "ref_ids"');
    }
    const targetUrls = (() => {
      try {
        return resolveOpenTarget(args);
      } catch (error) {
        timer.step("resolve_targets_failed", mark);
        timer.end({ status: "error", error: String(error?.message || error) });
        throw error;
      }
    })();
    mark = timer.step("resolve_targets", mark);

    const svgBatch = await mapWithConcurrency(targetUrls, managerSvg.config.openPageMaxParallel, async (targetUrl) => {
      return managerSvg.withPageSlot(async () => {
        const { page, browser: svgBrowser, rollbackNotes: svgRollbackNotes } = await resolveBrowserParam({ browser: args.browser || "" }, managerSvg.config, managerSvg);
        try {
          if (viewportOverride) await page.setViewport(viewportOverride);
          await page.goto(targetUrl, { waitUntil: managerSvg.config.navWaitUntil, timeout: managerSvg.config.browserOpTimeoutMs });
          await page.waitForFunction(() => document.readyState === "complete" || document.readyState === "interactive", { timeout: 10000 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 900));
          const cap = await capturePageAsSvg(page, { elementLimit, fullPage, includeSelector, includeXpath, hybrid });
          const result = { svg: cap.svg, title: cap.data.title, url: cap.data.url, browser: svgBrowser, ...(svgRollbackNotes?.length ? { browserNote: `Browser rollback: ${svgRollbackNotes.join(", ")}` } : {}), stats: { width: cap.clipW, height: cap.clipH, viewportWidth: cap.data.viewportWidth, viewportHeight: cap.data.viewportHeight, pageWidth: cap.data.pageWidth, pageHeight: cap.data.pageHeight, elementCount: cap.data.elements.length, filteredCount: cap.filtered.length, bytes: cap.built.stats.bytes, fullPage }, filteredCount: cap.filtered.length, elementCount: cap.data.elements.length, bytes: cap.built.stats.bytes, _capData: cap.data };
          result.url = targetUrl;
          // file/url output per entry
          if (output === "file" || output === "url") {
            const stored = await storeSvgDownload(result.svg, managerSvg.config, { enableDownload: output === "url" });
            if (stored) {
              result.filePath = stored.filePath;
              result.bytes = stored.bytes;
              if (stored.downloadUrl) {
                result.downloadUrl = stored.downloadUrl;
                result.downloadId = stored.downloadId;
              }
              if (output !== "inline") {
                // trim inline svg for batch file mode to keep response small
                result.svgPreview = result.svg.slice(0, 800) + (result.svg.length > 800 ? "\n<!-- truncated, see file -->" : "");
              }
            }
          }
          return { ok: true, ...result, ref_id: rememberLink(targetUrl) };
        } catch (error) {
          console.error(`🟥 web_page_svg batch error for ${targetUrl}: ${String(error?.message || error)}`);
          if (error?.stack) console.error(`🟥 stack: ${String(error.stack).slice(0,2000)}`);
          return { ok: false, url: targetUrl, ref_id: rememberLink(targetUrl), error: String(error?.message || error) };
        } finally {
          if (!page.isClosed()) await page.close().catch(() => {});
        }
      });
    });

    mark = timer.step("capture_svg", mark);

    // Format batch response
    const linesOut = [];
    const successCount = svgBatch.filter((e) => e.ok).length;
    linesOut.push(`Processed ${svgBatch.length} page(s); ${successCount} succeeded.`);
    for (let i = 0; i < svgBatch.length; i++) {
      const entry = svgBatch[i];
      const title = entry.title || entry.url || `Page ${i + 1}`;
      linesOut.push("", `### ${title}`);
      linesOut.push(`- Status: ${entry.ok ? "Success" : "Failed"}`);
      if (entry.url) linesOut.push(`- URL: ${entry.url}`);
      if (entry.browser) linesOut.push(`- Browser: ${entry.browser}${entry.browserNote ? ` — ${entry.browserNote}` : ""}`);
      if (!entry.ok) {
        linesOut.push(`- Error: ${entry.error}`);
        continue;
      }
      linesOut.push(`- Canvas: ${entry.stats.width}×${entry.stats.height} ${entry.stats.fullPage ? "(full page)" : "(viewport)"}`);
      linesOut.push(`- Elements: ${entry.stats.elementCount} found, ${entry.stats.filteredCount} in SVG · ${entry.stats.bytes} bytes`);
      if (entry.filePath) linesOut.push(`- File: \`${entry.filePath}\`${entry.downloadUrl ? ` — download: ${entry.downloadUrl}` : ""}`);
      if (output === "inline") {
        linesOut.push("", "```svg", entry.svg, "```");
      } else {
        linesOut.push("", "```svg", entry.svgPreview || entry.svg.slice(0, 1000), "```");
      }
    }

    timer.step("format_response", mark);
    timer.end({ status: "ok" });
    return asMarkdownContent(linesOut.join("\n"));
  }

  if (name === "list_browsers") {
    const manager = await getBrowserManager();
    const effective = manager._effectiveAddOns();
    const effectiveByName = new Map(effective.map((b) => [b.name, b]));
    // Priority order = BROWSERS array order (same as the console's browser
    // drivers panel), with dynamic relay registrations appended after configured
    // entries — never add-on registration order.
    const ordered = [];
    for (const cfg of manager.config.browsers) {
      if (!cfg.addOn) {
        ordered.push({
          name: cfg.name,
          ownership: browserOwnership("builtin"),
          plugin: cfg.plugin,
          prompt: undefined,
          status: manager.browser?.connected ? "connected" : "disconnected",
          paired: undefined,
          connected: Boolean(manager.browser?.connected)
        });
      } else {
        const eff = effectiveByName.get(cfg.name);
        if (!eff) continue;
        ordered.push({
          name: eff.name,
          ownership: browserOwnership(eff.type),
          plugin: eff.plugin,
          prompt: cfg.prompt,
          status: eff.status,
          paired: eff.paired ?? (eff.type === "navigator-cdp" ? relayServer.isPaired(eff.name) : undefined),
          connected: eff.type === "cdp" ? manager._isAddOnConnected(eff.name) : eff.status === "connected"
        });
      }
    }
    for (const eff of effective) {
      if (!manager.config.browsers.some((c) => c.name === eff.name)) {
        ordered.push({
          name: eff.name,
          ownership: browserOwnership(eff.type),
          plugin: eff.plugin,
          prompt: undefined,
          status: eff.status,
          paired: eff.paired ?? (eff.type === "navigator-cdp" ? relayServer.isPaired(eff.name) : undefined),
          connected: eff.type === "cdp" ? manager._isAddOnConnected(eff.name) : eff.status === "connected"
        });
      }
    }
    // The built-in never takes a configured prompt — emit its position-derived
    // message so the agent sees the actual execution order (no prompt battle
    // against the configured add-ons).
    ordered.forEach((b, index) => {
      if (b.name === "chromium" && !b.prompt) {
        b.prompt = builtinBrowserPrompt(index + 1, ordered.length);
      }
    });
    const tabsByBrowser = new Map(
      (await manager.getInstanceStats()).map((s) => [s.backend, s.tabs])
    );
    const rows = ordered.map((b, index) => {
      const state = b.status === "auth_pending"
        ? "PENDING PIN authorization — unpaired incoming request"
        : b.connected
          ? "connected"
          : b.paired
            ? "offline — paired, awaiting connection"
            : "offline — not connected";
      const detected = b.plugin && b.plugin !== "auto" ? ` (${b.plugin})` : "";
      const rawTabs = tabsByBrowser.get(b.name);
      const tabs = b.connected && typeof rawTabs === "number" ? rawTabs : "—";
      const prompt = b.prompt?.trim() || "(no custom prompt)";
      const promptCell = prompt.replace(/\|/g, "\\|").replace(/\n/g, " ");
      return `| ${index + 1} | **${b.name}** | ${tabs} | ${b.ownership} | ${state}${detected} | ${promptCell} |`;
    });
    timer.end({ status: "ok" });
    return asMarkdownContent(
      `| Execution order | Browser | Tabs | Ownership | Status | Prompt |\n|------------------|---------|------|-----------|--------|--------|\n${rows.join("\n")}` +
      `\n\nBrowsers are preferred in execution-order (lowest first) — each browser is only used when every browser before it is unavailable or rejects the task.`
    );
  }

  if (name === "web_page_links") {
    const multipleRefs = Array.isArray(args.ref_ids) && args.ref_ids.length
      ? args.ref_ids.map((v) => parsePositiveInt(v, "ref_ids"))
      : null;
    const singleRef = args.ref_id !== undefined && multipleRefs === null
      ? parsePositiveInt(args.ref_id, "ref_id")
      : null;
    if (multipleRefs === null && singleRef === null) throw new Error("Provide ref_ids (number[]) to resolve");

    const ids = singleRef !== null ? [singleRef] : multipleRefs;
    const out = [];
    for (const id of ids) {
      const url = getUrlForRefId(id);
      if (url) {
        out.push(`- (${id}): ${url}`);
      } else {
        out.push(`- (${id}): no link registered for this ref_id`);
      }
    }
    timer.step("resolve_links", mark);
    timer.end({ status: "ok" });
    return asMarkdownContent(out.join("\n"));
  }

  if (manager.config.enableDevtoolsMcp && devtoolsToolDefinitions.some((tool) => tool.name === name)) {
    const startedAt = performance.now();
    // Record the browser that was actually used at use time — never a guessed
    // default. Target.getTargets aggregates across all browsers (no single
    // backend; pill hidden in Live activity). Everything else: explicit
    // `browser` arg wins; otherwise the target's real backend captured by
    // withStaleRetry during the call (getLastUsedBackend).
    const resolveDevtoolsBackend = (result) =>
      name === "Target.getTargets"
        ? null
        : args.browser
          ? args.browser
          : getLastUsedBackend(args.targetId) || (result && result.backend) || null;
    // Record the operation as soon as it starts so devtools calls (e.g. a
    // closing a relay tab that never acks) still show up in Live activity
    // while they're still "running" — the result update below then fills in
    // duration/status when the call returns.
    const pageOpId = recordPageOpStart({
      tool: name,
      url: args.url || args.targetId || "",
      backend: resolveDevtoolsBackend(null),
      source: "devtools"
    });
    try {
      const result = await runWithHangGuard(`mcp:${name}`, () => handleDevtoolsToolCall(name, args));
      recordPageOp({
        id: pageOpId,
        tool: name,
        url: args.url || args.targetId || "",
        backend: resolveDevtoolsBackend(result),
        durationMs: performance.now() - startedAt,
        responseChars: JSON.stringify(result).length,
        source: "devtools"
      });
      timer.step("developer_browser_tool", mark);
      timer.end({ status: "ok" });
      return formatDevtoolsToolResponse(name, result);
    } catch (error) {
      recordPageOp({
        id: pageOpId,
        tool: name,
        url: args.url || args.targetId || "",
        durationMs: performance.now() - startedAt,
        ok: false,
        error: String(error?.message || error),
        backend: resolveDevtoolsBackend(undefined),
        source: "devtools"
      });
      throw error;
    }
  }

  timer.step("unknown_tool", mark);
  timer.end({ status: "error", error: `Unknown tool: ${name}` });
  throw new Error(`Unknown tool: ${name}`);
}

async function handleStatelessMcpPost(body, allowedTools = null) {
  const id = body?.id ?? null;
  const method = String(body?.method || "");

  // JSON-RPC notifications (no id) must not receive a response
  if (id === null && !Object.hasOwn(body, "id")) {
    return null;
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "search-tools", version: "1.0.0" }
      }
    };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: getToolsListResponse(allowedTools) };
  }

  if (method === "tools/call") {
    const name = body?.params?.name;
    const args = body?.params?.arguments || {};
    const t0 = Date.now();
    try {
      const result = await handleToolCall(name, args, allowedTools);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      logToolError({ tool: name, args, error, ms: Date.now() - t0, transport: "stateless" });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          ...asMarkdownContent(`Error calling ${name}: ${String(error?.message || error)}`)
        }
      };
    }
  }

  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return null;
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`
    }
  };
}

function createMcpServer(allowedTools = null) {
  const server = new Server(
    {
      name: "search-tools",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const response = getToolsListResponse(allowedTools);
    logEvent("mcp.request", { method: "tools/list" });
    logEvent("mcp.response", { method: "tools/list", result: response });
    return response;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const reqSum = mcpRequestSummary({
      method: "tools/call",
      params: { name, arguments: args }
    });

    console.error(`📡  ${reqSum}`);

    const t0 = Date.now();
    try {
      const response = await handleToolCall(name, args, allowedTools);
      const ms = Date.now() - t0;
      const okText = response?.content?.[0]?.text || "";
      const okLabel = okText.length ? `${Math.round(okText.length / 1000)}k chars` : "";
      console.error(`📨  ${ms}ms${okLabel ? " · " + okLabel : ""}`);
      try {
        const ctx = mcpCallContext.getStore();
        const ip = ctx?.ip || null;
        const keyInfo = ctx?.keyInfo || { id: null, name: null, preview: null };
        const preview = String(okText || JSON.stringify(response || "")).slice(0, 8000);
        recordMcpCall({ tool: name, args, responsePreview: preview, ip, apiKeyId: keyInfo.id, apiKeyName: keyInfo.name, apiKeyPreview: keyInfo.preview, durationMs: ms, ok: true, error: "", source: "mcp" });
      } catch {}
      return response;
    } catch (error) {
      console.error(`❌  tool ${name} failed: ${truncateStr(String(error?.message || error), 200)}`);
      if (error?.stack) console.error(`❌  stack: ${truncateStr(error.stack, 600)}`);
      logToolError({ tool: name, args, error, ms: Date.now() - t0, transport: "mcp" });
      try {
        const ctx = mcpCallContext.getStore();
        const ip = ctx?.ip || null;
        const keyInfo = ctx?.keyInfo || { id: null, name: null, preview: null };
        const preview = String(error?.message || error).slice(0, 8000);
        recordMcpCall({ tool: name, args, responsePreview: preview, ip, apiKeyId: keyInfo.id, apiKeyName: keyInfo.name, apiKeyPreview: keyInfo.preview, durationMs: Date.now() - t0, ok: false, error: String(error?.message || error), source: "mcp" });
      } catch {}
      const errorResponse = {
        isError: true,
        ...asMarkdownContent(`Error calling ${name}: ${String(error?.message || error)}`)
      };
      return errorResponse;
    }
  });

  return server;
}

async function maybeStartHttpServer(managerOverride) {
  const manager = managerOverride || (await getBrowserManager());
  initDb();
  ensureConsoleToolsApiKey();
  syncMcpApiKeys(manager);
  const wantsRelay = (manager.config.browsers || []).some(
    (b) => b.addOn && b.type === "navigator-cdp"
  );
  if (!manager.config.enableHttpHealth && !manager.config.enableHttpMcp && !wantsRelay) return;

  const mcpTransports = new Map();
  const mcpServers = new Map();
  let defaultMcpSessionId = null;

  const SSE_KEEPALIVE_MS = 30_000;
  const SSE_RETRY_INTERVAL_MS = 30_000;

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const url = new URL(req.url || "/", "http://localhost");

        if (manager.config.enableHttpMcp && url.pathname === "/mcp") {
          setCorsHeaders(res);

          if (method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        const sessionId = typeof req.headers["mcp-session-id"] === "string"
          ? req.headers["mcp-session-id"]
          : undefined;
        const resolveTransport = () => {
          if (sessionId) {
            const bySessionId = mcpTransports.get(sessionId);
            if (bySessionId) return bySessionId;
          }

          if (defaultMcpSessionId && mcpTransports.has(defaultMcpSessionId)) {
            return mcpTransports.get(defaultMcpSessionId) || null;
          }

          if (mcpTransports.size >= 1) {
            return mcpTransports.values().next().value || null;
          }

          return null;
        };

        if (method === "POST") {
          const body = await readJsonBody(req);
          const reqSum = mcpRequestSummary(body);

          const isToolCall = body?.method === "tools/call";
          const t0 = Date.now();
          if (reqSum && isToolCall) {
            console.error(`📡  ${reqSum}`);
          }

          const authConfig = {
            ...manager.config,
            mcpApiKeys: [...(manager.config.mcpApiKeys || []), CONSOLE_API_KEY]
          };
          if (!isAuthorizedMcpRequest(req.headers, authConfig)) {
            sendMcpUnauthorized(res);
            return;
          }
          const allowedTools = getAllowedToolsForRequest(req.headers, authConfig);

          if (isInitializeRequest(body)) {
            // If client sends initialize with an existing session ID, the old
            // transport is already initialized and will reject. Clean it up
            // and create a fresh one.
            if (sessionId && mcpTransports.has(sessionId)) {
              const oldTransport = mcpTransports.get(sessionId);
              mcpTransports.delete(sessionId);
              mcpServers.delete(sessionId);
              if (defaultMcpSessionId === sessionId) {
                defaultMcpSessionId = mcpTransports.keys().next().value || null;
              }
              try { await oldTransport.close(); } catch (_) {}
            }

            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                defaultMcpSessionId = sid;
                mcpTransports.set(sid, transport);
              },
              retryInterval: SSE_RETRY_INTERVAL_MS
            });

            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid) {
                mcpTransports.delete(sid);
                mcpServers.delete(sid);
                if (defaultMcpSessionId === sid) {
                  defaultMcpSessionId = mcpTransports.keys().next().value || null;
                }
              }
            };

            const mcpServer = createMcpServer(allowedTools);
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, body);
            if (transport.sessionId) {
              defaultMcpSessionId = transport.sessionId;
              mcpTransports.set(transport.sessionId, transport);
              mcpServers.set(transport.sessionId, mcpServer);
            }
            console.error(`🤝  MCP initialized`);
            return;
          }

          // Route non-initialize requests to the existing session transport.
          // Use exact-match lookup only — never fall back to a different session.
          {
            const existingTransport = sessionId ? (mcpTransports.get(sessionId) || null) : null;
            if (existingTransport) {
              const ip = getClientIp(req);
              const keyInfo = getMcpCallKeyInfo(req.headers);
              await mcpCallContext.run({ ip, keyInfo }, async () => {
                await existingTransport.handleRequest(req, res, body);
              });
              return;
            }
          }

          const response = await handleStatelessMcpPost(body, allowedTools);
          const ms = Date.now() - t0;

          if (response === null) {
            res.writeHead(204);
            res.end();
            return;
          }

          const resSum = mcpResponseSummary(response);
          if (isToolCall && reqSum) {
            console.error(`📨  ${ms}ms${resSum ? " · " + resSum : ""}`);
          }
          if (isToolCall) {
            try {
              const tool = body?.params?.name || "unknown";
              const args = body?.params?.arguments || {};
              const ip = getClientIp(req);
              const keyInfo = getMcpCallKeyInfo(req.headers);
              const rawText = response?.result?.content?.[0]?.text ?? "";
              const preview = String(rawText || JSON.stringify(response?.result || "")).slice(0, 8000);
              const ok = !response?.result?.isError;
              const error = ok ? "" : String(rawText || "error").slice(0, 500);
              recordMcpCall({ tool, args, responsePreview: preview, ip, apiKeyId: keyInfo.id, apiKeyName: keyInfo.name, apiKeyPreview: keyInfo.preview, durationMs: ms, ok, error, source: "mcp" });
            } catch {}
          }
          sendJson(res, 200, response);
          return;
        }

        if (method === "GET" || method === "DELETE") {
          const transport = resolveTransport();
          if (!transport) {
            const message = sessionId
              ? "Bad Request: No valid session ID provided"
              : "Bad Request: Missing initialize request";
            sendJson(res, 400, {
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message
              },
              id: null
            });
            return;
          }

          if (!sessionId && transport.sessionId) {
            req.headers["mcp-session-id"] = transport.sessionId;
          }
          await transport.handleRequest(req, res);
          return;
        }

        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      if ((url.pathname === "/engines/reset" || url.pathname === "/engines/reset/all") && method === "POST") {
        const body = await readJsonBody(req);
        const engine = url.pathname.endsWith("/all") ? "all" : String(body?.engine || "").trim().toLowerCase();
        if (engine !== "all" && !SUPPORTED_ENGINES.includes(engine)) {
          sendJson(res, 400, { ok: false, error: `Unknown search engine: ${engine}` });
          return;
        }
        resetSearchEngine(engine);
        sendJson(res, 200, { ok: true, engine, engineProfiles: getEngineProfiles() });
        return;
      }

      if (method !== "GET" &&
           !(url.pathname === "/" || url.pathname.startsWith("/console/") || url.pathname === "/console" || url.pathname === "/ui" || url.pathname === "/dashboard")) {
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/health") {
        const health = {
          ...(await manager.getHealth()),
          searchRouteCircuitBreakers: getSearchBackendHealth(),
          vnc: {
            running: await isVncRunning(manager.config.novncPort),
            enabled: manager.config.vncEnabled,
            headed: !manager.config.headless,
            novncPort: manager.config.novncPort,
            status: vncManager.status,
            steps: vncManager.steps.slice(),
            lastError: vncManager.lastError
          }
        };
        logEvent("http.request", { method, path: url.pathname });
        logEvent("http.response", { method, path: url.pathname, result: health });
        sendJson(res, 200, health);
        return;
      }

      if (url.pathname === "/debug/detach_all") {
        const result = relayServer.detachAllDebuggers();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (url.pathname === "/cdp") {
        // Plan 55 — authenticated browser discovery for CDP URL sharing.
        // Same key gate as the /cdp/<browser> upgrade (steps 1–3); CDP never
        // honors MCP_ALLOW_UNAUTHENTICATED.
        const auth = authorizeCdpKey(req, url, manager.config);
        if (auth.status) {
          sendJson(res, auth.status, { ok: false, error: auth.error });
          return;
        }
        sendJson(res, 200, await getCdpDiscoveryPayload(manager));
        return;
      }

      if (url.pathname === "/stats") {
        const instances = await manager.getInstanceStats();
        const memory = process.memoryUsage();
        const stats = {
          ok: true,
          uptimeSeconds: Math.floor(process.uptime()),
          memory: {
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal
          },
          sessions: mcpTransports.size,
          cache: {
            total: toolResultCache.web_search.size + toolResultCache.web_fetch.size,
            byTool: {
              web_search: toolResultCache.web_search.size,
              web_fetch: toolResultCache.web_fetch.size
            }
          },
          instances,
          relay: manager.getRelaySummary(),
          counters: {
            ...getActivityCounters(),
            ...getDevtoolsCounters(),
            cacheHits: cacheCounters.hits,
            cacheMisses: cacheCounters.misses
          },
          usage: getUsageTotals(),
          requests: getRequestStats(),
          engineAttempts: getEngineAttemptStats(),
          engineProfiles: getEngineProfiles(),
          postProcessorModels: getPostProcessorModels(manager.config),
          activity: getRecentActivity({ sinceId: 0, limit: 20, includePageOps: true })
        };
        logEvent("http.request", { method, path: url.pathname });
        logEvent("http.response", { method, path: url.pathname, result: stats });
        sendJson(res, 200, stats);
        return;
      }

      if (url.pathname === "/stats/activity") {
        const sinceId = Math.max(0, Number(url.searchParams.get("since")) || 0);
        const sinceOpId = Math.max(0, Number(url.searchParams.get("sinceOps")) || 0);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        const includePageOps = url.searchParams.get("pageOps") === "1";
        sendJson(res, 200, {
          ok: true,
          ...getRecentActivity({ sinceId, sinceOpId, limit, includePageOps })
        });
        return;
      }

      if (url.pathname.startsWith("/stats/activity/")) {
        const raw = decodeURIComponent(url.pathname.slice("/stats/activity/".length));
        // key is s-<id> or p-<id>
        if (/^s-\d+$/.test(raw)) {
          const id = Number(raw.slice(2));
          const detail = getSearchDetail(id);
          if (!detail) {
            sendJson(res, 404, { ok: false, error: "search not found" });
            return;
          }
          const mcpCall = getMcpCallForActivity(raw);
          sendJson(res, 200, { ok: true, kind: "search", entry: detail, mcpCall });
          return;
        }
        if (/^p-\d+$/.test(raw)) {
          const id = Number(raw.slice(2));
          const detail = getPageOpDetail(id);
          if (!detail) {
            sendJson(res, 404, { ok: false, error: "page_op not found" });
            return;
          }
          const mcpCall = getMcpCallForActivity(raw);
          sendJson(res, 200, { ok: true, kind: "page_op", entry: detail, mcpCall });
          return;
        }
        sendJson(res, 400, { ok: false, error: "invalid activity key — use s-<id> or p-<id>" });
        return;
      }

      if (url.pathname === "/stats/activity-trend") {
        const range = String(url.searchParams.get("range") || "hour").toLowerCase();
        const engine = String(url.searchParams.get("engine") || "all").toLowerCase();
        if (engine !== "all" && !SUPPORTED_ENGINES.includes(engine)) {
          sendJson(res, 400, { ok: false, error: `Unknown search engine: ${engine}` });
          return;
        }
        try {
          sendJson(res, 200, { ok: true, ...getActivityTrend({ range, engine }) });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message || error) });
        }
        return;
      }

      if (url.pathname === "/console/relay/forget" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          const name = String(body?.name || "").trim();
          if (!name) {
            sendJson(res, 400, { ok: false, error: "name required" });
            return;
          }
          const ok = relayServer.forget(name);
          sendJson(res, 200, { ok, name, removed: ok });
          return;
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message || error) });
          return;
        }
      }

      if (url.pathname === "/console/api-keys") {
        if (!manager.config.enableWebConsole) {
          sendJson(res, 404, { ok: false, error: "Web console not available" });
          return;
        }
        if (method === "GET") {
          sendJson(res, 200, await getConsoleApiKeysPayload(manager));
          return;
        }
        if (method === "POST") {
          try {
            const result = await handleConsoleApiKeys(manager, await readJsonBody(req));
            sendJson(res, result.ok ? 200 : 400, result);
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message || error) });
          }
          return;
        }
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/console/mcp") {
        if (!manager.config.enableWebConsole || !manager.config.enableHttpMcp) {
          sendJson(res, 404, { ok: false, error: "Web tools not available" });
          return;
        }
        if (method !== "POST") {
          sendJson(res, 405, { ok: false, error: "Method not allowed" });
          return;
        }
        const providedKey = getMcpApiKey(req.headers);
        const validKeys = [...(manager.config.mcpApiKeys || []), CONSOLE_API_KEY];
        if (!providedKey || !validKeys.some((key) => key === providedKey)) {
          sendMcpUnauthorized(res);
          return;
        }
        const body = await readJsonBody(req);
        const t0 = Date.now();
        const isToolCall = body?.method === "tools/call";
        const response = await handleStatelessMcpPost(body);
        if (response === null) {
          res.writeHead(204);
          res.end();
          return;
        }
        if (isToolCall) {
          try {
            const tool = body?.params?.name || "unknown";
            const args = body?.params?.arguments || {};
            const ip = getClientIp(req);
            const keyInfo = getMcpCallKeyInfo(req.headers);
            const rawText = response?.result?.content?.[0]?.text ?? "";
            const preview = String(rawText || JSON.stringify(response?.result || "")).slice(0, 8000);
            const ok = !response?.result?.isError;
            const error = ok ? "" : String(rawText || "error").slice(0, 500);
            recordMcpCall({ tool, args, responsePreview: preview, ip, apiKeyId: keyInfo.id, apiKeyName: keyInfo.name, apiKeyPreview: keyInfo.preview, durationMs: Date.now() - t0, ok, error, source: "mcp" });
          } catch {}
        }
        sendJson(res, 200, response);
        return;
      }

      if (url.pathname === "/console/mcp-client-key") {
        if (!manager.config.enableWebConsole || !manager.config.enableHttpMcp) {
          sendJson(res, 404, { ok: false, error: "Web tools not available" });
          return;
        }
        if (method !== "GET") {
          sendJson(res, 405, { ok: false, error: "Method not allowed" });
          return;
        }
        const record = ensureConsoleToolsApiKey();
        syncMcpApiKeys(manager);
        sendJson(res, 200, { ok: true, name: record.name, preview: maskApiKey(record.secret), key: record.secret });
        return;
      }

      if (url.pathname === "/console/config") {
        if (!manager.config.enableWebConsole) {
          sendJson(res, 404, { ok: false, error: "Web console not available" });
          return;
        }
        if (method === "GET") {
          const envPath = getEnvFilePath();
          await checkEnvFileChanged(envPath);
          const payload = await getConsoleConfigPayload(manager);
          logEvent("http.request", { method, path: url.pathname });
          sendJson(res, 200, payload);
          return;
        }
        if (method === "PUT" || method === "POST") {
          try {
            const body = await readJsonBody(req);
            const result = await applyConfigUpdates(manager, body);
            if (!result.ok) {
              sendJson(res, 400, result);
              return;
            }
            logEvent("http.request", { method, path: url.pathname, updates: body?.updates });
            sendJson(res, 200, result);
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message || error) });
          }
          return;
        }
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/console/vnc") {
        if (!manager.config.enableWebConsole) {
          sendJson(res, 404, { ok: false, error: "Web console not available" });
          return;
        }
        if (method === "POST") {
          try {
            const body = await readJsonBody(req);
            const result = await handleConsoleVnc(manager, body);
            if (!result.ok) {
              sendJson(res, 400, result);
              return;
            }
            logEvent("http.request", { method, path: url.pathname, action: body?.action });
            sendJson(res, 200, result);
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message || error) });
          }
          return;
        }
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/console/logs") {
        if (!manager.config.enableWebConsole) {
          sendJson(res, 404, { ok: false, error: "Web console not available" });
          return;
        }
        const payload = await handleConsoleLogs(manager, url);
        logEvent("http.request", { method, path: url.pathname });
        sendJson(res, 200, payload);
        return;
      }

      if (url.pathname === "/console/api/hints" || url.pathname.startsWith("/console/api/hints/")) {
        if (!manager.config.enableWebConsole) {
          sendJson(res, 404, { ok: false, error: "Web console not available" });
          return;
        }
        const hintsPath = manager.config.domainHintsPath;
        const postProcessorModels = getPostProcessorModels(manager.config);
        const modelIds = postProcessorModels.map((entry) => entry.id);
        try {
          if (method === "GET" && url.pathname === "/console/api/hints") {
            const hints = await loadRawDomainHints(hintsPath);
            ensureWildcardHint(hints);
            logEvent("http.request", { method, path: url.pathname });
            sendJson(res, 200, { ok: true, hintsPath, count: hints.length, hints, postProcessorModels });
            return;
          }
          if (method === "POST" && url.pathname === "/console/api/hints/validate") {
            const body = await readJsonBody(req);
            const scope = body?.scope === "test" ? "test" : "static";
            const validation = validateHintRule(body?.hint, { scope, aiModelIds: modelIds });
            sendJson(res, 200, { ok: true, valid: validation.errors.length === 0, ...validation });
            return;
          }
            const browserNames = [
              "chromium",
              ...manager._effectiveAddOns().map((b) => b.name)
            ];
            if (method === "POST" && url.pathname === "/console/api/hints") {
              const body = await readJsonBody(req);
              const result = await createHint(hintsPath, body?.hint, modelIds, browserNames);
            if (!result.ok) {
              sendJson(res, 400, result);
              return;
            }
            logEvent("http.request", { method, path: url.pathname, hint: result.hint?.domain });
            sendJson(res, 200, result);
            return;
          }
          const updateMatch = url.pathname.match(/^\/console\/api\/hints\/(\d+)$/);
            if (method === "PUT" && updateMatch) {
              const index = Number(updateMatch[1]);
              const body = await readJsonBody(req);
              const result = await updateHint(hintsPath, index, body?.hint, modelIds, browserNames);
            if (!result.ok) {
              sendJson(res, 400, result);
              return;
            }
            logEvent("http.request", { method, path: url.pathname, hint: result.hint?.domain });
            sendJson(res, 200, result);
            return;
          }
          if (method === "DELETE" && updateMatch) {
            const index = Number(updateMatch[1]);
            const result = await deleteHint(hintsPath, index);
            if (!result.ok) {
              sendJson(res, 400, result);
              return;
            }
            logEvent("http.request", { method, path: url.pathname, hint: result.removed?.domain });
            sendJson(res, 200, result);
            return;
          }
          sendJson(res, 405, { ok: false, error: "Method not allowed" });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message || error) });
        }
        return;
      }

      if (url.pathname === "/console/api/tabs") {
        if (!manager.config.enableWebConsole) {
          sendJson(res, 404, { ok: false, error: "Web console not available" });
          return;
        }
        try {
          if (method === "POST") {
            const body = await readJsonBody(req);
            const result = await createTarget({ targetId: body?.targetId, url: body?.url || "about:blank", viewport: body?.viewport });
            sendJson(res, 200, { ok: true, targetId: result.targetId });
            return;
          }
          if (method === "GET") {
            const { listTargets } = await import("./devtools.js");
            const result = await listTargets();
            sendJson(res, 200, { ok: true, targets: result.targets || [] });
            return;
          }
          sendJson(res, 405, { ok: false, error: "Method not allowed" });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message || error) });
        }
        return;
      }

      const tabDeleteMatch = url.pathname.match(/^\/console\/api\/tabs\/(.+)$/);
      if (tabDeleteMatch) {
        if (!manager.config.enableWebConsole) {
          sendJson(res, 404, { ok: false, error: "Web console not available" });
          return;
        }
        try {
          if (method === "DELETE") {
            const targetId = decodeURIComponent(tabDeleteMatch[1]);
            await closeTarget({ targetId });
            sendJson(res, 200, { ok: true });
            return;
          }
          sendJson(res, 405, { ok: false, error: "Method not allowed" });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message || error) });
        }
        return;
      }

      if (url.pathname === "/" || url.pathname === "/console" || url.pathname.startsWith("/console/") || url.pathname === "/ui" || url.pathname === "/dashboard") {
        if (!manager.config.enableWebConsole) {
          sendJson(res, 404, { ok: false, error: "Web console not available" });
          return;
        }
        await serveWebConsoleAsset(res, url.pathname);
        return;
      }

      if (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) {
        await serveDocsAsset(res, url.pathname);
        return;
      }

      if (url.pathname === "/search") {
        const timer = createExecutionTimer("http.timing", {
          mode: "http",
          method,
          path: url.pathname
        });
        let mark = performance.now();
        logEvent("http.request", {
          method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries())
        });
        const query = url.searchParams.get("q") || "";
        const multiQ = url.searchParams
          .getAll("q")
          .map((item) => item.trim())
          .filter(Boolean);
        const queriesParam = (url.searchParams.get("queries") || "")
          .split("||")
          .map((item) => item.trim())
          .filter(Boolean);
        const queries = [...new Set([...multiQ, ...queriesParam])];

        if (!query.trim() && !queries.length) {
          recordActivityRequest("http:/search", false, "Missing q or queries parameter");
          sendJson(res, 400, { ok: false, error: "Missing q or queries parameter" });
          return;
        }

        const limit = parseSearchLimit(url.searchParams.get("limit"), 5);
        const enginesParam = url.searchParams.get("engines");
        const engines = normalizeSearchEngineSelection(
          enginesParam
            ? enginesParam
                .split(",")
                .map((item) => item.trim().toLowerCase())
                .filter(Boolean)
            : [],
          url.searchParams.get("engine")
        );
        mark = timer.step("parse_inputs", mark);

        let payload;
        try {
          payload = decorateSearchPayload(
            await runWithHangGuard("http:/search", () => browserSearch({ query, queries, limit, ...(engines.length ? { engines } : {}) }))
          );
        } catch (error) {
          recordActivityRequest("http:/search", false, error?.message || String(error));
          throw error;
        }
        mark = timer.step("browser_search", mark);
        const markdown = formatSearchMarkdown(payload);
        timer.step("format_response", mark);
        timer.end({ status: "ok" });
        logEvent("http.response", { method, path: url.pathname, result: payload });
        recordActivityRequest("http:/search", true);
        sendMarkdown(res, 200, markdown);
        return;
      }

      if (url.pathname === "/extract") {
        const timer = createExecutionTimer("http.timing", {
          mode: "http",
          method,
          path: url.pathname
        });
        let mark = performance.now();
        logEvent("http.request", {
          method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries())
        });
        let targetUrls;
        try {
          targetUrls = parseHttpExtractTargets(url.searchParams);
        } catch (error) {
          recordActivityRequest("http:/extract", false, error?.message || String(error));
          logEvent("http.error", {
            method,
            path: url.pathname,
            error: String(error?.message || error)
          });
          timer.step("resolve_targets_failed", mark);
          timer.end({ status: "error", error: String(error?.message || error) });
          sendJson(res, 400, { ok: false, error: String(error?.message || error) });
          return;
        }
        mark = timer.step("resolve_targets", mark);

        const maxChars = parseMaxChars(url.searchParams.get("maxChars"), DEFAULT_MAX_CHARS);
        let hintOverride = null;
        const hintParam = url.searchParams.get("hint");
        if (hintParam) {
          let candidate;
          try {
            candidate = JSON.parse(hintParam);
          } catch {
            recordActivityRequest("http:/extract", false, "invalid hint param (bad JSON)");
            sendJson(res, 400, { ok: false, error: "hint param must be URL-encoded JSON" });
            return;
          }
          const validation = validateHintRule(candidate, { scope: "test", aiModelIds: getPostProcessorModels(manager.config).map((entry) => entry.id) });
          if (validation.errors.length) {
            recordActivityRequest("http:/extract", false, "invalid hint param");
            sendJson(res, 400, { ok: false, error: "invalid hint", validation });
            return;
          }
          hintOverride = candidate;
        }
        let payload;
        try {
          const targetIdParam = url.searchParams.get("targetId") || "";
          const cacheHtmlParam = String(url.searchParams.get("cacheHtml") || "");
          const cacheMode = cacheHtmlParam === "1" ? "use" : cacheHtmlParam === "refresh" ? "refresh" : cacheHtmlParam === "0" ? "clear" : null;

          if (targetIdParam) {
            try {
              const { targets } = await listTargets();
              const tab = (targets || []).find((t) => t.targetId === targetIdParam) || null;
              let reuseCachedHtml = false;
              if (tab && tab.url === targetUrls[0]) {
                // Same URL — reuse existing tab and its HTML
                reuseCachedHtml = true;
              } else if (tab) {
                // Different URL — close old, create new at same name
                await closeTarget({ targetId: targetIdParam });
                await createTarget({ targetId: targetIdParam, url: "about:blank" });
                await navigatePage({ targetId: targetIdParam, url: targetUrls[0] });
                // Don't reuse HTML — the page may have client-side JS (redirects, SPA)
                // that hasn't executed yet; let browserOpenAndExtract render it fully.
              } else {
                // Tab missing — create fresh
                await createTarget({ targetId: targetIdParam, url: "about:blank" });
                await navigatePage({ targetId: targetIdParam, url: targetUrls[0] });
              }
              if (reuseCachedHtml) {
                const pageHtml = await withExtractTimeout(getPageContent(targetIdParam), "getPageContent");
                const cachedByUrl = new Map();
                if (pageHtml) cachedByUrl.set(targetUrls[0], pageHtml);
                payload = await runWithHangGuard("http:/extract", () =>
                  openTargetsParallel(targetUrls, manager.config.openPageMaxParallel, false, manager.config.debug, {
                    hintOverride,
                    cachedHtmlByUrl: cachedByUrl,
                    captureHtml: false,
                    enableLinkRefs: manager.config.enableLinkRefs
                  })
                );
              } else {
                payload = await runWithHangGuard("http:/extract", () =>
                  openTargetsParallel(targetUrls, manager.config.openPageMaxParallel, false, manager.config.debug, {
                    hintOverride,
                    enableLinkRefs: manager.config.enableLinkRefs
                  })
                );
              }
            } catch (navErr) {
              const navMsg = String(navErr?.message || navErr);
              if (/closed due to inactivity|Unknown targetId|timed out/i.test(navMsg)) {
                res.setHeader("X-Target-Stale", "1");
                payload = await runWithHangGuard("http:/extract", () =>
                  openTargetsParallel(targetUrls, manager.config.openPageMaxParallel, false, manager.config.debug, {
                    hintOverride,
                    enableLinkRefs: manager.config.enableLinkRefs
                  })
                );
              } else {
                throw navErr;
              }
            }
            res.setHeader("X-Cache", "off");
          } else {
          const cachedByUrl = new Map();
          let shouldCapture = false;
          if (cacheMode === "use" || cacheMode === "refresh") {
            shouldCapture = true;
            if (cacheMode === "use") {
              for (const u of targetUrls) {
                const hit = extractHtmlCache.get(u);
                if (hit) cachedByUrl.set(u, hit);
              }
            }
          } else if (cacheMode === "clear") {
            for (const u of targetUrls) extractHtmlCache.delete(u);
          }
          payload = await runWithHangGuard("http:/extract", () =>
            openTargetsParallel(targetUrls, manager.config.openPageMaxParallel, false, manager.config.debug, {
              hintOverride,
              cachedHtmlByUrl: cachedByUrl,
              captureHtml: shouldCapture,
              enableLinkRefs: manager.config.enableLinkRefs
            })
          );
          if (shouldCapture) {
            const entries = payload.entries ?? payload.results ?? (payload.ok ? [payload] : []);
            for (const entry of entries) {
              if (entry.ok && entry.html && !cachedByUrl.has(entry.url)) {
                if (extractHtmlCache.size >= 32) {
                  const oldest = extractHtmlCache.keys().next().value;
                  extractHtmlCache.delete(oldest);
                }
                extractHtmlCache.set(entry.url, entry.html);
                const requested = targetUrls.find((u) => u === entry.url);
                if (!requested) {
                  targetUrls.forEach((u) => {
                    if (!extractHtmlCache.has(u)) extractHtmlCache.set(u, entry.html);
                  });
                }
              }
            }
          }
          res.setHeader("X-Cache", cacheMode === "use" && cachedByUrl.size > 0 ? "hit" : cacheMode === "use" ? "miss" : cacheMode === "refresh" ? "refresh" : "off");
          }
        } catch (error) {
          recordActivityRequest("http:/extract", false, error?.message || String(error));
          throw error;
        }
        mark = timer.step("open_targets", mark);
        const truncated = truncateResultsText(payload, maxChars);
        const markdown = formatOpenPageResponse(truncated).content[0].text;
        timer.step("format_response", mark);
        timer.end({ status: "ok" });
        logEvent("http.response", { method, path: url.pathname, result: payload });
        recordActivityRequest("http:/extract", true);
        sendMarkdown(res, 200, markdown);
        return;
      }

      if (url.pathname === "/screenshot") {
        const timer = createExecutionTimer("http.timing", {
          mode: "http",
          method,
          path: url.pathname
        });
        let mark = performance.now();
        logEvent("http.request", {
          method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries())
        });
        let targetUrls;
        try {
          targetUrls = parseHttpExtractTargets(url.searchParams);
        } catch (error) {
          recordActivityRequest("http:/screenshot", false, error?.message || String(error));
          logEvent("http.error", {
            method,
            path: url.pathname,
            error: String(error?.message || error)
          });
          timer.step("resolve_targets_failed", mark);
          timer.end({ status: "error", error: String(error?.message || error) });
          sendJson(res, 400, { ok: false, error: String(error?.message || error) });
          return;
        }
        mark = timer.step("resolve_targets", mark);

        const format = "jpeg";
        const fullPage = parseBooleanParam(url.searchParams.get("fullPage"), true);
        const qualityParam = url.searchParams.get("quality");
        let quality = null;
        if (qualityParam) {
          const QUALITY_PRESETS = { low: 30, medium: 55, high: 75 };
          const preset = String(qualityParam).trim().toLowerCase();
          if (preset in QUALITY_PRESETS) {
            quality = QUALITY_PRESETS[preset];
          } else {
            quality = parsePositiveInt(qualityParam, "quality");
            quality = Math.min(100, Math.max(1, quality));
          }
        }
        if (quality === null) quality = 55;
        const options = {
          format,
          fullPage,
          ...(quality ? { quality } : {})
        };
        mark = timer.step("parse_options", mark);

        let payload;
        try {
          const targetIdParam = url.searchParams.get("targetId") || "";
          if (targetIdParam) {
            try {
              // Ensure target is on the right URL before screenshotting
              const { targets } = await listTargets();
              const tab = (targets || []).find((t) => t.targetId === targetIdParam) || null;
              if (targetUrls.length > 0) {
                if (tab && tab.url !== targetUrls[0]) {
                  await closeTarget({ targetId: targetIdParam });
                  await createTarget({ targetId: targetIdParam, url: "about:blank" });
                  await navigatePage({ targetId: targetIdParam, url: targetUrls[0] });
                } else if (!tab) {
                  await createTarget({ targetId: targetIdParam, url: "about:blank" });
                  await navigatePage({ targetId: targetIdParam, url: targetUrls[0] });
                }
              }
              const shot = await withExtractTimeout(captureTargetScreenshot({
                targetId: targetIdParam,
                format,
                fullPage,
                ...(quality ? { quality } : {})
              }), "screenshot");
              payload = {
                index: 0,
                ok: true,
                ...shot
              };
            } catch (targetErr) {
              // Target stale or wedged — fall back to url-based fresh-page screenshot
              console.error(`📸  target screenshot failed, falling back to url-based: ${targetErr?.message}`);
              if (targetUrls.length > 0) {
                res.setHeader("X-Target-Stale", "1");
                payload = await runWithHangGuard("http:/screenshot", () =>
                  captureScreenshotsParallel(targetUrls, manager.config.openPageMaxParallel, options)
                );
              } else {
                throw targetErr;
              }
            }
          } else {
            payload = await runWithHangGuard("http:/screenshot", () =>
              captureScreenshotsParallel(
                targetUrls,
                manager.config.openPageMaxParallel,
                options
              )
            );
          }
        } catch (error) {
          recordActivityRequest("http:/screenshot", false, error?.message || String(error));
          throw error;
        }
        mark = timer.step("capture_screenshots", mark);
        await applyScreenshotStorage(payload, manager.config);
        mark = timer.step("store_screenshots", mark);
        const markdown = formatScreenshotResponse(payload).content[0].text;
        timer.step("format_response", mark);
        timer.end({ status: "ok" });
        logEvent("http.response", { method, path: url.pathname, result: payload });
        recordActivityRequest("http:/screenshot", true);
        sendMarkdown(res, 200, markdown);
        return;
      }

      if (url.pathname.startsWith("/download/")) {
        if (!manager.config.enableScreenshotDownloadLink) {
          sendJson(res, 404, { ok: false, error: "Not found" });
          return;
        }

        const downloadId = decodeURIComponent(url.pathname.split("/").pop() || "").trim();
        await pruneScreenshotDownloads();
        const record = screenshotDownloadById.get(downloadId);
        if (!record) {
          sendJson(res, 404, { ok: false, error: "Unknown download id" });
          return;
        }

        try {
          const data = await fs.readFile(record.path);
          res.writeHead(200, {
            "content-type": record.contentType || "application/octet-stream",
            "content-disposition": `attachment; filename="${record.filename}"`
          });
          res.end(data);
          return;
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
          return;
        }
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      logEvent("http.error", {
        method: req.method || "GET",
        path: req.url || "",
        error: String(error?.message || error)
      });
      sendJson(res, Number(error?.statusCode) || 500, { ok: false, error: String(error?.message || error) });
    }
  });

  server.keepAliveTimeout = 300_000;
  server.headersTimeout = 300_000;
  server.timeout = 0;

  // Mount the navigator-cdp relay (plans 38/40/41): /relay for the extensions,
  // /browser/<name> as the pure-CDP gateway puppeteer dials. Host for the CDP
  // ws URL must be reachable from this process (puppeteer runs in-container).
  {
    let relayHost = manager.config.mcpApiHost || "";
    try { relayHost = new URL(relayHost).hostname || "127.0.0.1"; } catch { relayHost = "127.0.0.1"; }
    relayServer.init({
      server,
      host: relayHost,
      port: manager.config.mcpApiPort
    });
  }

  // Mount the authenticated external CDP surface (plan 55): /cdp/<browser>
  // upgrades (key always required) + GET /cdp discovery (routed above).
  // Mounted after the relay so each upgrade handler owns only its paths —
  // cdp-share ignores non-/cdp, relay ignores /cdp (carve-out).
  initCdpSharing({ server, manager, logToolError });

  const keepaliveEncoder = new TextEncoder();
  const keepaliveFrame = keepaliveEncoder.encode(": keepalive\n\n");

  const keepaliveInterval = setInterval(() => {
    const entries = [...mcpTransports.entries()];
    for (const [, transport] of entries) {
      try {
        const ws = transport._webStandardTransport;
        if (!ws?._streamMapping) continue;
        const streams = [...ws._streamMapping.entries()];
        for (const [key, stream] of streams) {
          try {
            stream.controller?.enqueue(keepaliveFrame);
          } catch {
            ws._streamMapping.delete(key);
          }
        }
      } catch {
        // Do NOT delete from mcpTransports here — _webStandardTransport
        // may be temporarily unavailable during a close sequence but the
        // transport is still valid. The SDK's own onclose handler will
        // clean up when the session is truly dead.
      }
    }
  }, SSE_KEEPALIVE_MS);
  keepaliveInterval.unref();

  server.listen(manager.config.mcpApiPort, "0.0.0.0", () => {
    logEvent("boot.ready", {
      transport: "http",
      host: manager.config.mcpApiHost,
      port: manager.config.mcpApiPort,
      sseKeepaliveMs: SSE_KEEPALIVE_MS,
      sseRetryIntervalMs: SSE_RETRY_INTERVAL_MS
    });
  });
}


logEvent("booting", { pid: process.pid });
const manager = await getBrowserManager();
logEvent("boot.start", { pid: process.pid });
toolCacheTtlMs = manager.config.toolCacheTtlMs || 5 * 60 * 1000;
logBootConfig(manager.config);

const HANG_TIMEOUT_CODE = "HANG_TIMEOUT";
let shutdownInProgress = false;

function createHangTimeoutError(label, timeoutMs) {
  const error = new Error(`Operation '${label}' timed out after ${timeoutMs}ms`);
  error.code = HANG_TIMEOUT_CODE;
  return error;
}

async function shutdownWithExit(exitCode, context = {}) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  if (Object.keys(context).length) {
    logEvent("shutdown", context);
  }

  try {
    await manager.shutdown();
  } catch (error) {
    logEvent("shutdown.error", {
      error: String(error?.message || error)
    });
  }

  process.exit(exitCode);
}

function withExtractTimeout(promise, label) {
  const timeoutMs = (manager.config.browserOpTimeoutMs || 25000);
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

async function runWithHangGuard(label, task) {
  if (!manager.config.enableHangRestart) {
    return task();
  }

  const timeoutMs = manager.config.hangRestartTimeoutMs;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(createHangTimeoutError(label, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(), timeoutPromise]);
  } catch (error) {
    if (error?.code === HANG_TIMEOUT_CODE) {
      await shutdownWithExit(1, {
        reason: "hang_timeout",
        label,
        timeoutMs,
        error: String(error?.message || error)
      });
      return new Promise(() => {});
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

process.on("uncaughtException", async (error) => {
  logEvent("process.uncaught_exception", {
    error: String(error?.stack || error?.message || error)
  });
  if (manager.config.enableHangRestart) {
    await shutdownWithExit(1, { reason: "uncaught_exception" });
  }
});

process.on("unhandledRejection", async (reason) => {
  logEvent("process.unhandled_rejection", {
    error: String(reason?.stack || reason?.message || reason)
  });
  if (manager.config.enableHangRestart) {
    await shutdownWithExit(1, { reason: "unhandled_rejection" });
  }
});

manager.prelaunchIfConfigured().then(
  () => {
    if (manager.config.prelaunchBrowser) {
      logEvent("prelaunch.ready", { enabled: true });
    }
  },
  (error) => {
    logEvent("prelaunch.error", {
      error: String(error?.message || error)
    });
  }
);

await maybeStartHttpServer(manager);

if (manager.config.enableStdioMcp) {
  const stdioServer = createMcpServer();
  const transport = new StdioServerTransport();
  await stdioServer.connect(transport);
  logEvent("boot.ready", { transport: "stdio" });
}

if (!manager.config.enableStdioMcp && !manager.config.enableHttpMcp) {
  throw new Error("No MCP transport enabled. Set ENABLE_STDIO_MCP=1 and/or ENABLE_HTTP_MCP=1");
}

async function shutdown() {
  await shutdownWithExit(0, { reason: "signal" });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
