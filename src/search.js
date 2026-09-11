import { getBrowserManager, resolveBrowserParam } from "./browser.js";
import { DEFAULT_MAX_CHARS, DEFAULT_SEARCH_ENABLED_ENGINES } from "./config.js";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { performance } from "node:perf_hooks";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  recordDbEngineAttempt,
  recordEngineAttemptEnd,
  recordEngineAttemptStart,
  recordPageOp,
  recordPageOpStart,
  recordSearchEnd,
  recordSearchStart,
  searchContext
} from "./activity.js";
import { findMatchingHints, getDomainHints, getWildcardHint, FLOW_TOTAL_TIMEOUT_MAX } from "./domain-hints.js";
import { htmlToMarkdown } from "./markdown.js";
import { getEngineDriver, getEngineMetadata, SUPPORTED_ENGINES } from "./engines/index.js";
import { fetchDuckDuckGoInstantAnswers } from "./engines/instant-answers.js";
import { EngineScheduler } from "./engine-scheduler.js";
import { incrementUsageTotal } from "./db.js";
import { runPostProcessor } from "./post-processor.js";
import { extractTextFromHtml } from "./extractors/index.js";
import { parseHtmlToDom } from "./extractors/helpers.js";
import { extract as trafilaturaExtract } from "./extractors/trafilatura.js";
import { WebFetchOperation } from "./web-fetch-operation.js";
import {
  safeTruncateText,
  extractTablesFromDocument,
  renderTableAsMarkdown,
  renderTablesAsJson,
  renderTablesAsCsv,
  SEMANTIC_CONTENT_SELECTORS
} from "./extractors/helpers.js";
import {
  buildLlmText,
  cleanWhitespace,
  dedupeDirectAnswers,
  normalizeQueryText,
  normalizeUrl,
  readableErrorMessage
} from "./engines/util.js";

const DEFAULT_CONTENT_SELECTORS = [
  "main", "article", "[role='main']", ".content", "#content",
  "#__next", "#root", "#app-root", "[data-reactroot]",
  ".article-body", ".post-content", ".entry-content",
  "[itemprop='articleBody']"
];

async function waitForContent(page, { pollInterval = 300, stableMs = 500, minChars = 500, maxWait = 4000, extraSelectors, targetSelector } = {}) {
  const start = Date.now();
  let lastLength = -1;
  let lastStable = start;

  const selectorBase = DEFAULT_CONTENT_SELECTORS.join(",");
  const selectorStr = targetSelector || (extraSelectors?.length
    ? [...extraSelectors, ...DEFAULT_CONTENT_SELECTORS].join(",")
    : selectorBase);

  while (Date.now() - start < maxWait) {
    const len = await page.evaluate((sel) => {
      const c = document.querySelector(sel) || document.body;
      return c ? c.innerText.replace(/\s+/g, " ").trim().length : 0;
    }, selectorStr);

    if (len >= minChars) return;
    if (len === lastLength) {
      if (Date.now() - lastStable >= stableMs) return;
    } else {
      lastLength = len;
      lastStable = Date.now();
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }
}

async function waitForMutations(page, { maxWait = 5000, stableMs = 500 } = {}) {
  try {
    await page.waitForFunction(
      (stableMs) => {
        if (!window.__mutationSettled) {
          window.__mutationSettled = false;
          let timer;
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              window.__mutationSettled = true;
              observer.disconnect();
            }, stableMs);
          });
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
          });
          timer = setTimeout(() => {
            if (!window.__mutationSettled) {
              window.__mutationSettled = true;
              observer.disconnect();
            }
          }, stableMs);
        }
        return window.__mutationSettled;
      },
      { timeout: maxWait },
      stableMs
    );
  } catch {
    // timeout or page closed
  }
}

const engineScheduler = new EngineScheduler({
  engines: SUPPORTED_ENGINES,
  statePath: path.join(process.cwd(), ".cache", "search-engine-profiles.json")
});
const routeCircuitState = new Map();
const ROUTE_CIRCUIT_STATE_PATH = path.join(process.cwd(), ".cache", "search-circuit-breakers.json");

try {
  const saved = JSON.parse(readFileSync(ROUTE_CIRCUIT_STATE_PATH, "utf8"));
  let removedLocalBrowserFailures = false;
  for (const [key, state] of Object.entries(saved || {})) {
    const engine = key.split("/")[0];
    if (isLocalBrowserFailure(state?.lastError)) {
      engineScheduler.reset(engine);
      removedLocalBrowserFailures = true;
      continue;
    }
    if (state && Number.isFinite(state.openUntil)) routeCircuitState.set(key, state);
  }
  if (removedLocalBrowserFailures) persistRouteCircuitState();
} catch {
  // No persisted circuit state on the first start.
}

function persistRouteCircuitState() {
  try {
    mkdirSync(path.dirname(ROUTE_CIRCUIT_STATE_PATH), { recursive: true });
    const persisted = Object.fromEntries([...routeCircuitState].map(([key, state]) => {
      const { probeInFlight, ...durableState } = state;
      return [key, durableState];
    }));
    writeFileSync(ROUTE_CIRCUIT_STATE_PATH, JSON.stringify(persisted, null, 2));
  } catch (error) {
    console.error(`⚠️  Could not persist search circuit state: ${String(error?.message || error)}`);
  }
}

const activityCounters = {
  searches: 0,
  searchResults: 0,
  fetches: 0,
  screenshots: 0,
  botBlocks: 0,
  cdpConnections: 0
};

export function getActivityCounters() {
  return { ...activityCounters };
}

/** Plan 55 — count accepted external /cdp sessions (surfaced in /stats counters). */
export function recordCdpConnection() {
  activityCounters.cdpConnections += 1;
}

function routeKey(engine) {
  return engine;
}

export function isLocalBrowserFailure(error) {
  return /missing x server|xvfb|cannot open display|failed to launch.*browser/i.test(String(error?.message || error));
}

function getRouteCircuit(engine, now = Date.now()) {
  const key = routeKey(engine);
  const state = routeCircuitState.get(key);
  if (!state) {
    return { key, state: "closed", open: false, remainingMs: 0 };
  }
  const remainingMs = Math.max(0, state.openUntil - now);
  if (remainingMs <= 0) {
    if (state.probeInFlight) {
      return { key, state: "half_open", open: true, remainingMs: 0, lastError: state.lastError, reason: "recovery probe in progress" };
    }
    return { key, state: "half_open", open: false, remainingMs: 0, lastError: state.lastError };
  }
  return { key, state: "open", open: true, remainingMs, lastError: state.lastError };
}

function claimRouteCircuit(engine, now = Date.now()) {
  const circuit = getRouteCircuit(engine, now);
  if (circuit.open || circuit.state !== "half_open") return circuit;
  const state = routeCircuitState.get(circuit.key);
  state.probeInFlight = true;
  return { ...circuit, probe: true };
}

function recordRouteSuccess(engine) {
  if (routeCircuitState.delete(routeKey(engine))) persistRouteCircuitState();
}

function recordRouteFailure(engine, error, cooldownMs) {
  const key = routeKey(engine);
  const previous = routeCircuitState.get(key);
  routeCircuitState.set(key, {
    openUntil: Date.now() + cooldownMs,
    failures: (previous?.failures || 0) + 1,
    lastError: readableErrorMessage(error) || "Unknown route failure",
    lastFailureAt: new Date().toISOString()
  });
  persistRouteCircuitState();

  const message = readableErrorMessage(error);
  if (/captcha|blocked by|bot|unusual traffic/i.test(message)) {
    activityCounters.botBlocks += 1;
  }
}

export function getSearchBackendHealth() {
  const now = Date.now();
  return [...routeCircuitState.entries()].map(([key, state]) => {
    const remainingMs = Math.max(0, state.openUntil - now);
    return {
      route: key,
      state: remainingMs > 0 ? "open" : "half_open",
      remainingMs,
      failures: state.failures || 0,
      lastError: state.lastError || "",
      lastFailureAt: state.lastFailureAt || "",
      probeInFlight: Boolean(state.probeInFlight)
    };
  });
}

const INSTANT_ANSWER_AWAIT_CAP_MS = 1500;
const ENGINE_ATTEMPT_LOG_MAX = 20000;
const ENGINE_ATTEMPT_STATE_PATH = path.join(process.cwd(), ".cache", "search-engine-attempts.json");
const ENGINE_ATTEMPT_PERIODS = [
  { key: "5m", ms: 5 * 60 * 1000 },
  { key: "15m", ms: 15 * 60 * 1000 },
  { key: "1h", ms: 60 * 60 * 1000 },
  { key: "24h", ms: 24 * 60 * 60 * 1000 },
  { key: "all", ms: Infinity }
];
const engineAttemptLog = [];
try {
  const saved = JSON.parse(readFileSync(ENGINE_ATTEMPT_STATE_PATH, "utf8"));
  if (Array.isArray(saved)) engineAttemptLog.push(...saved.filter((entry) => entry && typeof entry.engine === "string" && typeof entry.status === "string").slice(-ENGINE_ATTEMPT_LOG_MAX));
} catch {
  // No persisted engine telemetry on the first start.
}

function persistEngineAttemptLog() {
  try {
    mkdirSync(path.dirname(ENGINE_ATTEMPT_STATE_PATH), { recursive: true });
    writeFileSync(ENGINE_ATTEMPT_STATE_PATH, JSON.stringify(engineAttemptLog), "utf8");
  } catch (error) {
    console.error(`⚠️  Could not persist engine telemetry: ${String(error?.message || error)}`);
  }
}

export function recordEngineAttempt(engine, status, errorMsg, resultCount = 0, durationMs = 0) {
  engineAttemptLog.push({ t: Date.now(), engine, status, results: status === "ok" ? Math.max(0, Number(resultCount) || 0) : 0, err: status === "ok" ? "" : readableErrorMessage(errorMsg || status).slice(0, 300) });
  if (engineAttemptLog.length > ENGINE_ATTEMPT_LOG_MAX) {
    engineAttemptLog.splice(0, engineAttemptLog.length - ENGINE_ATTEMPT_LOG_MAX);
  }
  const recordEngineBackend = () => {
    try {
      return getEngineDriver(engine)?.backend || null;
    } catch {
      return getEngineMetadata(engine)?.backend || null;
    }
  };
  persistEngineAttemptLog();
  recordDbEngineAttempt({
    engine,
    backend: recordEngineBackend(),
    status,
    resultCount,
    error: status === "ok" ? "" : readableErrorMessage(errorMsg),
    durationMs
  });
}

function logEngineAttemptForRunning(engine, status, errorMsg, resultCount = 0) {
  engineAttemptLog.push({ t: Date.now(), engine, status, results: status === "ok" ? Math.max(0, Number(resultCount) || 0) : 0, err: status === "ok" ? "" : readableErrorMessage(errorMsg || status).slice(0, 300) });
  if (engineAttemptLog.length > ENGINE_ATTEMPT_LOG_MAX) {
    engineAttemptLog.splice(0, engineAttemptLog.length - ENGINE_ATTEMPT_LOG_MAX);
  }
  persistEngineAttemptLog();
}

export function getEngineAttemptStats() {
  const now = Date.now();
  let total = 0;
  let ok = 0;
  let fail = 0;
  let skip = 0;
  const byEngine = {};

  for (const e of engineAttemptLog) {
    total += 1;
    if (e.status === "ok") ok += 1;
    else if (e.status === "skip") skip += 1;
    else fail += 1;

    const bucket = (byEngine[e.engine] ||= { total: 0, ok: 0, fail: 0, skip: 0, results: 0, byPeriod: {} });
    bucket.total += 1;
    bucket.results += e.results || 0;
    if (e.status === "ok") bucket.ok += 1;
    else if (e.status === "skip") bucket.skip += 1;
    else bucket.fail += 1;

    const age = now - e.t;
    for (const p of ENGINE_ATTEMPT_PERIODS) {
      if (age <= p.ms) {
        const window = (bucket.byPeriod[p.key] ||= { total: 0, ok: 0, fail: 0, skip: 0, results: 0 });
        window.total += 1;
        window.results += e.results || 0;
        if (e.status === "ok") window.ok += 1;
        else if (e.status === "skip") window.skip += 1;
        else window.fail += 1;
      }
    }
  }

  const recentFailures = [];
  for (let i = engineAttemptLog.length - 1; i >= 0 && recentFailures.length < 8; i -= 1) {
    const e = engineAttemptLog[i];
    if (e.status === "fail") {
      recentFailures.push({ minutesAgo: Math.round((now - e.t) / 60000), engine: e.engine, error: e.err });
    }
  }

  return { total, ok, fail, skip, byEngine, recentFailures };
}

export function getEngineProfiles() {
  return engineScheduler.getProfiles();
}

export function resetSearchEngine(engine) {
  if (engine === "all") {
    engineScheduler.resetAll();
    routeCircuitState.clear();
    persistRouteCircuitState();
    return true;
  }
  if (!engineScheduler.reset(engine)) return false;
  routeCircuitState.delete(routeKey(engine));
  persistRouteCircuitState();
  return true;
}

function normalizeEngines(engines, fallback) {
  const input = Array.isArray(engines) ? engines : [engines].filter(Boolean);
  const requested = input.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  if (requested.includes("select_best")) {
    return fallback;
  }
  const normalized = input
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => SUPPORTED_ENGINES.includes(item));
  if (requested.length && !normalized.length) {
    throw new Error(
      `No valid engines requested. Supported engines: ${SUPPORTED_ENGINES.join(", ")}`
    );
  }
  return normalized.length ? [...new Set(normalized)] : fallback;
}

const SEO_MAIN_NODE_SELECTORS = [
  ...new Set([
    ...SEMANTIC_CONTENT_SELECTORS,
    "body",
    "div[role='main']",
    ".article",
    ".article-body",
    ".post",
    ".post-content",
    "[data-component*='content']",
    "[data-testid*='content']",
    "[data-main-content]",
    "[data-testid*='article']",
    "[data-module*='article']"
  ])
];

const DEFAULT_HEADING_SELECTORS = ["h1", "h2", "h3", "h4"];
const MAX_SEO_CANDIDATES = 5;
const MAX_MAIN_TEXT_CHARS = 24000;
const MAX_MAIN_HTML_CHARS = 60000;

function normalizeParagraphText(input) {
  const segments = String(input || "")
    .replace(/\r/g, "")
    .split(/\n/);
  const output = [];

  for (const raw of segments) {
    const line = raw.trim();
    if (!line) {
      if (output.length && output[output.length - 1] !== "") {
        output.push("");
      }
      continue;
    }
    output.push(line);
  }

  while (output.length && output[output.length - 1] === "") {
    output.pop();
  }

  return output.join("\n");
}

function truncateParagraphText(input, maxChars) {
  return safeTruncateText(normalizeParagraphText(input), maxChars);
}

function sanitizeHtmlSnippet(input, maxChars = MAX_MAIN_HTML_CHARS) {
  const html = String(input || "");
  if (!html) return "";
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return safeTruncateText(stripped, maxChars);
}

function renderHintFields(element, fields, baseUrl) {
  const output = [];
  for (const field of fields) {
    const nodes = Array.from(element.querySelectorAll(field.selector));
    if (!nodes.length) continue;

    const values = nodes.map((node) => {
      if (field.format === "text" || field.format === "list") {
        return cleanWhitespace(node.textContent || "");
      }
      if (field.format === "html") {
        return `\`\`\`html\n${node.innerHTML || ""}\n\`\`\``;
      }
      if (field.format === "readability_to_markdown") {
        try {
          const miniDoc = new JSDOM(`<body>${node.innerHTML || ""}</body>`, { url: baseUrl }).window.document;
          const reader = new Readability(miniDoc);
          const article = reader.parse();
          if (article?.content) return htmlToMarkdown(article.content, { baseUrl }).trim();
        } catch {
          // fall through to html_to_markdown below
        }
      }
      return htmlToMarkdown(node.innerHTML || "", { baseUrl }).trim();
    }).filter(Boolean);
    if (!values.length) continue;

    const label = (field.label || "").trim();
    if (field.format === "list") {
      if (label) output.push(`**${label}:**`);
      output.push(...values.map((value) => `- ${value}`));
      continue;
    }

    if (field.format === "text") {
      output.push(label ? `**${label}:** ${values.join(" ")}` : values.join(" "));
      continue;
    }

    if (label) output.push(`**${label}:**`);
    output.push(values.join("\n\n"));
  }
  return output.join("\n\n");
}

function renderTableAsText(element) {
  const rows = [];
  for (const tr of element.querySelectorAll("tr")) {
    const cells = Array.from(tr.querySelectorAll("th, td"))
      .map((cell) => cleanWhitespace(cell.textContent || ""))
      .filter(Boolean);
    if (cells.length) rows.push(cells.join(" "));
  }
  return rows.join("\n");
}

async function renderLeafContent(element, format, url) {
  if (format === "text") {
    return element.matches?.("table") ? renderTableAsText(element) : cleanWhitespace(element.textContent || "");
  }
  const innerHtml = element.innerHTML || "";
  if (format === "html") return `\`\`\`html\n${innerHtml}\n\`\`\``;
  if (format === "markdown" || format === "html_to_markdown") return htmlToMarkdown(innerHtml, { baseUrl: url }).trim();
  if (format === "readability_to_markdown") {
    try {
      const miniDoc = new JSDOM(`<body>${innerHtml}</body>`, { url }).window.document;
      const reader = new Readability(miniDoc);
      const article = reader.parse();
      if (article?.content) return htmlToMarkdown(article.content, { baseUrl: url }).trim();
    } catch {
      // fall through to raw html_to_markdown below
    }
    return htmlToMarkdown(innerHtml, { baseUrl: url }).trim();
  }
  if (format === "trafilatura_to_markdown") {
    try {
      const miniDoc = new JSDOM(`<body>${innerHtml}</body>`, { url }).window.document;
      const result = await trafilaturaExtract(miniDoc, {
        url,
        maxChars: Number.MAX_SAFE_INTEGER,
        fallbackTitle: ""
      });
      if (result?.text?.trim()) return result.text.trim();
    } catch {
      // trafilatura on a fragment may fail — fall through below
    }
    return htmlToMarkdown(innerHtml, { baseUrl: url }).trim();
  }
  return "";
}

export async function renderContentBlocks(doc, hint, {
  url,
  maxChars,
  debug,
  fallbackTitle = "",
  config,
  signal,
  screenshot
}) {
  const blocks = hint?.content?.blocks?.length ? hint.content.blocks : null;
  const sections = blocks ? null : (hint?.content?.sections?.length ? hint.content.sections : null);
  const content = blocks || sections;
  if (!content) return null;

  const output = [];
  const zeroMatch = [];
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...content].sort((a, b) => (order[a.priority] || 1) - (order[b.priority] || 1));

  for (const block of sorted) {
    const elements = doc.querySelectorAll(block.selector);
    if (debug) console.log(">>> content selector:", block.selector, "matched:", elements.length);
    if (!elements.length) {
      zeroMatch.push(block.selector);
      continue;
    }
    let markdown = "";
    let blockHadTable = false;

    if (block.fields?.length) {
      markdown = Array.from(elements).map((el, index) => {
        const fieldText = renderHintFields(el, block.fields, url);
        if (!fieldText) return "";
        return block.itemLabel ? `#### ${block.itemLabel} ${index + 1}\n\n${fieldText}` : fieldText;
      }).filter(Boolean).join("\n\n");
    } else if (block.format === "table") {
      const tables = [];
      for (const el of elements) {
        const elTables = extractTablesFromDocument(doc, { container: el });
        if (elTables.length) {
          tables.push(...elTables.map(({ node, ...rest }) => rest));
          blockHadTable = true;
        }
      }
      if (tables.length) {
        markdown = tables.map(renderTableAsMarkdown).join("\n\n");
      }
    } else if (block.format === "list") {
      markdown = Array.from(elements).map((el) => {
        const value = cleanWhitespace(el.textContent || "");
        return value ? `- ${value}` : "";
      }).filter(Boolean).join("\n");
    } else if (block.format === "screenshot") {
      markdown = screenshot || "";
    } else if (block.format === "table_json" || block.format === "table_csv") {
      const tables = [];
      for (const el of elements) {
        const elTables = extractTablesFromDocument(doc, { container: el });
        if (elTables.length) {
          tables.push(...elTables.map(({ node, ...rest }) => rest));
          blockHadTable = true;
        }
      }
      if (tables.length) {
        markdown = block.format === "table_json" ? renderTablesAsJson(tables) : renderTablesAsCsv(tables);
      }
    } else {
      for (const el of elements) {
        if (el.matches?.("table")) {
          const rendered = await renderLeafContent(el, block.format, url);
          if (rendered) markdown += rendered + "\n";
          continue;
        }
        const rendered = await renderLeafContent(el, block.format, url);
        if (rendered) markdown += rendered + "\n";
      }
    }

    markdown = markdown.trim();

    // Post-processor: block-level override > hint default
    const blockPostProcessor = block.postProcessor ?? hint?.default?.postProcessor;
    if (blockPostProcessor && markdown) {
      try {
        const input = block.format === "screenshot" ? { screenshot: markdown } : { text: markdown };
        const ppResult = await runPostProcessor({ ...input, model: blockPostProcessor, config, signal });
        if (ppResult) markdown = ppResult;
      } catch (err) {
        if (signal?.aborted) throw signal.reason || err;
        console.warn(`[web_fetch] post-processor "${blockPostProcessor}" failed for block — keeping original: ${err.message}`);
      }
    }

    if (!markdown && !blockHadTable) continue;
    if (block.priority === "medium" && markdown.length < 50 && !blockHadTable) continue;
    const blockLabel = (block.label || "").trim();
    if (blockLabel) output.push(`### ${blockLabel}`);
    output.push("");
    output.push(markdown);
    output.push("");
  }

  if (!output.length) return null;
  const text = output.join("\n");
  if (debug) console.log(`[web_fetch] [${url}] content_path: blocks: ${output.length}`);
  return {
    title: cleanWhitespace(doc.title || fallbackTitle || ""),
    url,
    text: safeTruncateText(text, maxChars),
    textOriginalLength: text.length,
    ...(zeroMatch.length ? { warnings: zeroMatch.map((selector) => `section selector "${selector}" matched 0 elements`) } : {})
  };
}

async function captureSeoSnapshot(
  page,
  {
    textLimit = MAX_MAIN_TEXT_CHARS,
    htmlLimit = MAX_MAIN_HTML_CHARS,
    maxCandidates = MAX_SEO_CANDIDATES,
    extraSelectors
  } = {}
) {
  try {
    const selectors = extraSelectors?.length
      ? [...new Set([...extraSelectors, ...SEO_MAIN_NODE_SELECTORS])]
      : [...new Set(SEO_MAIN_NODE_SELECTORS)];
    const headingSelectors = [...new Set(DEFAULT_HEADING_SELECTORS)];
    if (!selectors.length) return null;

    return await page.evaluate(
      ({ selectors: rawSelectors, headingSelectors: rawHeadingSelectors, textLimit, htmlLimit, maxCandidates }) => {
        const selectorString = rawSelectors.join(",");
        const headingSelectorString = rawHeadingSelectors.length
          ? rawHeadingSelectors.join(",")
          : "h1,h2,h3";
        const documentHeight =
          document.body?.scrollHeight || document.documentElement?.scrollHeight || window.innerHeight || 0;

        const clamp = (value, limit) => {
          if (!value) return "";
          if (!Number.isFinite(limit) || limit <= 0) return String(value);
          const text = String(value);
          if (text.length <= limit) return text;
          if (limit <= 3) {
            return text.slice(0, limit);
          }
          return `${text.slice(0, limit - 3)}...`;
        };

        const normalizeText = (value) => {
          const segments = String(value || "")
            .replace(/\r/g, "")
            .split(/\n/);
          const output = [];
          for (const raw of segments) {
            const line = raw.trim();
            if (!line) {
              if (output.length && output[output.length - 1] !== "") {
                output.push("");
              }
              continue;
            }
            output.push(line);
          }
          while (output.length && output[output.length - 1] === "") {
            output.pop();
          }
          return output.join("\n");
        };

        const isProbablyVisible = (el) => {
          if (!el || typeof el.getBoundingClientRect !== "function") return false;
          const style = window.getComputedStyle(el);
          if (!style) return false;
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (Number(style.opacity) === 0) return false;
          const rect = el.getBoundingClientRect();
          if (!rect) return false;
          if (rect.width < 2 || rect.height < 2) return false;
          if (rect.bottom <= 0 || rect.right <= 0) return false;
          return true;
        };

        const pathFor = (node) => {
          const segments = [];
          let current = node;
          while (current && current !== document.body && segments.length < 8) {
            let segment = current.tagName ? current.tagName.toLowerCase() : "node";
            if (current.id) {
              segment += "#" + current.id;
            } else if (current.classList && current.classList.length) {
              const classParts = Array.from(current.classList)
                .slice(0, 2)
                .map((cls) => cls.replace(/\s+/g, "-"));
              if (classParts.length) {
                segment += "." + classParts.join(".");
              }
            }

            const parent = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
              if (siblings.length > 1) {
                const index = siblings.indexOf(current);
                if (index >= 0) {
                  segment += `:nth-of-type(${index + 1})`;
                }
              }
            }

            segments.unshift(segment);
            current = current.parentElement;
          }
          return segments.join(" > ");
        };

          const shouldSkipNode = (pathLower, roleAttr = "") => {
            if (!pathLower) return false;
            if (roleAttr && /(navigation|banner|contentinfo|complementary)/.test(roleAttr)) return true;
            if (/(footer|nav|subscribe|cookie|legal|banner|header|signin|login)/.test(pathLower)) return true;
            return false;
          };

          const isLikelyNavText = (text) => {
            const lower = text.toLowerCase();
            const navSignals = ["sign in", "subscribe", "log in", "register", "menu", "cookie", "privacy policy", "terms of service", "follow us", "newsletter", "ad choices"];
            let hits = 0;
            for (const signal of navSignals) {
              if (lower.includes(signal)) hits++;
            }
            return hits;
          };

          const getTagBoost = (el) => {
            const tag = (el.tagName || "").toLowerCase();
            if (tag === "article") return 1500;
            if (tag === "main") return 800;
            if (tag === "section") return 400;
            return 0;
          };

        const computeDepth = (node) => {
          let depth = 0;
          let current = node;
          while (current && current !== document.body && depth < 60) {
            depth += 1;
            current = current.parentElement;
          }
          return depth;
        };

        const headingNodes = Array.from(document.querySelectorAll(headingSelectorString))
          .map((node) => {
            const text = normalizeText(node.innerText || "");
            if (!text) return null;
            return {
              level: Number(node.tagName?.slice(1)) || null,
              text: clamp(text, 400),
              path: pathFor(node)
            };
          })
          .filter(Boolean)
          .slice(0, 50);

        document.querySelectorAll("select, option").forEach((node) => node.remove());

        const elements = selectorString ? Array.from(document.querySelectorAll(selectorString)) : [];
        const seen = new Set();
        const candidates = [];

        for (const el of elements) {
          if (!el || seen.has(el)) continue;
          seen.add(el);
          if (!isProbablyVisible(el)) continue;
          const text = normalizeText(el.innerText || "");
          if (text.length < 120) continue;
          const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
          const depth = computeDepth(el);
          const anchorTextLength = Array.from(el.querySelectorAll("a")).reduce((total, anchor) => {
            const anchorText = normalizeText(anchor.innerText || "");
            return total + anchorText.length;
          }, 0);
          const linkDensity = text.length ? anchorTextLength / text.length : 0;
          const headingWeight = el.querySelectorAll(headingSelectorString).length;
          const sizeScore = rect ? Math.min(2000, Math.max(0, (rect.width || 0) * (rect.height || 0) * 0.01)) : 0;
          const path = pathFor(el);
          const roleAttr = (el.getAttribute?.("role") || "").toLowerCase();
          const pathLower = path.toLowerCase();
          if (shouldSkipNode(pathLower, roleAttr)) continue;
          const rectTop = rect ? Math.max(0, rect.top || 0) : 0;
          const normalizedTop = documentHeight ? rectTop / documentHeight : 0;
          const viewportPenalty = rectTop > 4000 ? (rectTop - 4000) * 0.4 : 0;
          const bottomEdge = rectTop + (rect?.height || 0);
          const normalizedBottom = documentHeight ? bottomEdge / documentHeight : normalizedTop;
          const bottomPenalty = normalizedBottom > 0.9 ? (normalizedBottom - 0.9) * 1500 : 0;
          const tagBoost = getTagBoost(el);
          const navPenalty = isLikelyNavText(text) * 300;

          const score =
            text.length +
            headingWeight * 250 -
            linkDensity * 400 +
            Math.max(0, 300 - depth * 20) +
            sizeScore +
            tagBoost -
            navPenalty -
            viewportPenalty -
            bottomPenalty;

          candidates.push({
            tag: el.tagName ? el.tagName.toLowerCase() : "element",
            path,
            text: clamp(text, textLimit),
            html: clamp(el.innerHTML || "", htmlLimit),
            score: Math.round(score),
            depth,
            linkDensity,
            headingCount: headingWeight
          });
        }

        if (!candidates.length) {
          const fallbackText = normalizeText(document.body?.innerText || "");
          if (fallbackText.length) {
            candidates.push({
              tag: "body",
              path: "body",
              text: clamp(fallbackText, textLimit),
              html: clamp(document.body?.innerHTML || "", htmlLimit),
              score: Math.min(500, fallbackText.length),
              depth: 0,
              linkDensity: 0,
              headingCount: 0
            });
          }
        }

        candidates.sort((a, b) => b.score - a.score);

        const canonical =
          document.querySelector("link[rel='canonical']")?.href ||
          document.querySelector("link[rel='alternate'][hreflang='x-default']")?.href ||
          "";
        const metaDescription =
          document.querySelector("meta[name='description']")?.content ||
          document.querySelector("meta[property='og:description']")?.content ||
          "";
        const ogTitle = document.querySelector("meta[property='og:title']")?.content || "";

        return {
          title: document.title || ogTitle || "",
          canonicalUrl: canonical,
          metaDescription,
          headings: headingNodes,
          mainCandidates: candidates.slice(0, Math.max(1, Math.min(maxCandidates || 1, candidates.length)))
        };
      },
      {
        selectors,
        headingSelectors,
        textLimit,
        htmlLimit,
        maxCandidates: Math.max(1, maxCandidates || 1)
      }
    );
  } catch {
    return null;
  }
}

function buildSeoAnalysis({ snapshot, extracted, maxChars }) {
  if (!snapshot && !extracted) return null;

  const headings = Array.isArray(snapshot?.headings)
    ? snapshot.headings
        .map((item) => ({
          level: item.level,
          path: item.path,
          text: truncateParagraphText(item.text || "", 400)
        }))
        .filter((item) => Boolean(item.text))
    : [];

  const bestCandidate = snapshot?.mainCandidates?.[0];
  const fallbackText = extracted?.text || bestCandidate?.text || "";
  const mainContentText = truncateParagraphText(bestCandidate?.text || fallbackText, maxChars);
  const mainContentHtml = bestCandidate?.html
    ? sanitizeHtmlSnippet(bestCandidate.html, Math.max(maxChars * 4, MAX_MAIN_HTML_CHARS))
    : "";

  const candidates = Array.isArray(snapshot?.mainCandidates)
    ? snapshot.mainCandidates.map((candidate) => ({
        tag: candidate.tag,
        path: candidate.path,
        score: candidate.score,
        depth: candidate.depth,
        textSnippet: truncateParagraphText(candidate.text || "", Math.min(800, maxChars))
      }))
    : [];

  const normalizedTitle = cleanWhitespace(snapshot?.title || extracted?.title || "");
  const canonicalUrl = cleanWhitespace(snapshot?.canonicalUrl || "");
  const metaDescription = cleanWhitespace(snapshot?.metaDescription || "");

  return {
    title: normalizedTitle,
    canonicalUrl,
    metaDescription,
    headings,
    mainContentText,
    ...(mainContentHtml ? { mainContentHtml } : {}),
    ...(bestCandidate?.path ? { mainContentPath: bestCandidate.path } : {}),
    candidates
  };
}

function dedupeAndMergeResults(results, limitPerEngine) {
  const byEngineCount = new Map();
  const byUrl = new Map();

  for (const result of results) {
    const engineCount = byEngineCount.get(result.engine) || 0;
    if (engineCount >= limitPerEngine) continue;

    const url = normalizeUrl(result.url);
    if (!url) continue;

    byEngineCount.set(result.engine, engineCount + 1);

    const item = {
      title: cleanWhitespace(result.title),
      url,
      snippet: cleanWhitespace(result.snippet)
    };

    if (!byUrl.has(url)) {
      byUrl.set(url, {
        ...item,
        llmText: buildLlmText(item)
      });
      continue;
    }

    const existing = byUrl.get(url);
    if (!existing.snippet && item.snippet) {
      existing.snippet = item.snippet;
      existing.llmText = buildLlmText(existing);
    }
  }

  return [...byUrl.values()].slice(0, Math.max(1, limitPerEngine || 1));
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

async function runSearchEngine({ manager, query, engine, config, limit }) {
  const driver = getEngineDriver(engine, config);
  const meta = getEngineMetadata(engine);

  if (!meta?.isBrowser) {
    const t0 = performance.now();
    const result = await driver.search({ query, limit });
    const t1 = performance.now();
    console.error(`⏱️  ${engine}: http_total=${Math.round(t1 - t0)}ms`);
    return result;
  }

  const t0 = performance.now();
  const page = await manager.acquireSearchWindow(engine);
  const t1 = performance.now();

  try {
    await driver.submit(page, query);
    const t2 = performance.now();

    const result = await driver.extract(page);
    const t3 = performance.now();

    console.error(`⏱️  ${engine}: acquire_window=${Math.round(t1 - t0)}ms → search_submit=${Math.round(t2 - t1)}ms → extract_results=${Math.round(t3 - t2)}ms | total=${Math.round(t3 - t0)}ms`);

    return result;
  } catch (error) {
    // Lightpanda may detach a page when a cross-engine navigation fails.
    // Do not return that page to the shared pool for a later request.
    try {
      await page.close();
    } catch {
      // Ignore a page that has already detached or closed.
    }
    throw error;
  } finally {
    await manager.releaseSearchWindow(engine, page);
  }
}

function routeConcurrencyForEngines(engines, _config) {
  const hasSharedPool = engines.some((engine) => getEngineMetadata(engine)?.pool === "shared");
  if (hasSharedPool) return 1;
  return Math.max(1, engines.length);
}

function isEngineDisabled(engine, config) {
  const id = String(engine).toLowerCase();
  if (id === "exa_api" && !String(config?.exaApiKey || "").trim() && !String(process.env.EXA_API_KEY || "").trim()) {
    return true;
  }
  if (id === "linkup_api" && !String(config?.linkupApiKey || "").trim() && !String(process.env.LINKUP_API_KEY || "").trim()) {
    return true;
  }
  if (id === "tavily_api" && !String(config?.tavilyApiKey || "").trim() && !String(process.env.TAVILY_API_KEY || "").trim()) {
    return true;
  }
  if (id === "firecrawl_api" && !String(config?.firecrawlApiKey || "").trim() && !String(process.env.FIRECRAWL_API_KEY || "").trim()) {
    return true;
  }
  return false;
}

function disabledReason(engine) {
  const id = String(engine).toLowerCase();
  if (id === "exa_api") return "EXA_API_KEY not configured — set EXA_API_KEY to enable exa_api search";
  if (id === "linkup_api") return "LINKUP_API_KEY not configured — set LINKUP_API_KEY to enable linkup_api search";
  if (id === "tavily_api") return "TAVILY_API_KEY not configured — set TAVILY_API_KEY to enable tavily_api search";
  if (id === "firecrawl_api") return "FIRECRAWL_API_KEY not configured — set FIRECRAWL_API_KEY to enable firecrawl_api search";
  return `${engine} is disabled`;
}

async function runSearchRoute({ manager, query, engine, config, explicit, limit }) {
  if (isEngineDisabled(engine, config)) {
    const reason = disabledReason(engine);
    recordEngineAttempt(engine, "skip", reason);
    const error = new Error(reason);
    error.schedulerSkip = true;
    error.schedulerIgnore = true;
    throw error;
  }

  const circuit = claimRouteCircuit(engine);
  const routeStart = performance.now();
  if (circuit.open) {
    const reason = circuit.reason || circuit.lastError || "route open";
    recordEngineAttempt(engine, "skip", reason);
    const error = new Error(`Search route ${circuit.key} is temporarily disabled for ${Math.ceil(circuit.remainingMs / 1000)}s: ${reason}`);
    error.schedulerIgnore = true;
    error.schedulerSkip = true;
    throw error;
  }

  let backend = null;
  try {
    backend = getEngineDriver(engine, config)?.backend || null;
  } catch {
    backend = getEngineMetadata(engine)?.backend || null;
  }
  const attemptId = recordEngineAttemptStart({ engine, backend });
  try {
    const execute = () => manager.withPageSlot(() =>
      runSearchEngine({ manager, query, engine, config, limit })
    );
    let value;
    try {
      value = await execute();
    } catch (error) {
      if (getEngineMetadata(engine)?.pool !== "shared" || !/detached frame|targetalreadyloaded/i.test(String(error?.message || error))) {
        throw error;
      }
      value = await execute();
    }
    recordRouteSuccess(engine);
    const durationMs = performance.now() - routeStart;
    if (value.results?.length) {
      logEngineAttemptForRunning(engine, "ok", "", value.results.length);
      recordEngineAttemptEnd(attemptId, { status: "ok", resultCount: value.results.length, durationMs });
    } else {
      logEngineAttemptForRunning(engine, "fail", "Search engine returned no results", 0);
      recordEngineAttemptEnd(attemptId, { status: "fail", resultCount: 0, error: "Search engine returned no results", durationMs });
      if (!explicit) engineScheduler.recordFailure(engine, "Search engine returned no results");
    }
    return { ...value, durationMs };
  } catch (error) {
    if (error?.schedulerSkip) {
      if (circuit?.probe) routeCircuitState.get(circuit.key).probeInFlight = false;
      logEngineAttemptForRunning(engine, "skip", error, 0);
      recordEngineAttemptEnd(attemptId, { status: "skip", error: readableErrorMessage(error), durationMs: performance.now() - routeStart });
      error.schedulerIgnore = true;
      if (explicit) throw error;
      throw error;
    }
    const localBrowserFailure = isLocalBrowserFailure(error);
    if (!localBrowserFailure) recordRouteFailure(engine, error, config.searchRouteCircuitOpenMs);
    else if (circuit.probe) routeCircuitState.get(circuit.key).probeInFlight = false;
    logEngineAttemptForRunning(engine, localBrowserFailure ? "skip" : "fail", error, 0);
    recordEngineAttemptEnd(attemptId, { status: localBrowserFailure ? "skip" : "fail", error: readableErrorMessage(error), durationMs: performance.now() - routeStart });
    error.schedulerIgnore = localBrowserFailure;
    if (explicit) throw error;
    throw error;
  }
}

async function runExplicitEngineGroup({ manager, query, engines, limit, config }) {
  const settled = await mapWithConcurrency(
    engines,
    routeConcurrencyForEngines(engines, config),
    async (engine) => {
      try {
        const value = await runSearchRoute({ manager, query, engine, config, explicit: true, limit });
        return { status: "fulfilled", value, engine };
      } catch (reason) {
        return { status: "rejected", reason, engine };
      }
    }
  );

  return buildQueryResult({ query, settled, limit, fallbackAttempted: false });
}

async function runFallbackEngineGroups({ manager, query, limit, config }) {
  const errors = [];
  const skipped = [];

  const rawEngines = config.searchEnabledEngines?.length
    ? config.searchEnabledEngines
    : DEFAULT_SEARCH_ENABLED_ENGINES;
  const engines = rawEngines.filter((engine) => !isEngineDisabled(engine, config));
  engineScheduler.configure(config);
  const scheduled = engineScheduler.select(engines, Date.now(), (engine) => !getRouteCircuit(engine).open);
  for (const skippedEngine of scheduled.skipped) {
    recordEngineAttempt(skippedEngine.engine, "skip", skippedEngine.reason);
    engineScheduler.recordSkip(skippedEngine.engine);
    skipped.push({ engine: skippedEngine.engine, route: routeKey(skippedEngine.engine), remainingMs: skippedEngine.remainingMs, error: skippedEngine.reason });
  }

  for (const engine of scheduled.ordered) {
    const circuit = getRouteCircuit(engine);
    if (circuit.open) {
      recordEngineAttempt(engine, "skip", circuit.lastError || "route open");
      engineScheduler.recordSkip(engine);
      skipped.push({ engine, route: circuit.key, remainingMs: circuit.remainingMs, error: circuit.lastError || "route open" });
      continue;
    }

    try {
      // Disabled engines are already filtered from `engines` above, but guard here too
      if (isEngineDisabled(engine, config)) {
        const reason = disabledReason(engine);
        recordEngineAttempt(engine, "skip", reason);
        skipped.push({ engine, route: routeKey(engine), remainingMs: 0, error: reason });
        continue;
      }
      engineScheduler.markSelected(engine);
      const value = await runSearchRoute({ manager, query, engine, config, explicit: false, limit });
      if (!value.results?.length) {
        errors.push({ engine, route: routeKey(engine), error: "Search engine returned no results" });
        continue;
      }
      engineScheduler.recordSuccess(engine, value.results.length, Date.now(), value.durationMs);
      const settled = [{ status: "fulfilled", value, engine }];
      const result = buildQueryResult({ query, settled, limit, fallbackAttempted: true });

      if (skipped.length || errors.length) {
        const parts = [];
        if (skipped.length) {
          parts.push(`skipped: ${skipped.map((s) => `${s.engine}(${s.route})`).join(", ")}`);
        }
        if (errors.length) {
          parts.push(`failed: ${errors.map((e) => `${e.engine}(${e.route})`).join(", ")}`);
        }
        console.error(`🔁  ${query}: ${parts.join("; ")}`);
      }

      return {
        ...result,
        errors,
        fallback: {
          used: true,
          selectedEngine: engine,
          skipped,
          ...(config.searchEnabledEngines?.length ? { configuredEnabledEngines: config.searchEnabledEngines } : {})
        }
      };
    } catch (reason) {
      if (reason.schedulerSkip) {
        skipped.push({ engine, route: routeKey(engine), remainingMs: 0, error: readableErrorMessage(reason) });
        continue;
      }
      if (!reason.schedulerIgnore) engineScheduler.recordFailure(engine, readableErrorMessage(reason));
      errors.push({ engine, route: routeKey(engine), error: readableErrorMessage(reason) });
    }
  }

  const skipParts = [];
  if (skipped.length) {
    skipParts.push(`skipped: ${skipped.map((s) => `${s.engine}(${s.route})`).join(", ")}`);
  }
  if (errors.length) {
    skipParts.push(`failed: ${errors.map((e) => `${e.engine}(${e.route})`).join(", ")}`);
  }
  if (skipParts.length) {
    console.error(`🔁  ${query}: ${skipParts.join("; ")}`);
  }

  return {
    query,
    resultCount: 0,
    results: [],
    directAnswerCount: 0,
    directAnswers: [],
    errors,
    fallback: {
      used: true,
      selectedEngine: null,
      skipped
    }
  };
}

function buildQueryResult({ query, settled, limit, fallbackAttempted }) {
  const allResults = [];
  const allDirectAnswers = [];
  const errors = [];

  for (const entry of settled) {
    if (entry.status === "fulfilled") {
      allResults.push(...(entry.value.results || []));
      allDirectAnswers.push(...(entry.value.directAnswers || []));
    } else {
      errors.push({
        engine: entry.engine,
        route: entry.engine ? routeKey(entry.engine) : undefined,
        error: readableErrorMessage(entry.reason)
      });
    }
  }

  const engineCounts = {};
  for (const r of allResults) {
    engineCounts[r.engine] = (engineCounts[r.engine] || 0) + 1;
  }
  const engineParts = Object.entries(engineCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([e, c]) => `${e}=${c}`);
  if (engineParts.length) {
    console.error(`📊  ${query}: ${engineParts.join(", ")}`);
  }

  const results = dedupeAndMergeResults(allResults, limit);
  const directAnswers = dedupeDirectAnswers(allDirectAnswers);
  return {
    query,
    resultCount: results.length,
    results,
    directAnswerCount: directAnswers.length,
    directAnswers,
    errors,
    ...(fallbackAttempted ? { fallbackAttempted: true } : {})
  };
}

export async function browserSearch({ query, queries, limit = 5, engines }) {
  const manager = await getBrowserManager();
  activityCounters.searches += 1;
  incrementUsageTotal("searches");
  const tSearchStart = performance.now();
  const requestedEngineIds = (Array.isArray(engines) ? engines : [engines])
    .filter((engine) => engine !== undefined && engine !== null)
    .map((engine) => String(engine).trim().toLowerCase());
  const selectBestRequested = requestedEngineIds.includes("select_best");
  const explicitEngines = !selectBestRequested && (Array.isArray(engines)
    ? engines.length > 0
    : engines !== undefined && engines !== null && String(engines).trim() !== "");
  const selectedEngines = explicitEngines ? normalizeEngines(engines, []) : [];

  const queryList = [];
  if (typeof query === "string") {
    const normalizedQuery = normalizeQueryText(query);
    if (normalizedQuery) {
      queryList.push(normalizedQuery);
    }
  }

  if (Array.isArray(queries)) {
    for (const item of queries) {
      if (typeof item === "string") {
        const normalizedQuery = normalizeQueryText(item);
        if (normalizedQuery) {
          queryList.push(normalizedQuery);
        }
      }
    }
  }

  const uniqueQueries = [...new Set(queryList)];
  if (!uniqueQueries.length) {
    throw new Error("Missing query/queries: provide at least one search query");
  }

  const searchId = recordSearchStart({
    query: uniqueQueries[0],
    variants: uniqueQueries,
    requestedEngine: explicitEngines ? String(engines) : "select_best",
    engines: selectedEngines.length ? selectedEngines : undefined
  });

  try {
    const result = await searchContext.run({ searchId }, async () => {
      const perQueryTasks = uniqueQueries.map(async (singleQuery) => {
        const engineTask = explicitEngines
          ? runExplicitEngineGroup({ manager, query: singleQuery, engines: selectedEngines, limit, config: manager.config })
          : runFallbackEngineGroups({ manager, query: singleQuery, limit, config: manager.config });

        const instantAnswerTask = manager.config.enableInstantAnswers !== false
          ? Promise.race([
              fetchDuckDuckGoInstantAnswers(singleQuery, manager.config).catch(() => []),
              new Promise((resolve) => setTimeout(() => resolve([]), INSTANT_ANSWER_AWAIT_CAP_MS))
            ])
          : Promise.resolve([]);

        const [entry, ddgInstantAnswers] = await Promise.all([
          engineTask,
          instantAnswerTask
        ]);

        if (ddgInstantAnswers.length) {
          entry.directAnswers = dedupeDirectAnswers([
            ...ddgInstantAnswers,
            ...(entry.directAnswers || [])
          ]);
          entry.directAnswerCount = entry.directAnswers.length;
        }

        return entry;
      });

      return await Promise.all(perQueryTasks);
    });

    if (result.length === 1) {
      activityCounters.searchResults += result[0].resultCount;
      incrementUsageTotal("resultsServed", result[0].resultCount);
      const preview = (result[0].results || []).map((r) => r.llmText || `${r.title || ""} ${r.url || ""}`.trim()).join("\n\n").slice(0, 8000);
      recordSearchEnd(searchId, {
        ok: true,
        resultCount: result[0].resultCount,
        durationMs: performance.now() - tSearchStart,
        responsePreview: preview
      });
      return {
        query: result[0].query,
        resultCount: result[0].resultCount,
        results: result[0].results,
        directAnswerCount: result[0].directAnswerCount,
        directAnswers: result[0].directAnswers,
        errors: result[0].errors,
        ...(result[0].fallback ? { fallback: result[0].fallback } : {}),
        ...(result[0].fallbackAttempted ? { fallbackAttempted: true } : {})
      };
    }

    const combinedByUrl = new Map();
    const combinedDirectAnswers = [];
    for (const item of result) {
      combinedDirectAnswers.push(
        ...(item.directAnswers || []).map((answer) => ({
          ...answer,
          queryVariant: item.query
        }))
      );

      for (const itemResult of item.results) {
        if (!combinedByUrl.has(itemResult.url)) {
          combinedByUrl.set(itemResult.url, {
            ...itemResult,
            queryVariants: [item.query]
          });
          continue;
        }

        const existing = combinedByUrl.get(itemResult.url);
        if (!existing.queryVariants.includes(item.query)) {
          existing.queryVariants.push(item.query);
        }
      }
    }

    const totalResultCount = [...combinedByUrl.values()].length;
    activityCounters.searchResults += totalResultCount;
    incrementUsageTotal("resultsServed", totalResultCount);
    const previewMulti = [...combinedByUrl.values()].slice(0, 5).map((r) => r.llmText || `${r.title || ""} ${r.url || ""}`.trim()).join("\n\n").slice(0, 8000);
    recordSearchEnd(searchId, {
      ok: true,
      resultCount: totalResultCount,
      durationMs: performance.now() - tSearchStart,
      responsePreview: previewMulti
    });

    return {
      queries: uniqueQueries,
      queryCount: uniqueQueries.length,
      totalResultCount,
      results: [...combinedByUrl.values()].slice(0, Math.max(1, limit || 1)),
      totalDirectAnswerCount: dedupeDirectAnswers(combinedDirectAnswers).length,
      directAnswers: dedupeDirectAnswers(combinedDirectAnswers),
      queryResults: result
    };
  } catch (error) {
    recordSearchEnd(searchId, {
      ok: false,
      error: String(error?.message || error),
      durationMs: performance.now() - tSearchStart
    });
    throw error;
  }
}

function enrichNumericLinkText(a, text, href) {
  if (!/^\d+$/.test(text)) return text;

  const ariaLabel = (a.getAttribute("aria-label") || "").trim();
  if (ariaLabel && !/^\d+$/.test(ariaLabel)) {
    return ariaLabel.length > 60 ? ariaLabel.slice(0, 60).trim() + "..." : ariaLabel;
  }

  const title = (a.getAttribute("title") || "").trim();
  if (title && !/^\d+$/.test(title)) {
    return title.length > 60 ? title.slice(0, 60).trim() + "..." : title;
  }

  const img = a.querySelector("img");
  if (img) {
    const alt = (img.getAttribute("alt") || "").trim();
    if (alt && !/^\d+$/.test(alt)) {
      return alt.length > 60 ? alt.slice(0, 60).trim() + "..." : alt;
    }
  }

  const svg = a.querySelector("svg");
  if (svg) {
    const svgLabel = (svg.getAttribute("aria-label") || "").trim();
    if (svgLabel && !/^\d+$/.test(svgLabel)) {
      return `${text} ${svgLabel}`;
    }
  }

  try {
    const path = new URL(href).pathname;
    const segments = path.split("/").filter(Boolean);
    if (segments.length > 0) {
      const last = decodeURIComponent(segments[segments.length - 1])
        .replace(/[-_]/g, " ")
        .replace(/^\d+\s*/, "")
        .trim();
      if (last && !/^\d+$/.test(last) && last.length < 30) {
        return `${text} ${last}`;
      }
    }
  } catch {}

  return text;
}

function extractLinksFromHtml({ html, url, dom: providedDom }) {
  const cleanHtml = (html || "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const dom = providedDom || new JSDOM(cleanHtml || "<body></body>", { url });
  const ownedDom = !providedDom;
  try {
    const doc = dom.window.document;
    const container = doc.body;

    // Precompute the heading closest above every element with a single
    // document-order walk (O(DOM)), instead of the previous per-anchor
    // ancestor/sibling subtree scans (O(anchors x depth x siblings), which
    // cost seconds on table-heavy pages like the NSE option chain).
    const headings = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    const headingTexts = new Map();
    for (const h of headings) {
      headingTexts.set(h, (h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120));
    }
    const nearestHeadingByElement = new Map();
    let lastHeading = "";
    const stack = [...container.children];
    while (stack.length) {
      const el = stack.pop();
      if (headingTexts.has(el)) lastHeading = headingTexts.get(el);
      nearestHeadingByElement.set(el, lastHeading === "" ? "" : lastHeading);
      for (let i = el.children.length - 1; i >= 0; i -= 1) stack.push(el.children[i]);
    }

    const links = [];
    const seen = new Set();

    container.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
      if (a.closest("td, th")) return;

      let absoluteHref;
      try {
        absoluteHref = new URL(href, url).href;
      } catch {
        return;
      }
      const context = nearestHeadingByElement.get(a) || "";

      if (seen.has(absoluteHref)) {
        // Update context to the latest (most specific) occurrence
        for (const link of links) {
          if (link.href === absoluteHref && context) {
            link.context = context;
          }
        }
        return;
      }
      seen.add(absoluteHref);

      links.push({
        text: enrichNumericLinkText(a, (a.textContent || "").replace(/\s+/g, " ").trim(), absoluteHref).slice(0, 200),
        href: absoluteHref,
        rel: a.getAttribute("rel") || "",
        type: a.getAttribute("type") || "",
        context
      });
    });

    return links;
  } finally {
    if (ownedDom) dom.window.close();
  }
}

async function domHasSelector(page, selector) {
  try {
    return Boolean(
      await page.evaluate(
        (sel) => {
          try {
            return !!document.querySelector(sel);
          } catch {
            return false;
          }
        },
        selector
      )
    );
  } catch {
    return false;
  }
}

async function firstMatchingHint(page, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  for (const candidate of candidates) {
    if (!candidate?.requireSelector) return candidate;
    if (await domHasSelector(page, candidate.requireSelector)) return candidate;
  }
  return null;
}

const FLOW_STAGE_CAPTURE_LIMIT = 60000;
const FLOW_STEP_DEFAULT_TIMEOUT_MS = 10000;

async function stabilizePage(page, hint, config, strategyOverride, contentTargetSelector) {
  const stabilizeStrategy =
    strategyOverride ||
    hint?.default?.stabilizeStrategy ||
    "network_idle";
  if (stabilizeStrategy === "network_idle") {
    try {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 });
    } catch {}
  } else if (stabilizeStrategy === "content_idle") {
    await waitForContent(page, {
      maxWait: 5000,
      extraSelectors: hint?.default?.waitForContent,
      ...(contentTargetSelector ? { targetSelector: contentTargetSelector } : {})
    }).catch(() => {});
  } else if (stabilizeStrategy === "mutation") {
    await waitForMutations(page, { maxWait: 5000 }).catch(() => {});
  }
}

async function detectBotChallenge(page) {
  try {
    return await page.evaluate(() => {
      const title = document.title || "";
      const bodyText = (document.body?.innerText || "").trim();
      const html = (document.documentElement?.outerHTML || "").toLowerCase();
      if (html.includes("cf-browser-verification") || html.includes("__cf_challenge") || /just a moment|performing security verification|security service to protect/i.test(`${title}\n${bodyText}`)) return "Cloudflare challenge";
      if (html.includes("data-dome") || bodyText.includes("Please enable JS") || bodyText.includes("disable any ad blocker")) return "DataDome challenge";
      if ((!title && !bodyText) || /^[a-z0-9-]+\.[a-z]{2,}$/i.test(title)) return `Bot block detected (title: "${title}")`;
      return null;
    });
  } catch {
    return null;
  }
}

async function detectPageState(page) {
  try {
    return await page.evaluate(() => {
      const warnings = [];
      const bodyText = (document.body?.innerText || "").trim();
      const textLen = bodyText.replace(/\s+/g, " ").trim().length;
      if (document.querySelector('input[type="password"]')) {
        warnings.push("Page appears to require login — auth wall detected (a password field is present)");
      }
      const mediaCount = document.querySelectorAll("img, canvas, video, picture, svg").length;
      if (textLen < 120 && mediaCount >= 3) {
        warnings.push("Page appears to be visual-only — little extractable text (mostly images/media)");
      }
      return warnings;
    });
  } catch {
    return [];
  }
}

async function countVisibleMatches(page, selector) {
  try {
    return await page.evaluate((sel) => {
      let count = 0;
      for (const el of document.querySelectorAll(sel)) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        count += 1;
      }
      return count;
    }, selector);
  } catch {
    return 0;
  }
}

async function capturePageState(page) {
  const [html, url, title, browserText] = await Promise.all([
    page.content(),
    Promise.resolve(page.url()),
    page.title(),
    page.evaluate(() => document.body?.innerText || "").catch(() => "")
  ]);
  return { html, url, title, browserText };
}

async function extractHintStage(pageState, hint, step, maxChars, debug, defaultExtractSkipSelectors, config, signal, dom) {
  return extractTextFromHtml({
    html: pageState.html,
    url: pageState.url,
    maxChars,
    fallbackTitle: pageState.title,
    hint: { ...hint, content: step.content },
    browserText: pageState.browserText,
    screenshot: pageState.screenshot,
    debug,
    strict: true,
    defaultExtractSkipSelectors,
    config,
    signal,
    dom
  });
}

function renderExtractedStage(label, extracted) {
  let text = extracted?.text || "";
  const parts = [];
  if (label) parts.push(`## ${label}`, "");
  parts.push(text.trim());
  return {
    text: parts.join("\n"),
    tables: extracted?.tables || [],
    warnings: extracted?.warnings || [],
    textOriginalLength: extracted?.textOriginalLength || 0
  };
}

function mergeExtractedStages(stages, maxChars, preCollectedLinks = []) {
  const textParts = [];
  const tables = [];
  const linksByHref = new Map();
  const warnings = [];
  let textOriginalLength = 0;
  for (const link of preCollectedLinks) {
    if (!linksByHref.has(link.href)) linksByHref.set(link.href, link);
  }
  for (const stage of stages) {
    if (stage.text?.trim()) textParts.push(stage.text.trim());
    textOriginalLength += stage.textOriginalLength || 0;
    if (stage.tables?.length) tables.push(...stage.tables);
    for (const link of stage.links || []) {
      if (!linksByHref.has(link.href)) linksByHref.set(link.href, link);
    }
    if (stage.warnings?.length) warnings.push(...stage.warnings);
  }
  let text = textParts.join("\n\n").trim();
  let textWasTruncated = false;
  if (text.length > maxChars) {
    text = safeTruncateText(text, maxChars);
    textWasTruncated = text.endsWith("...");
  }
  return {
    text,
    textWasTruncated,
    textOriginalLength,
    tables,
    links: [...linksByHref.values()],
    warnings: [...new Set(warnings)]
  };
}

function isSnapshotReplayableFlow(flow) {
  return flow.every(
    (step) =>
      (step.action === "extract" && !step.content?.blocks?.some((block) => block.format === "screenshot")) ||
      (step.action === "wait" && !step.selector)
  );
}

async function replayFlowFromSnapshot({ url, html, hint, maxChars, debug, hintNote, defaultExtractSkipSelectors, config, signal }) {
  const flow = hint.flow;
  const flowOptions = hint.flowOptions || {};
  const continueOnEmptyExtract = flowOptions.continueOnEmptyExtract === true;
  const state = { html, url, title: "", browserText: "" };
  const stages = [];
  const linksByHref = new Map();
  const warnings = [];

  for (const [index, step] of flow.entries()) {
    if (step.action !== "extract") continue;
    const stageDom = parseHtmlToDom(state.html, state.url);
    let stageLinks;
    let extracted;
    try {
      stageLinks = extractLinksFromHtml({ dom: stageDom, url: state.url });
      for (const link of stageLinks) {
        if (!linksByHref.has(link.href)) linksByHref.set(link.href, link);
      }
      extracted = await extractHintStage(state, hint, step, FLOW_STAGE_CAPTURE_LIMIT, debug, defaultExtractSkipSelectors, config, signal, stageDom);
    } finally {
      stageDom.window.close();
    }
    if (extracted.tables?.length && !(extracted.text || "").trim()) {
      extracted.text = extracted.tables.map(renderTableAsMarkdown).join("\n\n");
      extracted.tables = [];
    }
    const stageLabel = (step.label || "").trim();
    const stage = renderExtractedStage(stageLabel, extracted);
    const emptyStage = !stage.text.trim() || stage.text.trim() === (stageLabel ? `## ${stageLabel}` : "");
    if (emptyStage) {
      const message = `Domain hint flow step ${index + 1} extract "${step.label}" produced no content`;
      if (!continueOnEmptyExtract) {
        throw new Error(message);
      }
      warnings.push(`${message} (skipped)`);
      continue;
    }
    stages.push(stage);
  }

  const merged = mergeExtractedStages(stages, maxChars, [...linksByHref.values()]);
  merged.warnings = [...merged.warnings, ...warnings];

  let finalText = merged.text || "";
  const textWasTruncated = merged.textWasTruncated;
  if (textWasTruncated || finalText.length > maxChars) {
    const fullSize = merged.textOriginalLength || finalText.length;
    if (textWasTruncated) {
      finalText = finalText.slice(0, -3).trimEnd();
    }
    finalText += `\n\n*(Response truncated — full page is ${fullSize} chars, increase maxChars to see more)*`;
  }
  if (hintNote) {
    finalText = `${hintNote}\n\n${finalText}`;
  }

  return {
    title: "",
    url,
    text: finalText,
    textOriginalLength: merged.textOriginalLength,
    ...(merged.tables.length ? { tables: merged.tables } : {}),
    ...(merged.links.length ? { links: merged.links } : {}),
    ...(merged.warnings.length ? { warnings: merged.warnings } : {})
  };
}

async function executeFlow({ page, hint, config, maxChars: _maxChars, debug, debugLog, withPageTimeout, withOperationDeadline, operationTimeoutMs, defaultExtractSkipSelectors, signal }) {
  const flow = hint.flow;
  const flowOptions = hint.flowOptions || {};
  const totalTimeoutMs = Math.min(
    Number.isInteger(flowOptions.totalTimeoutMs) && flowOptions.totalTimeoutMs > 0
      ? flowOptions.totalTimeoutMs
      : FLOW_TOTAL_TIMEOUT_MAX,
    FLOW_TOTAL_TIMEOUT_MAX
  );
  const continueOnEmptyExtract = flowOptions.continueOnEmptyExtract === true;
  const stages = [];
  const linksByHref = new Map();
  const warnings = [];

  const flowStart = Date.now();
  let stepIndex = 0;

  const checkTotalBudget = (stepLabel) => {
    if (Date.now() - flowStart > totalTimeoutMs) {
      throw new Error(
        `Domain hint flow step ${stepIndex + 1} (${stepLabel}) exceeded total timeout (${totalTimeoutMs}ms)`
      );
    }
  };

  const checkBot = async () => {
    const challenge = await withPageTimeout("check_bot_flow", () => detectBotChallenge(page));
    if (challenge) {
      throw new Error(`Domain hint flow step ${stepIndex} aborted: bot challenge detected (${challenge})`);
    }
  };

  for (const step of flow) {
    stepIndex += 1;
    checkTotalBudget(step.action);
    const tStep = performance.now();
    try {
      if (step.action === "extract") {
        const state = await withPageTimeout("flow_capture", () => capturePageState(page));
        const needsScreenshot = step.content?.blocks?.some((block) => block.format === "screenshot");
        if (needsScreenshot && typeof page.screenshot === "function") {
          try {
            state.screenshot = await withPageTimeout("flow_capture_screenshot", () =>
              page.screenshot({ encoding: "base64", type: "jpeg", quality: 75, fullPage: true })
            );
          } catch (error) {
            if (signal?.aborted) throw error;
            state.screenshot = null;
          }
        }
        const stageDom = parseHtmlToDom(state.html, state.url);
        let stageLinks;
        let extracted;
        try {
          stageLinks = extractLinksFromHtml({ dom: stageDom, url: state.url });
          for (const link of stageLinks) {
            if (!linksByHref.has(link.href)) linksByHref.set(link.href, link);
          }
          extracted = await withOperationDeadline("flow_extract", () =>
            extractHintStage(state, hint, step, FLOW_STAGE_CAPTURE_LIMIT, debug, defaultExtractSkipSelectors, config, signal, stageDom)
          );
        } finally {
          stageDom.window.close();
        }
        if (extracted.tables?.length && !(extracted.text || "").trim()) {
          extracted.text = extracted.tables.map(renderTableAsMarkdown).join("\n\n");
          extracted.tables = [];
        }
        const stageLabel = (step.label || "").trim();
        const stage = renderExtractedStage(stageLabel, extracted);
        const emptyStage = !stage.text.trim() || stage.text.trim() === (stageLabel ? `## ${stageLabel}` : "");
        if (emptyStage) {
          const message = `Domain hint flow step ${stepIndex} extract "${step.label}" produced no content`;
          if (!continueOnEmptyExtract) {
            throw new Error(message);
          }
          warnings.push(`${message} (skipped)`);
          continue;
        }
        stages.push(stage);
      } else if (step.action === "click") {
        const visible = await withPageTimeout("flow_click_count", () => countVisibleMatches(page, step.selector));
        if (visible === 0) {
          throw new Error(`Domain hint flow step ${stepIndex} click failed: selector "${step.selector}" matched 0 visible elements`);
        }
        if (visible > 1) {
          throw new Error(`Domain hint flow step ${stepIndex} click failed: selector "${step.selector}" matched ${visible} visible elements (expected exactly 1)`);
        }
        await withPageTimeout("flow_click", () => page.click(step.selector, { delay: 50 })).catch((error) => {
          throw new Error(`Domain hint flow step ${stepIndex} click failed: ${String(error?.message || error)}`);
        });
        const clickTimeout = step.timeoutMs ?? FLOW_STEP_DEFAULT_TIMEOUT_MS;
        if (step.waitForSelector) {
          await withPageTimeout("flow_click_wait", () =>
            page.waitForSelector(step.waitForSelector, { timeout: clickTimeout })
          ).catch((error) => {
            throw new Error(
              `Domain hint flow step ${stepIndex} click: post-click selector "${step.waitForSelector}" not found after ${clickTimeout}ms: ${String(error?.message || error)}`
            );
          });
          if (step.stabilizeStrategy !== "none") {
            await withPageTimeout("flow_click_stabilize", () =>
              stabilizePage(page, hint, config, step.stabilizeStrategy, step.waitForSelector)
            );
            await checkBot();
          }
        } else if (step.stabilizeStrategy !== undefined && step.stabilizeStrategy !== "" && step.stabilizeStrategy !== "none") {
          await withPageTimeout("flow_click_stabilize", () =>
            stabilizePage(page, hint, config, step.stabilizeStrategy)
          );
          await checkBot();
        }
      } else if (step.action === "wait") {
        if (step.selector) {
          const waitTimeout = step.timeoutMs ?? FLOW_STEP_DEFAULT_TIMEOUT_MS;
          await withPageTimeout("flow_wait", () =>
            page.waitForSelector(step.selector, { state: step.state || "visible", timeout: waitTimeout })
          ).catch((error) => {
            throw new Error(
              `Domain hint flow step ${stepIndex} wait failed: selector "${step.selector}" (state "${step.state || "visible"}"): ${String(error?.message || error)}`
            );
          });
        }
        if (step.stabilizeStrategy !== "none") {
          await withPageTimeout("flow_wait_stabilize", () =>
            stabilizePage(page, hint, config, step.stabilizeStrategy, step.selector || undefined)
          );
          await checkBot();
        }
      } else if (step.action === "type") {
        await withPageTimeout("flow_type_focus", () => page.click(step.selector, { delay: 20 })).catch((error) => {
          throw new Error(`Domain hint flow step ${stepIndex} type failed: cannot focus "${step.selector}": ${String(error?.message || error)}`);
        });
        if (step.clear !== false) {
          await withPageTimeout("flow_type_clear", () =>
            page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (el) el.value = "";
            }, step.selector)
          );
        }
        await withPageTimeout("flow_type_text", () => page.type(step.selector, step.text, { delay: 30 }));
        if (step.submit === true) {
          await withPageTimeout("flow_type_submit", () => page.keyboard.press("Enter"));
          const typeTimeout = step.timeoutMs ?? FLOW_STEP_DEFAULT_TIMEOUT_MS;
          await withPageTimeout("flow_type_wait", () =>
            page.waitForSelector(step.waitForSelector, { timeout: typeTimeout })
          ).catch((error) => {
            throw new Error(
              `Domain hint flow step ${stepIndex} type: results selector "${step.waitForSelector}" not found after ${typeTimeout}ms: ${String(error?.message || error)}`
            );
          });
          if (step.stabilizeStrategy !== "none") {
            await withPageTimeout("flow_type_stabilize", () =>
              stabilizePage(page, hint, config, step.stabilizeStrategy, step.waitForSelector)
            );
            await checkBot();
          }
        }
      } else if (step.action === "navigate") {
        const target = new URL(step.url, page.url()).href;
        await withPageTimeout("flow_navigate", () =>
          page.goto(target, { waitUntil: "domcontentloaded", timeout: operationTimeoutMs })
        );
        const navTimeout = step.timeoutMs ?? FLOW_STEP_DEFAULT_TIMEOUT_MS;
        await withPageTimeout("flow_navigate_wait", () =>
          page.waitForSelector(step.waitForSelector, { timeout: navTimeout })
        ).catch((error) => {
          throw new Error(
            `Domain hint flow step ${stepIndex} navigate: destination selector "${step.waitForSelector}" not found after ${navTimeout}ms: ${String(error?.message || error)}`
          );
        });
        await withPageTimeout("flow_navigate_stabilize", () =>
          stabilizePage(page, hint, config, step.stabilizeStrategy, step.waitForSelector)
        );
        await checkBot();
      }
    } finally {
      debugLog(`flow_step_${stepIndex}_${step.action}`, tStep);
    }
  }

  return { stages, links: [...linksByHref.values()], warnings };
}

async function runFlowExtraction({ page, hint, config, maxChars, debug, debugLog, withPageTimeout, withOperationDeadline, operationTimeoutMs, includeSeoAnalysis, hintNote, startTime, defaultExtractSkipSelectors, signal }) {
  // No bot check here: browserOpenAndExtract already ran `check_bot_early`
  // immediately before invoking us, with no navigation in between. The
  // flow's own per-step `checkBot` guards gated transitions (click/type/
  // navigate) where a fresh challenge could actually appear.

  const flowResult = await executeFlow({
    page,
    hint,
    config,
    maxChars,
    debug,
    debugLog,
    withPageTimeout,
    withOperationDeadline,
    operationTimeoutMs,
    defaultExtractSkipSelectors,
    signal
  });

  const finalState = await withPageTimeout("flow_final_state", () => capturePageState(page));
  const seoSnapshot =
    includeSeoAnalysis === false
      ? null
      : await withPageTimeout("seo_snapshot", () =>
          captureSeoSnapshot(page, {
            textLimit: Math.min(MAX_MAIN_TEXT_CHARS, Math.max(maxChars * 3, 4000)),
            htmlLimit: Math.min(Math.max(MAX_MAIN_HTML_CHARS, maxChars * 6), 120000),
            maxCandidates: MAX_SEO_CANDIDATES,
            extraSelectors: hint?.default?.waitForContent
          })
        );

  const merged = mergeExtractedStages(flowResult.stages, maxChars, flowResult.links);
  merged.warnings = [...merged.warnings, ...(flowResult.warnings || [])];
  const pageStateWarnings = await withPageTimeout("detect_page_state", () => detectPageState(page));
  if (pageStateWarnings.length) merged.warnings = [...merged.warnings, ...pageStateWarnings];
  const seoAnalysis =
    includeSeoAnalysis === false
      ? null
      : buildSeoAnalysis({ snapshot: seoSnapshot, extracted: { text: merged.text, title: finalState.title }, maxChars });

  let finalText = merged.text || "";
  const textWasTruncated = merged.textWasTruncated;
  if (textWasTruncated || finalText.length > maxChars) {
    const fullSize = merged.textOriginalLength || finalText.length;
    if (textWasTruncated) {
      finalText = finalText.slice(0, -3).trimEnd();
    }
    finalText += `\n\n*(Response truncated — full page is ${fullSize} chars, increase maxChars to see more)*`;
  }

  if (hintNote) {
    finalText = `${hintNote}\n\n${finalText}`;
  }

  const result = {
    title: cleanWhitespace(finalState.title || ""),
    url: finalState.url,
    text: finalText,
    textOriginalLength: merged.textOriginalLength,
    ...(merged.tables.length ? { tables: merged.tables } : {}),
    ...(merged.links.length ? { links: merged.links } : {}),
    ...(merged.warnings.length ? { warnings: merged.warnings } : {}),
    ...(seoAnalysis ? { seo: seoAnalysis } : {})
  };

  if (debug) {
    const elapsed = Math.round(performance.now() - startTime);
    console.log(
      `[web_fetch] [${finalState.url}] TOTAL(flow): ${elapsed}ms | text: ${finalText.length} chars | links: ${merged.links.length} | tables: ${merged.tables.length} | stages: ${flowResult.stages.length}`
    );
  }

  return result;
}

export async function browserOpenAndExtract({ url, maxChars: requestedMaxChars, includeSeoAnalysis = true, hintOverride = null, cachedHtml = null, captureHtml = false, browser = "" }) {
  const tOverall = performance.now();
  activityCounters.fetches += 1;
  incrementUsageTotal("fetches");
  const bootstrapTimeoutMs = Math.max(1000, Number(process.env.BROWSER_OP_TIMEOUT_MS) || 60000);
  const operation = new WebFetchOperation({
    url,
    stepTimeoutMs: bootstrapTimeoutMs,
    totalTimeoutMs: bootstrapTimeoutMs * 3
  });
  let manager;
  try {
    manager = await operation.step("browser_manager", () => getBrowserManager());
  } catch (error) {
    await operation.finish(operation.timedOut ? "op_timeout" : "op_failed");
    operation.dispose();
    throw error;
  }
  const operationTimeoutMs = Math.max(1000, Number(manager.config.browserOpTimeoutMs) || 60000);
  operation.configureTimeouts({
    stepTimeoutMs: operationTimeoutMs,
    totalTimeoutMs: operationTimeoutMs * 3
  });
  const maxChars = requestedMaxChars ?? manager.config.maxChars ?? DEFAULT_MAX_CHARS;
  const debug = manager.config.debug === true;
  const defaultExtractSkipSelectors = [];
  const debugLog = (label, t) => {
    if (debug) console.log(`[web_fetch] [${url}] ${label}: ${Math.round(performance.now() - t)}ms`);
  };
  let t = performance.now();
  const pageOpId = recordPageOpStart({ tool: "web_fetch", url, backend: manager.config.defaultBackend });

  try {
    const result = await operation.run(async () => {
      let hint = null;
      let hintCandidates = [];
      let hintNote = "";
      let hints = [];

      if (hintOverride) {
        hint = hintOverride;
        if (debug) console.log(`[web_fetch] [${url}] hint=override (test-before-save)`);
      } else {
        hints = await operation.step("load_domain_hints", () => getDomainHints(manager.config));
        hintCandidates = findMatchingHints(url, hints);
      }
      debugLog("load_domain_hints", t);

      if (!hint) {
        const wildcard = getWildcardHint(hints);
        if (wildcard) {
          hint = wildcard;
          if (wildcard.default?.skipSelectors?.length) {
            defaultExtractSkipSelectors.push(...wildcard.default.skipSelectors);
          }
          if (debug) {
            const matched = hintCandidates.length > 0;
            console.log(`[web_fetch] [${url}] hint=wildcard_default (${matched ? "candidates pending DOM resolution" : "no domain hint matched"})`);
          }
        }
      }

      // Browser selection: explicit `browser` param wins; otherwise the
      // URL-matched hint's `browserEngine` is the default; rollback applies.
      const hintBrowserEngine = (hintOverride || hintCandidates[0] || hint || "")?.browserEngine || "";
      const requestedBrowser = browser || hintBrowserEngine;

      const cached = typeof cachedHtml === "string" && cachedHtml.length > 0 ? cachedHtml : null;
      if (cached && hint?.flow?.length && isSnapshotReplayableFlow(hint.flow)) {
        const tCache = performance.now();
        const replayed = await operation.wait("cached_flow_replay", () => replayFlowFromSnapshot({
          url,
          html: cached,
          hint,
          maxChars,
          debug,
          hintNote,
          defaultExtractSkipSelectors,
          config: manager.config,
          signal: operation.signal
        }));
        if (debug) console.log(`[web_fetch] [${url}] cached flow replay: ${Math.round(performance.now() - tCache)}ms (browser skipped)`);
        return replayed;
      }
      if (cached && !(hint?.flow?.length)) {
        const tCache = performance.now();
        const extracted = await operation.wait("cached_html_extraction", () => extractTextFromHtml({
          html: cached,
          url,
          maxChars,
          fallbackTitle: "",
          hint,
          browserText: "",
          debug,
          defaultExtractSkipSelectors,
          config: manager.config,
          signal: operation.signal
        }));
        const links = extractLinksFromHtml({ html: cached, url });
        let finalText = extracted.text || "";
        const textWasTruncated = extracted.text?.endsWith("...");
        if (textWasTruncated || finalText.length > maxChars) {
          const fullSize = extracted.textOriginalLength || finalText.length;
          if (textWasTruncated) {
            finalText = finalText.slice(0, -3).trimEnd();
          }
          finalText += `\n\n*(Response truncated — full page is ${fullSize} chars, increase maxChars to see more)*`;
        }
        if (hintNote) {
          finalText = `${hintNote}\n\n${finalText}`;
        }
        if (debug) console.log(`[web_fetch] [${url}] cached-html extraction: ${Math.round(performance.now() - tCache)}ms (browser skipped)`);
        return {
          ...extracted,
          text: finalText,
          ...(links.length ? { links } : {})
        };
      }

      return manager.withPageSlot(async () => {
        t = performance.now();
        const { page, browser: usedBrowser, rollbackNotes = [] } = await operation.openPage(() =>
          resolveBrowserParam({ browser: requestedBrowser }, manager.config, manager)
        );
        debugLog("new_page", t);
        const withPageTimeout = (label, task) => operation.step(label, task);
        const withOperationDeadline = (label, task) => operation.wait(label, task);

        try {
          t = performance.now();
          await withPageTimeout("goto", () =>
            page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: manager.config.browserOpTimeoutMs
            })
          );
          debugLog("goto_page", t);

          t = performance.now();
          hint = hintOverride
            ? hintOverride
            : await withPageTimeout("resolve_hint_dom", () => firstMatchingHint(page, hintCandidates));
          debugLog("resolve_hint_dom", t);

          const waitSelectors = Array.isArray(hint?.default?.waitForSelector)
            ? hint.default.waitForSelector
            : hint?.default?.waitForSelector
              ? [hint.default.waitForSelector]
              : [];
          if (waitSelectors.length) {
            t = performance.now();
            try {
              await withPageTimeout("wait_for_selectors", () => Promise.all(
                waitSelectors.map((sel) =>
                  page.waitForSelector(sel, { timeout: Math.min(operationTimeoutMs, 20000) })
                )
              ));
            } catch (error) {
              if (operation.signal.aborted) throw error;
            }
            debugLog("wait_for_selector", t);
          }

          // Flow hints own their stabilization: every gated step (wait,
          // click, type-with-submit, navigate) stabilizes per the step's
          // stabilizeStrategy, so a leading wait step makes the generic
          // pre-flow stabilize redundant. Skip it — saves a full
          // network-idle wait (~1.5-2s) on SPA-heavy flow hints.
          const flowLeadsWithWait = hint?.flow?.[0]?.action === "wait" && hint.flow[0].stabilizeStrategy !== "none";
          t = performance.now();
          if (!flowLeadsWithWait) {
            await withPageTimeout("stabilize_page", () => stabilizePage(page, hint, manager.config));
          }
          debugLog("stabilize_page", t);

          t = performance.now();
          const earlyBotChallenge = await withPageTimeout("check_bot_early", () => detectBotChallenge(page));
          debugLog("check_bot_early", t);
          if (earlyBotChallenge) {
            const earlyUrl = page.url();
            let earlyTitle = "";
            try {
              earlyTitle = await withPageTimeout("early_title", () => page.title());
            } catch (error) {
              if (operation.signal.aborted) throw error;
            }
            return {
              title: earlyTitle || earlyUrl || "",
              url: earlyUrl,
              text: "",
              error: earlyBotChallenge,
              browser: usedBrowser,
              ...(rollbackNotes.length ? { browserNote: `Browser rollback: ${rollbackNotes.join(", ")}` } : {})
            };
          }

          if (hintOverride) {
            if (hint?.requireSelector && !(await withPageTimeout("require_selector", () => domHasSelector(page, hint.requireSelector)))) {
              hintNote = `⚠ requireSelector "${hint.requireSelector}" not found on this page — hint did not apply`;
              hint = null;
            }
          } else if (!hint && hintCandidates.length) {
            hint = await withPageTimeout("resolve_hint_dom_final", () => firstMatchingHint(page, hintCandidates));
          }
          debugLog("resolve_hint_dom_final", t);

          if (!hint) {
            hint = getWildcardHint(hints);
            if (hint && debug) console.log(`[web_fetch] [${url}] hint=wildcard_default (candidates matched nothing)`);
          }

          if (hint?.flow?.length) {
            const flowHtml = captureHtml
              ? await withPageTimeout("flow_html", () => page.content())
              : null;
            const flowResult = await withOperationDeadline("flow_extraction", () => runFlowExtraction({
              page,
              hint,
              config: manager.config,
              maxChars,
              debug,
              debugLog,
              withPageTimeout,
              withOperationDeadline,
              operationTimeoutMs,
              includeSeoAnalysis,
              hintNote,
              startTime: tOverall,
              defaultExtractSkipSelectors,
              signal: operation.signal
            }));
            if (flowHtml && !flowResult.error) {
              return { ...flowResult, html: flowHtml, browser: usedBrowser, ...(rollbackNotes.length ? { browserNote: `Browser rollback: ${rollbackNotes.join(", ")}` } : {}) };
            }
            return { ...flowResult, browser: usedBrowser, ...(rollbackNotes.length ? { browserNote: `Browser rollback: ${rollbackNotes.join(", ")}` } : {}) };
          }

          t = performance.now();
          const seoSnapshot =
            includeSeoAnalysis === false
              ? null
              : await withPageTimeout("seo_snapshot", () =>
                  captureSeoSnapshot(page, {
                    textLimit: Math.min(MAX_MAIN_TEXT_CHARS, Math.max(maxChars * 3, 4000)),
                    htmlLimit: Math.min(Math.max(MAX_MAIN_HTML_CHARS, maxChars * 6), 120000),
                    maxCandidates: MAX_SEO_CANDIDATES,
                    extraSelectors: hint?.default?.waitForContent
                  })
                );
          if (includeSeoAnalysis !== false) debugLog("capture_seo_snapshot", t);

          t = performance.now();
          const [html, pageTitle, browserText] = await Promise.all([
            withPageTimeout("serialize_html", () => page.content()),
            withPageTimeout("serialize_title", () => page.title()),
            withPageTimeout("serialize_text", () => page.evaluate(() => document.body?.innerText || "").catch(() => ""))
          ]);
          const resolvedUrl = page.url();
          const screenshot = hint?.default?.format === "screenshot" && typeof page.screenshot === "function"
            ? await withPageTimeout("capture_extraction_screenshot", () =>
                page.screenshot({ encoding: "base64", type: "jpeg", quality: 30 })
              )
            : null;
          debugLog("serialize_page", t);

          t = performance.now();
          const botChallenge = await withPageTimeout("check_bot", () => detectBotChallenge(page));
          debugLog("check_bot", t);

          if (botChallenge) {
            return {
              title: pageTitle || resolvedUrl || "",
              url: resolvedUrl,
              text: "",
              error: botChallenge,
              browser: usedBrowser,
              ...(rollbackNotes.length ? { browserNote: `Browser rollback: ${rollbackNotes.join(", ")}` } : {})
            };
          }

          t = performance.now();
          const pageStateWarnings = await withPageTimeout("detect_page_state", () => detectPageState(page));
          debugLog("detect_page_state", t);

          t = performance.now();
          const extracted = await withOperationDeadline("extract_text_from_html", () => extractTextFromHtml({
            html,
            url: resolvedUrl,
            maxChars,
            fallbackTitle: pageTitle,
            hint,
            browserText,
            screenshot,
            debug,
            defaultExtractSkipSelectors,
            config: manager.config,
            signal: operation.signal
          }));
          debugLog("extract_text_from_html", t);

          t = performance.now();
          const seoAnalysis =
            includeSeoAnalysis === false
              ? null
              : buildSeoAnalysis({ snapshot: seoSnapshot, extracted, maxChars });
          if (includeSeoAnalysis !== false) debugLog("build_seo_analysis", t);

          const selectedText = extracted.text || seoAnalysis?.mainContentText || "";
          let finalText = selectedText || extracted.text || "";

          t = performance.now();
          const links = extractLinksFromHtml({ html, url: resolvedUrl });
          debugLog("extract_links", t);

          const textWasTruncated = extracted.text?.endsWith("...");
          if (textWasTruncated || finalText.length > maxChars) {
            const fullSize = extracted.textOriginalLength || finalText.length;
            if (textWasTruncated) {
              finalText = finalText.slice(0, -3).trimEnd();
            }
            finalText += `\n\n*(Response truncated — full page is ${fullSize} chars, increase maxChars to see more)*`;
          }

          if (hintNote) {
            finalText = `${hintNote}\n\n${finalText}`;
          }

          const result = {
            ...extracted,
            text: finalText,
            ...(links.length ? { links } : {}),
            ...(seoAnalysis ? { seo: seoAnalysis } : {}),
            ...(captureHtml ? { html } : {}),
            browser: usedBrowser,
            ...(rollbackNotes.length ? { browserNote: `Browser rollback: ${rollbackNotes.join(", ")}` } : {}),
            ...(pageStateWarnings.length
              ? { warnings: [...(extracted.warnings || []), ...pageStateWarnings] }
              : {})
          };

          if (debug) {
            const elapsed = Math.round(performance.now() - tOverall);
            const sectionsUsed = hint?.content?.sections ? hint.content.sections.length : 0;
            const textLen = finalText.length;
            const linkCount = links?.length || 0;
            const tableCount = extracted?.tables?.length || 0;
            console.log(`[web_fetch] [${url}] TOTAL: ${elapsed}ms | text: ${textLen} chars | links: ${linkCount} | tables: ${tableCount} | sections: ${sectionsUsed}`);
          }

          return result;
        } finally {
          t = performance.now();
          if (operation.timedOut) {
            void operation.closePage("op_timeout");
          } else {
            await operation.closePage("op_complete");
          }
          debugLog("close_page", t);
        }
      }, { signal: operation.signal });
    });

    await operation.finish("op_complete");
    recordPageOp({ id: pageOpId, tool: "web_fetch", url, backend: result?.browser || manager.config.defaultBackend, durationMs: performance.now() - tOverall, responseChars: result.text?.length, ok: true, responsePreview: result.text || "" });
    return result;
  } catch (error) {
    await operation.finish(operation.timedOut ? "op_timeout" : "op_failed");
    recordPageOp({ id: pageOpId, tool: "web_fetch", url, backend: manager.config.defaultBackend, durationMs: performance.now() - tOverall, ok: false, error: String(error?.message || error), responsePreview: "" });
    throw error;
  } finally {
    operation.dispose();
  }
}

export async function browserCaptureScreenshot({
  url,
  format: _format = "jpeg",
  fullPage = true,
  quality,
  viewport,
  browser = ""
}) {
  activityCounters.screenshots += 1;
  incrementUsageTotal("screenshots");
  const manager = await getBrowserManager();
  const tShotStart = performance.now();
  const normalizedFormat = "jpeg";
  const normalizedQuality =
    normalizedFormat === "jpeg"
      ? Math.max(1, Math.min(100, Math.floor(Number.isFinite(quality) ? quality : 75)))
      : undefined;
  const pageOpId = recordPageOpStart({ tool: "web_page_screenshot", url, backend: manager.config.defaultBackend });

  try {
    const result = await manager.withPageSlot(async () => {
    const { page, browser: usedBrowser, rollbackNotes = [] } = await resolveBrowserParam({ browser }, manager.config, manager);

    try {
      if (viewport && typeof viewport === "object" && viewport.width) {
        const vw = Math.floor(Number(viewport.width));
        const vh = Math.floor(Number(viewport.height));
        if (Number.isFinite(vw) && vw > 0 && Number.isFinite(vh) && vh > 0) {
          try {
            await page.setViewport({ width: vw, height: vh });
          } catch (e) {
            console.error(`📸  setViewport failed: ${String(e?.message || e)}`);
          }
        }
      }
      await page.goto(url, {
        waitUntil: manager.config.navWaitUntil,
        timeout: manager.config.browserOpTimeoutMs
      });

      await waitForContent(page, { maxWait: 5000 }).catch(() => {});

      const dimensions = await page.evaluate(() => {
        const docEl = document.documentElement;
        const body = document.body;
        const viewportWidth = window.innerWidth || docEl?.clientWidth || 0;
        const viewportHeight = window.innerHeight || docEl?.clientHeight || 0;
        const fullWidth = Math.max(docEl?.scrollWidth || 0, body?.scrollWidth || 0, viewportWidth);
        const fullHeight = Math.max(docEl?.scrollHeight || 0, body?.scrollHeight || 0, viewportHeight);
        return {
          viewportWidth,
          viewportHeight,
          fullWidth,
          fullHeight
        };
      });

      const timeoutMs = Math.max(1000, Number(manager.config.browserOpTimeoutMs) || 60000);
      const vpLog = viewport ? `${viewport.width}x${viewport.height}` : "default";
      console.error(`📸  url screenshot: url=${url} format=${normalizedFormat} quality=${normalizedQuality ?? "default"} fullPage=${fullPage !== false} viewport=${vpLog} dims=${dimensions.fullWidth}x${dimensions.fullHeight} timeout=${timeoutMs}ms`);

      let screenshot;
      try {
        screenshot = await Promise.race([
          page.screenshot({
            type: normalizedFormat,
            encoding: "base64",
            fullPage: fullPage !== false,
            ...(normalizedFormat === "jpeg" && normalizedQuality ? { quality: normalizedQuality } : {})
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Screenshot timed out after ${timeoutMs}ms`)), timeoutMs)
          )
        ]);
      } catch (error) {
        console.error(`📸  url screenshot failed: url=${url} dims=${dimensions.fullWidth}x${dimensions.fullHeight} error=${String(error?.message || error)}`);
        if (error?.stack) console.error(`📸  stack: ${String(error.stack).slice(0, 500)}`);
        throw error;
      }

      const [resolvedUrl, pageTitle] = await Promise.all([Promise.resolve(page.url()), page.title()]);

      return {
        url: resolvedUrl,
        title: pageTitle,
        format: normalizedFormat,
        contentType: normalizedFormat === "jpeg" ? "image/jpeg" : "image/png",
        sizeBytes: Buffer.byteLength(screenshot, "base64"),
        captureTimestamp: new Date().toISOString(),
        dimensions,
        screenshotBase64: screenshot,
        browser: usedBrowser,
        ...(rollbackNotes.length ? { browserNote: `Browser rollback: ${rollbackNotes.join(", ")}` } : {})
      };
    } finally {
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch {
        // Target may have been closed by timeout handler or concurrent operation
      }
    }
    });
    recordPageOp({ id: pageOpId, tool: "web_page_screenshot", url, backend: result?.browser || manager.config.defaultBackend, durationMs: performance.now() - tShotStart, responseChars: result.screenshotBase64?.length, ok: true });
    return result;
  } catch (error) {
    recordPageOp({ id: pageOpId, tool: "web_page_screenshot", url, backend: manager.config.defaultBackend, durationMs: performance.now() - tShotStart, ok: false, error: String(error?.message || error) });
    throw error;
  }
}
