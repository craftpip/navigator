import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { EXTRACTOR_FORMATS } from "./extractors/index.js";

let loadedHints = null;
let loadedPath = null;
// plan 60 H2: signature of the file state the cache was loaded from — the
// pre-read `mtimeMs:size` (null when absent). A change means an edit that
// never went through clearDomainHintCache() (vi, git, docker cp, …).
let loadedSig = null;
// plan 60 H1: last-known-good per path — survives clearDomainHintCache() so a
// corrupt domain-hints.json can never purge a previously working set. Path-
// guarded so hints from one DOMAIN_HINTS_PATH never serve for another.
let lastGoodHints = null;
let lastGoodPath = null;
// Bumped by clearDomainHintCache — the single choke point every hint
// mutation funnels through — so callers can stamp extraction outputs with
// the hint generation that produced them (plan 60 S10).
let hintRevision = 0;

export function getHintRevision() {
  return hintRevision;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileGlob(pattern) {
  if (pattern.endsWith("/**")) {
    const prefix = escapeRegex(pattern.slice(0, -3));
    const regex = new RegExp(`^${prefix}(?:/.*)?$`);
    return (pathname) => regex.test(pathname);
  }
  const parts = pattern.split(/(\*\*|\*)/);
  let regexStr = "^";
  for (const part of parts) {
    if (part === "**") {
      regexStr += ".*";
    } else if (part === "*") {
      regexStr += "[^/]*";
    } else if (part) {
      regexStr += escapeRegex(part);
    }
  }
  regexStr += "$";
  const regex = new RegExp(regexStr);
  return (pathname) => regex.test(pathname);
}

function parsePathPattern(raw) {
  if (!raw || raw === "/**") return () => true;
  if (raw === "/*/**") return (p) => p.startsWith("/") && p !== "/";
  let normalized = raw;
  if (normalized.length > 1 && normalized.endsWith("/") && !normalized.endsWith("/**")) {
    normalized = normalized.slice(0, -1);
  }
  return compileGlob(normalized);
}

function getPathname(urlStr) {
  try {
    let p = new URL(urlStr).pathname.toLowerCase();
    if (p !== "/" && p.endsWith("/")) p = p.slice(0, -1);
    return p;
  } catch {
    return "/";
  }
}

function getHostname(urlStr) {
  try {
    return new URL(urlStr).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isMatch(entry, urlStr) {
  if (entry.domain === "*") return false;
  const hostname = getHostname(urlStr);
  const domain = entry.domain.toLowerCase();
  if (hostname !== domain && !hostname.endsWith("." + domain)) return false;
  const pathname = getPathname(urlStr);
  const pathMatcher = entry._pathMatcher || parsePathPattern(entry.pathPattern);
  entry._pathMatcher = entry._pathMatcher || pathMatcher;
  return pathMatcher(pathname);
}

export const WILDCARD_DOMAIN = "*";

export function getWildcardHint(hints) {
  if (!Array.isArray(hints)) return null;
  return hints.find((h) => h?.domain === WILDCARD_DOMAIN) || null;
}

const WILDCARD_DEFAULT_HINT = Object.freeze({
  domain: WILDCARD_DOMAIN,
  pathPattern: "/**",
  pageType: "default",
  comment: "Default extraction for all URLs. Edit in the Domain hints panel.",
  default: Object.freeze({
    format: "readability_to_markdown",
    stabilizeStrategy: "network_idle",
    waitForSelector: [],
    waitForContent: [],
    skipSelectors: []
  })
});

function buildWildcardHintFromEnv() {
  const d = {
    format: "readability_to_markdown",
    stabilizeStrategy: "network_idle",
    waitForSelector: [],
    waitForContent: [],
    skipSelectors: []
  };
  const envFormat = process.env.DEFAULT_EXTRACT_FORMAT;
  if (envFormat && typeof envFormat === "string" && envFormat.trim()) {
    const known = EXTRACTOR_FORMATS;
    const val = envFormat.trim();
    if (known.includes(val)) d.format = val;
  }
  const envStrategy = process.env.DEFAULT_EXTRACT_STABILIZE_STRATEGY;
  if (envStrategy && ["network_idle", "content_idle", "mutation", "none"].includes(envStrategy)) {
    d.stabilizeStrategy = envStrategy;
  }
  const envWaitSel = process.env.DEFAULT_EXTRACT_WAIT_FOR_SELECTOR;
  if (envWaitSel && typeof envWaitSel === "string" && envWaitSel.trim()) {
    d.waitForSelector = envWaitSel.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const envWaitContent = process.env.DEFAULT_EXTRACT_WAIT_FOR_CONTENT;
  if (envWaitContent && typeof envWaitContent === "string" && envWaitContent.trim()) {
    d.waitForContent = envWaitContent.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const envSkip = process.env.DEFAULT_EXTRACT_SKIP_SELECTORS;
  if (envSkip && typeof envSkip === "string" && envSkip.trim()) {
    d.skipSelectors = envSkip.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const envPostProcessor = process.env.DEFAULT_EXTRACT_POST_PROCESSOR;
  if (envPostProcessor && typeof envPostProcessor === "string" && envPostProcessor.trim()) {
    d.postProcessor = envPostProcessor.trim();
  }
  return {
    ...WILDCARD_DEFAULT_HINT,
    default: d
  };
}

export function ensureWildcardHint(hints) {
  if (!Array.isArray(hints)) return hints;
  if (hints.some((h) => h?.domain === WILDCARD_DOMAIN)) return hints;
  const fromEnv = buildWildcardHintFromEnv();
  hints.unshift(fromEnv);
  console.log("[domain-hints] created wildcard default hint");
  return hints;
}

// Returns the migrated hints array, or null when the file is present but
// broken (unreadable, not valid JSON, or not an array) — plan 60 H1: a broken
// file must never throw into extraction; getDomainHints() turns null into a
// last-known-good (or wildcard-only) fallback.
export async function loadDomainHints(hintsPath) {
  const resolvedPath = path.resolve(hintsPath);
  try {
    await fs.access(resolvedPath);
  } catch {
    return ensureWildcardHint([]);
  }
  let entries;
  try {
    entries = JSON.parse(await fs.readFile(resolvedPath, "utf8"));
  } catch (error) {
    console.warn(`[domain-hints] ${resolvedPath} is unreadable or not valid JSON (${error.message}) — serving last-known-good hints when cached, else the wildcard default`);
    return null;
  }
  if (!Array.isArray(entries)) {
    console.warn(`[domain-hints] ${resolvedPath} does not contain a JSON array of hints — serving last-known-good hints when cached, else the wildcard default`);
    return null;
  }
  const migrated = [];
  for (const entry of entries) {
    if (!entry || typeof entry.domain !== "string") continue;
    const { hint, warnings } = migrateHintShape(entry);
    if (warnings.length) {
      console.warn(`[domain-hints] migrated hint for ${entry.domain}: ${warnings.join("; ")}`);
    }
    migrated.push(hint);
  }
  return ensureWildcardHint(migrated);
}

export function findMatchingHints(urlStr, hints) {
  if (!urlStr || !Array.isArray(hints) || !hints.length) return [];
  const matches = [];
  for (const entry of hints) {
    if (isMatch(entry, urlStr)) matches.push(entry);
  }
  return matches;
}

export function findDomainHint(urlStr, hints) {
  return findMatchingHints(urlStr, hints)[0] || null;
}

// plan 60 H2: cheap freshness probe — pre-read (taken BEFORE loadDomainHints
// reads the file) so a change during the read is caught by the NEXT call
// instead of being recorded as newer than the content.
async function fileSignature(resolvedPath) {
  try {
    const st = await fs.stat(resolvedPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

export async function getDomainHints(config) {
  const hintsPath = config?.domainHintsPath;
  if (!hintsPath) return [];
  const resolvedPath = path.resolve(hintsPath);
  const sig = await fileSignature(resolvedPath);
  if (loadedPath === hintsPath && loadedHints !== null) {
    if (sig === loadedSig) return loadedHints;
    // plan 60 H2: the file changed outside our write path — invalidate
    // through the single choke point so hintRevision (and the web_fetch
    // cache key stamped with it) moves together with the hint set.
    clearDomainHintCache();
  }
  const loaded = await loadDomainHints(hintsPath);
  if (loaded === null) {
    // plan 60 H1: the file is broken — serve last-known-good for this exact
    // path, else degrade to wildcard-only. The fallback is cached like any
    // load result; the H2 signature check picks up an external repair on the
    // very next call.
    const fallback = (lastGoodPath === resolvedPath && lastGoodHints !== null)
      ? lastGoodHints
      : ensureWildcardHint([]);
    loadedHints = fallback;
    loadedPath = hintsPath;
    loadedSig = sig;
    return fallback;
  }
  loadedHints = loaded;
  loadedPath = hintsPath;
  loadedSig = sig;
  lastGoodHints = loaded;
  lastGoodPath = resolvedPath;
  return loaded;
}

export function clearDomainHintCache() {
  // Deliberately keeps lastGoodHints/lastGoodPath (plan 60 H1): a cache clear
  // forces a re-read; if that re-read fails, the previous good set must still
  // be servable.
  loadedHints = null;
  loadedPath = null;
  loadedSig = null;
  hintRevision += 1;
}

export function getExtractionMethod(hint) {
  if (typeof hint?.script === "string" && hint.script.trim()) return "script";
  if (Array.isArray(hint?.flow) && hint.flow.length > 0) return "flow";
  if (hint?.default !== undefined) return "default";
  return null;
}

export const SCRIPT_TIMEOUT_DEFAULT_MS = 30000;
export const SCRIPT_TIMEOUT_MAX_MS = 60000;

export function validateScript(script) {
  const errors = [];
  if (typeof script !== "string" || !script.trim()) {
    errors.push({ field: "script", message: "script must be a non-empty string" });
    return errors;
  }
  try {
    // Scripts run wrapped as `(async () => { <script> })()` so `return` is legal —
    // validate the wrapped form, not the bare body. Success means NO errors:
    // do not return the compiled Script here (callers iterate this result).
    new vm.Script(`(async () => { ${script} })()`, { filename: "validate" });
  } catch (e) {
    errors.push({ field: "script", message: `script syntax error: ${e.message}` });
  }
  return errors;
}

function validateScriptOptions(scriptOptions, errors) {
  if (scriptOptions === undefined) return;
  if (!scriptOptions || typeof scriptOptions !== "object" || Array.isArray(scriptOptions)) {
    errors.push({ field: "scriptOptions", message: "must be an object" });
    return;
  }
  if (scriptOptions.timeoutMs !== undefined) {
    if (!Number.isInteger(scriptOptions.timeoutMs) || scriptOptions.timeoutMs <= 0 || scriptOptions.timeoutMs > SCRIPT_TIMEOUT_MAX_MS) {
      errors.push({ field: "scriptOptions.timeoutMs", message: `must be an integer between 1 and ${SCRIPT_TIMEOUT_MAX_MS}` });
    }
  }
  for (const key of Object.keys(scriptOptions)) {
    if (!["timeoutMs"].includes(key)) {
      errors.push({ field: `scriptOptions.${key}`, message: "unknown field (must be timeoutMs only)" });
    }
  }
}

export function migrateHintShape(hint) {
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) return { hint, warnings: [] };
  const warnings = [];
  const out = { ...hint };

  if (out.content !== undefined) {
    const content = out.content || {};
    const blocks = (Array.isArray(content.blocks) ? content.blocks : []).concat(
      (Array.isArray(content.sections) ? content.sections : []).map((section) => ({
        ...section,
        format: out.preferReadability === false ? "html_to_markdown" : "readability_to_markdown"
      }))
    );
    if (blocks.length) {
      const steps = [];
      if (out.waitForSelector) {
        steps.push({ action: "wait", selector: out.waitForSelector, timeoutMs: 10000 });
      }
      steps.push({
        action: "extract",
        label: out.pageType || "Page content",
        content: { blocks }
      });
      out.flow = steps;
      warnings.push("static blocks (content) migrated to a single-extract-step flow");
    }
    delete out.content;
  }

  if (out.flow === undefined && out.default === undefined) {
    const legacy = {
      waitForSelector: out.waitForSelector,
      stabilizeStrategy: out.stabilizeStrategy,
      contentSelectors: out.contentSelectors,
      skipSelectors: out.skipSelectors,
      tableExtraction: out.tableExtraction,
      preferReadability: out.preferReadability
    };
    const hasLegacy = Object.values(legacy).some((value) => value !== undefined && value !== "");
    if (hasLegacy) {
      out.default = {};
      warnings.push("top-level page-load / extraction fields migrated to default");
      if (out.preferReadability !== undefined) {
        out.default.format = out.preferReadability === false ? "html_to_markdown" : "readability_to_markdown";
      }
      if (out.tableExtraction !== undefined) {
        warnings.push("tableExtraction removed — tables are rendered by the extractor now");
      }
      if (out.waitForSelector !== undefined) out.default.waitForSelector = out.waitForSelector;
      if (out.stabilizeStrategy !== undefined) out.default.stabilizeStrategy = out.stabilizeStrategy;
      if (out.contentSelectors !== undefined) out.default.waitForContent = out.contentSelectors;
      if (out.skipSelectors !== undefined) out.default.skipSelectors = out.skipSelectors;
    }
  }

  if (out.default !== undefined && typeof out.default === "object" && !Array.isArray(out.default)) {
    const def = out.default;
    if (def.readability !== undefined) {
      if (def.format === undefined) {
        def.format = def.readability === false ? "html_to_markdown" : "readability_to_markdown";
      }
      delete def.readability;
    }
    if (def.format === undefined) def.format = "readability_to_markdown";
    {
      const { format: coercedFormat, coerced } = coerceLegacyFormat(def.format);
      if (coerced) {
        warnings.push(`default.format "${def.format}" is a legacy model id — coerced to readability_to_markdown`);
        def.format = coercedFormat;
      }
    }
    if (def.tables !== undefined) {
      if (def.tables !== "" && def.tables !== "all") {
        warnings.push(`default.tables ("${def.tables}") removed — tables are rendered by the extractor now`);
      }
      delete def.tables;
    }
  }

  if (Array.isArray(out.flow)) {
    for (const step of out.flow) {
      if (step.action === "extract" && step.content?.blocks) {
        for (const block of step.content.blocks) {
          if (block.format) {
            const { format: coercedFormat, coerced } = coerceLegacyFormat(block.format);
            if (coerced) {
              warnings.push(`block.format "${block.format}" is a legacy model id — coerced to readability_to_markdown`);
              block.format = coercedFormat;
            }
          }
        }
      }
    }
  }

  delete out.preferReadability;
  delete out.contentSelectors;
  delete out.skipSelectors;
  delete out.waitForSelector;
  delete out.stabilizeStrategy;
  delete out.tableExtraction;

  return { hint: out, warnings };
}

export function validateSelector(selector) {
  const dom = new JSDOM("<body></body>");
  try {
    dom.window.document.querySelectorAll(selector);
    return null;
  } catch (error) {
    return error?.message || String(error);
  } finally {
    dom.window.close();
  }
}

export const BLOCK_FORMATS = [
  "text",
  "list",
  ...EXTRACTOR_FORMATS.filter((f) => f !== "text")
];

export const DEFAULT_FORMATS = EXTRACTOR_FORMATS;

const LEGACY_MARKDOWN_FORMAT = "markdown";

function coerceLegacyFormat(format) {
  if (!format || typeof format !== "string") return { format, coerced: false };
  if (DEFAULT_FORMATS.includes(format) || BLOCK_FORMATS.includes(format) || format === LEGACY_MARKDOWN_FORMAT) {
    return { format, coerced: false };
  }
  return { format: "readability_to_markdown", coerced: true };
}

export const FIELD_FORMATS = [
  "text",
  "list",
  "markdown",
  "html",
  "html_to_markdown",
  "readability_to_markdown"
];

export const FLOW_ACTIONS = ["extract", "click", "wait", "type", "navigate"];
export const FLOW_MAX_STEPS = 8;
export const FLOW_MAX_CLICKS = 4;
export const FLOW_TIMEOUT_MIN = 250;
export const FLOW_TIMEOUT_MAX = 20000;
export const FLOW_TOTAL_TIMEOUT_MAX = 45000;
export const FLOW_STATES = ["visible", "attached", "hidden"];

const FLOW_ACTION_KEYS = {
  extract: ["action", "label", "content"],
  click: ["action", "selector", "waitForSelector", "timeoutMs", "stabilizeStrategy"],
  wait: ["action", "selector", "state", "timeoutMs", "stabilizeStrategy"],
  type: ["action", "selector", "text", "clear", "submit", "waitForSelector", "timeoutMs", "stabilizeStrategy"],
  navigate: ["action", "url", "waitForSelector", "timeoutMs", "stabilizeStrategy"]
};

const FLOW_INTERACTION_ACTIONS = new Set(["click", "type", "navigate"]);

function validateSelectorField(step, key, errors, prefix) {
  if (step[key] === undefined) {
    errors.push({ field: `${prefix}.${key}`, message: "required" });
    return;
  }
  if (typeof step[key] !== "string" || !step[key].trim()) {
    errors.push({ field: `${prefix}.${key}`, message: "must be a non-empty CSS selector string" });
    return;
  }
  const selectorError = validateSelector(step[key]);
  if (selectorError) errors.push({ field: `${prefix}.${key}`, message: `invalid CSS selector: ${selectorError}` });
}

function validateField(field, errors, fieldPrefix) {
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    errors.push({ field: fieldPrefix, message: "must be an object" });
    return;
  }
  const prefix = `${fieldPrefix}.`;
  if (typeof field.selector !== "string" || !field.selector) {
    errors.push({ field: `${prefix}selector`, message: "required" });
  } else {
    const selectorError = validateSelector(field.selector);
    if (selectorError) errors.push({ field: `${prefix}selector`, message: `invalid CSS selector: ${selectorError}` });
  }
  if (field.label !== undefined && typeof field.label !== "string") {
    errors.push({ field: `${prefix}label`, message: "must be a string (optional — blank means no label in output)" });
  }
  if (field.format !== undefined && !FIELD_FORMATS.includes(field.format)) {
    errors.push({ field: `${prefix}format`, message: `must be one of ${FIELD_FORMATS.map((f) => `"${f}"`).join(", ")}` });
  }
}

function validateBlock(block, errors, fieldPrefix, aiModelIds, warnings = []) {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    errors.push({ field: fieldPrefix, message: "must be an object" });
    return;
  }
  const prefix = `${fieldPrefix}.`;
  if (typeof block.selector !== "string" || !block.selector) {
    errors.push({ field: `${prefix}selector`, message: "required" });
  } else {
    const selectorError = validateSelector(block.selector);
    if (selectorError) errors.push({ field: `${prefix}selector`, message: `invalid CSS selector: ${selectorError}` });
  }
  if (block.label !== undefined && typeof block.label !== "string") {
    errors.push({ field: `${prefix}label`, message: "must be a string (optional — blank means no heading in output)" });
  }
  if (block.priority !== undefined && !["high", "medium", "low"].includes(block.priority)) {
    errors.push({ field: `${prefix}priority`, message: 'must be one of "high", "medium", "low"' });
  }

  const hasFormat = block.format !== undefined;
  const hasFields = block.fields !== undefined;
  if (hasFormat === hasFields) {
    errors.push({
      field: fieldPrefix,
      message: 'must be a leaf block (with "format") or a record block (with "fields"), not both or neither'
    });
    return;
  }

  if (hasFormat) {
    if (!BLOCK_FORMATS.includes(block.format) && block.format !== LEGACY_MARKDOWN_FORMAT) {
      const aiPointer = Array.isArray(aiModelIds) && aiModelIds.includes(block.format)
        ? ` — "${block.format}" is a POST_PROCESSOR_MODELS id; AI models run as "postProcessor", not as an extractor format`
        : "";
      errors.push({ field: `${prefix}format`, message: `must be one of ${BLOCK_FORMATS.map((f) => `"${f}"`).join(", ")}${aiPointer}` });
    }
    if (block.postProcessor !== undefined) {
      if (typeof block.postProcessor !== "string" || !block.postProcessor.trim()) {
        errors.push({ field: `${prefix}postProcessor`, message: "optional; when present must be a non-empty string (model id from POST_PROCESSOR_MODELS)" });
      } else if (Array.isArray(aiModelIds) && !aiModelIds.includes(block.postProcessor.trim())) {
        warnings.push({ field: `${prefix}postProcessor`, message: `post-processor model "${block.postProcessor.trim()}" is not configured (POST_PROCESSOR_MODELS) — fetches keep the raw extractor output` });
      }
    }
    return;
  }

  if (block.itemLabel !== undefined && typeof block.itemLabel !== "string") {
    errors.push({ field: `${prefix}itemLabel`, message: "must be a string" });
  }
  if (!Array.isArray(block.fields) || !block.fields.length) {
    errors.push({ field: `${prefix}fields`, message: "must be a non-empty array of leaf blocks" });
  } else {
    block.fields.forEach((field, index) => {
      validateField(field, errors, `${prefix}fields[${index}]`);
    });
  }
}

function validateContent(content, errors, fieldPrefix, warnings, aiModelIds) {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    errors.push({ field: fieldPrefix, message: "must be an object with a blocks array" });
    return;
  }
  if (content.blocks !== undefined) {
    if (!Array.isArray(content.blocks) || !content.blocks.length) {
      errors.push({ field: `${fieldPrefix}.blocks`, message: "must be a non-empty array" });
    } else {
      content.blocks.forEach((block, index) => {
        validateBlock(block, errors, `${fieldPrefix}.blocks[${index}]`, aiModelIds, warnings);
      });
    }
  }
  if (content.sections !== undefined) {
    if (!Array.isArray(content.sections)) {
      errors.push({ field: `${fieldPrefix}.sections`, message: "must be an array" });
    } else {
      content.sections.forEach((section, index) => {
        validateSection(section, errors, `${fieldPrefix}.sections[${index}]`);
      });
    }
  }
  if (content.blocks?.length && content.sections?.length) {
    warnings.push({ field: fieldPrefix, message: 'contains both "blocks" and legacy "sections" — blocks take priority' });
  }
}

function validateFlow(flow, errors, warnings, fieldPrefix = "flow", aiModelIds) {
  if (!Array.isArray(flow) || !flow.length) {
    errors.push({ field: fieldPrefix, message: "must be a non-empty array of steps" });
    return;
  }
  if (flow.length > FLOW_MAX_STEPS) {
    errors.push({ field: fieldPrefix, message: `must have at most ${FLOW_MAX_STEPS} steps (got ${flow.length})` });
    return;
  }

  let clickCount = 0;
  let extractCount = 0;
  let prevAction = null;
  flow.forEach((step, index) => {
    const stepField = `${fieldPrefix}[${index}]`;
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      errors.push({ field: stepField, message: "must be an object" });
      return;
    }
    const action = step.action;
    if (!FLOW_ACTIONS.includes(action)) {
      errors.push({ field: `${stepField}.action`, message: `must be one of ${FLOW_ACTIONS.map((a) => `"${a}"`).join(", ")}` });
      return;
    }

    const allowed = FLOW_ACTION_KEYS[action];
    for (const key of Object.keys(step)) {
      if (!allowed.includes(key)) {
        warnings.push({ field: `${stepField}.${key}`, message: `unknown property for "${action}" step (ignored)` });
      }
    }

    if (step.timeoutMs !== undefined) {
      if (!Number.isInteger(step.timeoutMs) || step.timeoutMs < FLOW_TIMEOUT_MIN || step.timeoutMs > FLOW_TIMEOUT_MAX) {
        errors.push({ field: `${stepField}.timeoutMs`, message: `must be an integer between ${FLOW_TIMEOUT_MIN} and ${FLOW_TIMEOUT_MAX}` });
      }
    }

    if (step.stabilizeStrategy !== undefined && step.stabilizeStrategy !== "" && !STEP_STABILIZE_STRATEGIES.includes(step.stabilizeStrategy)) {
      errors.push({ field: `${stepField}.stabilizeStrategy`, message: `must be one of ${STEP_STABILIZE_STRATEGIES.map((s) => `"${s}"`).join(", ")}` });
    }

    if (action === "extract") {
      extractCount += 1;
      if (step.label !== undefined && (typeof step.label !== "string" || step.label.length > 80)) {
        errors.push({ field: `${stepField}.label`, message: "optional; when present must be a string up to 80 characters" });
      }
      if (step.content === undefined) {
        errors.push({ field: `${stepField}.content`, message: "required" });
      } else {
        validateContent(step.content, errors, `${stepField}.content`, warnings, aiModelIds);
      }
    } else if (action === "click") {
      clickCount += 1;
      validateSelectorField(step, "selector", errors, stepField);
      if (step.waitForSelector !== undefined) {
        validateSelectorField(step, "waitForSelector", errors, stepField);
      }
    } else if (action === "wait") {
      if (step.selector !== undefined && step.selector !== "") {
        validateSelectorField(step, "selector", errors, stepField);
      }
      if (step.state !== undefined && !FLOW_STATES.includes(step.state)) {
        errors.push({ field: `${stepField}.state`, message: `must be one of ${FLOW_STATES.map((s) => `"${s}"`).join(", ")}` });
      }
    } else if (action === "type") {
      validateSelectorField(step, "selector", errors, stepField);
      if (typeof step.text !== "string" || !step.text) {
        errors.push({ field: `${stepField}.text`, message: "required" });
      }
      if (step.clear !== undefined && typeof step.clear !== "boolean") {
        errors.push({ field: `${stepField}.clear`, message: "must be a boolean" });
      }
      if (step.submit !== undefined && typeof step.submit !== "boolean") {
        errors.push({ field: `${stepField}.submit`, message: "must be a boolean" });
      }
      if (step.submit === true && step.waitForSelector === undefined) {
        errors.push({ field: `${stepField}.waitForSelector`, message: 'required when "submit" is true' });
      }
      if (step.waitForSelector !== undefined) {
        validateSelectorField(step, "waitForSelector", errors, stepField);
      }
    } else if (action === "navigate") {
      if (typeof step.url !== "string" || !step.url.trim()) {
        errors.push({ field: `${stepField}.url`, message: "required" });
      } else {
        try {
          new URL(step.url, "https://example.com");
        } catch {
          errors.push({ field: `${stepField}.url`, message: "must be an absolute or relative URL" });
        }
      }
      validateSelectorField(step, "waitForSelector", errors, stepField);
    }

    if (prevAction && FLOW_INTERACTION_ACTIONS.has(action) && FLOW_INTERACTION_ACTIONS.has(prevAction)) {
      errors.push({
        field: stepField,
        message: `a "${prevAction}" step cannot be followed by a "${action}" step — an extract or wait must separate them`
      });
    }
    prevAction = action;
  });

  if (extractCount === 0) {
    errors.push({ field: fieldPrefix, message: "must contain at least one extract step" });
  }
  const last = flow[flow.length - 1];
  if (last?.action !== "extract") {
    errors.push({ field: fieldPrefix, message: "must end with an extract step" });
  }
  if (clickCount > FLOW_MAX_CLICKS) {
    errors.push({ field: fieldPrefix, message: `must contain at most ${FLOW_MAX_CLICKS} click steps (got ${clickCount})` });
  }
}

function validateFlowOptions(hint, errors, warnings) {
  if (hint.flowOptions === undefined) return;
  const flowOptions = hint.flowOptions;
  if (!flowOptions || typeof flowOptions !== "object" || Array.isArray(flowOptions)) {
    errors.push({ field: "flowOptions", message: "must be an object" });
    return;
  }
  if (flowOptions.totalTimeoutMs !== undefined) {
    if (!Number.isInteger(flowOptions.totalTimeoutMs) || flowOptions.totalTimeoutMs <= 0 || flowOptions.totalTimeoutMs > FLOW_TOTAL_TIMEOUT_MAX) {
      errors.push({ field: "flowOptions.totalTimeoutMs", message: `must be an integer between 1 and ${FLOW_TOTAL_TIMEOUT_MAX}` });
    }
  }
  if (flowOptions.continueOnEmptyExtract !== undefined && typeof flowOptions.continueOnEmptyExtract !== "boolean") {
    errors.push({ field: "flowOptions.continueOnEmptyExtract", message: "must be a boolean" });
  }
  for (const key of Object.keys(flowOptions)) {
    if (!["totalTimeoutMs", "continueOnEmptyExtract"].includes(key)) {
      warnings.push({ field: `flowOptions.${key}`, message: "unknown field (ignored)" });
    }
  }
}

function validateSection(section, errors, fieldPrefix) {
  if (!section || typeof section !== "object") {
    errors.push({ field: fieldPrefix, message: "must be an object" });
    return;
  }
  const prefix = `${fieldPrefix}.`;
  if (typeof section.selector !== "string" || !section.selector) {
    errors.push({ field: `${prefix}selector`, message: "required" });
  } else {
    const selectorError = validateSelector(section.selector);
    if (selectorError) errors.push({ field: `${prefix}selector`, message: `invalid CSS selector: ${selectorError}` });
  }
  if (section.label !== undefined && typeof section.label !== "string") {
    errors.push({ field: `${prefix}label`, message: "must be a string (optional — blank means no heading in output)" });
  }
  if (section.priority !== undefined && !["high", "medium", "low"].includes(section.priority)) {
    errors.push({ field: `${prefix}priority`, message: 'must be one of "high", "medium", "low"' });
  }
  if (section.itemLabel !== undefined && typeof section.itemLabel !== "string") {
    errors.push({ field: `${prefix}itemLabel`, message: "must be a string" });
  }
  for (const [fieldIndex, field] of (section.fields || []).entries()) {
    const fieldPrefix2 = `${prefix}fields[${fieldIndex}]`;
    if (!field || typeof field !== "object") {
      errors.push({ field: fieldPrefix2, message: "must be an object" });
      continue;
    }
    if (typeof field.selector !== "string" || !field.selector) {
      errors.push({ field: `${fieldPrefix2}.selector`, message: "required" });
    } else {
      const selectorError = validateSelector(field.selector);
      if (selectorError) errors.push({ field: `${fieldPrefix2}.selector`, message: `invalid CSS selector: ${selectorError}` });
    }
    if (field.label !== undefined && typeof field.label !== "string") {
      errors.push({ field: `${fieldPrefix2}.label`, message: "must be a string (optional — blank means no label in output)" });
    }
    if (field.format !== undefined && !["markdown", "text", "list"].includes(field.format)) {
      errors.push({ field: `${fieldPrefix2}.format`, message: 'must be one of "markdown", "text", "list"' });
    }
  }
}

const STABILIZE_STRATEGIES = ["none", "network_idle", "content_idle", "mutation"];
const STEP_STABILIZE_STRATEGIES = STABILIZE_STRATEGIES;
const TOP_LEVEL_KEYS = [
  "domain", "pathPattern", "pageType", "comment", "testUrls",
  "requireSelector", "browserEngine", "default", "flow", "flowOptions",
  "script", "scriptOptions"
];
const LEGACY_TOP_LEVEL_KEYS = {
  waitForSelector: "moved into default.waitForSelector",
  stabilizeStrategy: "moved into default.stabilizeStrategy",
  contentSelectors: "moved into default.waitForContent",
  skipSelectors: "moved into default.skipSelectors",
  preferReadability: 'moved into default.format (see the format dropdown)',
  tableExtraction: "moved into default.tables",
  content: 'removed — static blocks now live inside a flow as a single "extract" step'
};

function validateSelectorArray(hint, key, errors) {
  if (!Array.isArray(hint[key])) {
    errors.push({ field: `default.${key}`, message: "must be an array of CSS selectors" });
    return;
  }
  hint[key].forEach((selector, index) => {
    const field = `default.${key}[${index}]`;
    if (typeof selector !== "string") {
      errors.push({ field, message: "must be a string" });
      return;
    }
    const selectorError = validateSelector(selector);
    if (selectorError) errors.push({ field, message: `invalid CSS selector: ${selectorError}` });
  });
}

function validateDefault(defaultBlock, errors, warnings, aiModelIds) {
  if (!defaultBlock || typeof defaultBlock !== "object" || Array.isArray(defaultBlock)) {
    errors.push({ field: "default", message: "must be an object" });
    return;
  }

  if (defaultBlock.waitForSelector !== undefined) {
    const selectors = Array.isArray(defaultBlock.waitForSelector)
      ? defaultBlock.waitForSelector
      : [defaultBlock.waitForSelector];
    selectors.forEach((selector, index) => {
      const field = Array.isArray(defaultBlock.waitForSelector)
        ? `default.waitForSelector[${index}]`
        : "default.waitForSelector";
      if (typeof selector !== "string") {
        errors.push({ field, message: "must be a string" });
      } else if (selector.trim()) {
        const selectorError = validateSelector(selector);
        if (selectorError) errors.push({ field, message: `invalid CSS selector: ${selectorError}` });
      }
    });
  }

  if (defaultBlock.stabilizeStrategy !== undefined && defaultBlock.stabilizeStrategy !== "" && !STABILIZE_STRATEGIES.includes(defaultBlock.stabilizeStrategy)) {
    errors.push({ field: "default.stabilizeStrategy", message: `must be one of ${STABILIZE_STRATEGIES.map((s) => `"${s}"`).join(", ")}` });
  }
  if (defaultBlock.waitForContent !== undefined) validateSelectorArray(defaultBlock, "waitForContent", errors);
  if (defaultBlock.skipSelectors !== undefined) validateSelectorArray(defaultBlock, "skipSelectors", errors);

  if (defaultBlock.format !== undefined) {
    if (!DEFAULT_FORMATS.includes(defaultBlock.format)) {
      const aiPointer = Array.isArray(aiModelIds) && aiModelIds.includes(defaultBlock.format)
        ? ` — "${defaultBlock.format}" is a POST_PROCESSOR_MODELS id; AI models run as "postProcessor", not as an extractor format`
        : "";
      errors.push({ field: "default.format", message: `must be one of ${DEFAULT_FORMATS.map((f) => `"${f}"`).join(", ")}${aiPointer}` });
    }
  }
  if (defaultBlock.postProcessor !== undefined) {
    if (typeof defaultBlock.postProcessor !== "string" || !defaultBlock.postProcessor.trim()) {
      errors.push({ field: "default.postProcessor", message: "optional; when present must be a non-empty string (model id from POST_PROCESSOR_MODELS)" });
    } else if (Array.isArray(aiModelIds) && !aiModelIds.includes(defaultBlock.postProcessor.trim())) {
      warnings.push({ field: "default.postProcessor", message: `post-processor model "${defaultBlock.postProcessor.trim()}" is not configured (POST_PROCESSOR_MODELS) — fetches keep the raw extractor output` });
    }
  }
  if (defaultBlock.readability !== undefined) {
    warnings.push({ field: "default.readability", message: 'replaced by "format" — use "readability_to_markdown" or "html_to_markdown"' });
  }
  for (const key of Object.keys(defaultBlock)) {
    if (!["waitForSelector", "stabilizeStrategy", "waitForContent", "skipSelectors", "format", "postProcessor"].includes(key)) {
      if (key === "tables") {
        if (defaultBlock.tables !== "" && defaultBlock.tables !== "all") {
          warnings.push({ field: "default.tables", message: 'removed — tables are rendered by the extractor now (delete this key); the "table" / "table_json" / "table_csv" extractors return tables-only output' });
        }
      } else {
        warnings.push({ field: `default.${key}`, message: "unknown field (ignored)" });
      }
    }
  }
}

// aiModelIds: the configured post-processor model ids (POST_PROCESSOR_MODELS).
// null (default) means "the configured set is unknown" — extractor-format
// validation then accepts base formats only and postProcessor membership
// warnings are skipped. Callers that know the configured set pass the id list
// (including [] when no models are configured) so dangling postProcessor
// references are flagged (plan 60 S3).
export function validateHintRule(hint, { scope = "static", aiModelIds = null, browserNames = null } = {}) {
  const errors = [];
  const warnings = [];
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
    return { errors: [{ field: "", message: "hint must be an object" }], warnings: [] };
  }
  const isTest = scope === "test";
  const isWildcard = hint.domain === WILDCARD_DOMAIN;

  if (!isTest && (typeof hint.domain !== "string" || !hint.domain)) {
    errors.push({ field: "domain", message: "required" });
  } else if (hint.domain !== undefined && !isWildcard && !/^[a-z0-9.-]+$/.test(hint.domain)) {
    errors.push({ field: "domain", message: "must match /^[a-z0-9.-]+$/ (lowercase letters, digits, dots, dashes)" });
  } else if (isWildcard && hint.domain !== WILDCARD_DOMAIN) {
    errors.push({ field: "domain", message: `must be "${WILDCARD_DOMAIN}" for wildcard hints` });
  }

  if (!isTest && !isWildcard && (typeof hint.pathPattern !== "string" || !hint.pathPattern)) {
    errors.push({ field: "pathPattern", message: 'required (default "/**")' });
  } else if (isWildcard) {
    // wildcard hint always uses /** — pathPattern is ignored
  } else if (hint.pathPattern !== undefined && !hint.pathPattern.startsWith("/")) {
    errors.push({ field: "pathPattern", message: "must start with \"/\"" });
  }

  if (hint.pageType !== undefined && typeof hint.pageType !== "string") {
    errors.push({ field: "pageType", message: "must be a string" });
  }
  if (hint.comment !== undefined && typeof hint.comment !== "string") {
    errors.push({ field: "comment", message: "must be a string" });
  }

  if (hint.testUrls !== undefined) {
    if (!Array.isArray(hint.testUrls)) {
      errors.push({ field: "testUrls", message: "must be an array of URLs" });
    } else {
      hint.testUrls.forEach((testUrl, index) => {
        if (typeof testUrl !== "string" || !/^https?:\/\//.test(testUrl)) {
          errors.push({ field: `testUrls[${index}]`, message: "must be an http:// or https:// URL" });
        }
      });
    }
  }

  if (hint.browserEngine !== undefined) {
    if (typeof hint.browserEngine !== "string" || !hint.browserEngine.trim()) {
      errors.push({ field: "browserEngine", message: "optional; when present must be a non-empty string (a configured browser name)" });
    } else if (!/^[a-z0-9_-]+$/i.test(hint.browserEngine)) {
      errors.push({ field: "browserEngine", message: "must match /^[a-z0-9_-]+$/i (letters, digits, dashes, underscores)" });
    } else if (browserNames && hint.browserEngine !== "chromium" && !browserNames.includes(hint.browserEngine)) {
      errors.push({ field: "browserEngine", message: `"${hint.browserEngine}" is not a configured browser (BROWSERS names: ${browserNames.join(", ")})` });
    }
  }

  if (!isWildcard && hint.requireSelector !== undefined) {
    if (typeof hint.requireSelector !== "string") {
      errors.push({ field: "requireSelector", message: "must be a string" });
    } else if (hint.requireSelector.trim()) {
      const selectorError = validateSelector(hint.requireSelector);
      if (selectorError) errors.push({ field: "requireSelector", message: `invalid CSS selector: ${selectorError}` });
    }
  } else if (isWildcard && hint.requireSelector !== undefined) {
    errors.push({ field: "requireSelector", message: "not allowed on wildcard hints" });
  }

  for (const [key, message] of Object.entries(LEGACY_TOP_LEVEL_KEYS)) {
    if (hint[key] !== undefined) {
      errors.push({ field: key, message });
    }
  }

  const methodKeys = ["default", "flow", "script"].filter((key) => hint[key] !== undefined);
  if (isWildcard && (hint.flow !== undefined || hint.script !== undefined)) {
    if (hint.flow !== undefined) {
      errors.push({ field: "flow", message: "wildcard hints only support default extraction (no flow)" });
    }
    if (hint.script !== undefined) {
      errors.push({ field: "script", message: "wildcard hints only support default extraction (no script)" });
    }
  } else if (methodKeys.length > 1) {
    for (const key of methodKeys) {
      errors.push({ field: key, message: 'choose exactly one extraction method: "default", "flow", or "script"' });
    }
  }

  if (hint.script !== undefined) {
    for (const e of validateScript(hint.script)) errors.push(e);
  }
  if (hint.scriptOptions !== undefined) {
    validateScriptOptions(hint.scriptOptions, errors);
  }
  if (hint.scriptOptions !== undefined && hint.script === undefined) {
    errors.push({ field: "scriptOptions", message: 'requires "script" to be set' });
  }

  if (hint.default !== undefined) {
    validateDefault(hint.default, errors, warnings, aiModelIds);
  }
  if (!isWildcard && hint.flow !== undefined) {
    validateFlow(hint.flow, errors, warnings, "flow", aiModelIds);
  }
  validateFlowOptions(hint, errors, warnings);

  for (const key of Object.keys(hint)) {
    if (TOP_LEVEL_KEYS.includes(key) || Object.prototype.hasOwnProperty.call(LEGACY_TOP_LEVEL_KEYS, key)) continue;
    warnings.push({ field: key, message: "unknown field (ignored)" });
  }

  return { errors, warnings };
}

// Collect every postProcessor model reference in a hint as { field, model }.
// Used after POST_PROCESSOR_MODELS changes to warn that a saved hint still
// points at a model id that is no longer configured (plan 60 S3) — the hint is
// kept (hints survive model removal/rename) but fetches skip post-processing.
export function collectPostProcessorRefs(hint) {
  const refs = [];
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) return refs;
  const visit = (block, field) => {
    if (block && typeof block.postProcessor === "string" && block.postProcessor.trim()) {
      refs.push({ field, model: block.postProcessor.trim() });
    }
  };
  visit(hint.default, "default.postProcessor");
  // Legacy top-level content shape — migrateHintShape converts it on load, but
  // loadRawDomainHints (used by config-save checks) does not migrate.
  if (Array.isArray(hint.content?.blocks)) {
    hint.content.blocks.forEach((block, blockIndex) => visit(block, `content.blocks[${blockIndex}].postProcessor`));
  }
  if (Array.isArray(hint.flow)) {
    hint.flow.forEach((step, index) => {
      const blocks = step?.content?.blocks;
      if (Array.isArray(blocks)) {
        blocks.forEach((block, blockIndex) => visit(block, `flow[${index}].content.blocks[${blockIndex}].postProcessor`));
      }
    });
  }
  return refs;
}

export async function saveDomainHints(hints, hintsPath) {
  const resolvedPath = path.resolve(hintsPath);
  if (resolvedPath === "/dev/null") {
    return { ok: false, error: "hints file is /dev/null — cannot save (hints are disabled via DOMAIN_HINTS_PATH)" };
  }
  if (!Array.isArray(hints)) {
    return { ok: false, error: "hints must be an array" };
  }
  const dir = path.dirname(resolvedPath);
  const tmpPath = path.join(dir, `.${path.basename(resolvedPath)}.tmp-${process.pid}-${Date.now()}`);
  try {
    let previous = "";
    try {
      previous = await fs.readFile(resolvedPath, "utf8");
    } catch {}
    if (previous) {
      await fs.writeFile(`${resolvedPath}.bak`, previous, "utf8");
    }
    await fs.writeFile(tmpPath, JSON.stringify(hints, null, 2) + "\n", "utf8");
    await fs.rename(tmpPath, resolvedPath);
    clearDomainHintCache();
    return { ok: true, count: hints.length, hintsPath: resolvedPath };
  } catch (error) {
    try {
      await fs.unlink(tmpPath);
    } catch {}
    return { ok: false, error: String(error?.message || error) };
  }
}

export async function loadRawDomainHints(hintsPath) {
  const resolvedPath = path.resolve(hintsPath);
  try {
    await fs.access(resolvedPath);
  } catch {
    return [];
  }
  const raw = await fs.readFile(resolvedPath, "utf8");
  const entries = JSON.parse(raw);
  return Array.isArray(entries) ? entries : [];
}

// ── Managed script-hint store (plan 62) ─────────────────────────────────────
// Runtime overlay for persisted *script* customizations, managed through the
// `web_fetch_setup` tool. Declarative hints stay in domain-hints.json; this
// store never touches the static file.

export const MANAGED_HINT_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MANAGED_PRIORITY_DEFAULT = 50;
const MANAGED_PRIORITY_MIN = 0;
const MANAGED_PRIORITY_MAX = 100;

let managedHintsCache = null; // { path, entries, revision }
let managedWriteQueue = Promise.resolve();

export function getManagedHintsPath(config) {
  const custom = config?.domainHintsManagedPath || process.env.DOMAIN_HINTS_MANAGED_PATH;
  if (custom) return path.resolve(custom);
  return path.resolve(process.cwd(), "data", "domain-hints.managed.json");
}

export function clearManagedHintCache() {
  managedHintsCache = null;
}

export function getManagedHintsRevision() {
  return managedHintsCache?.revision || 0;
}

async function readManagedEntries(resolvedPath) {
  try {
    await fs.access(resolvedPath);
  } catch {
    return [];
  }
  const raw = await fs.readFile(resolvedPath, "utf8");
  const entries = JSON.parse(raw);
  return Array.isArray(entries) ? entries : [];
}

export async function loadManagedHints(hintsPath) {
  const resolvedPath = path.resolve(hintsPath);
  if (managedHintsCache && managedHintsCache.path === resolvedPath) return managedHintsCache;
  const entries = await readManagedEntries(resolvedPath);
  managedHintsCache = { path: resolvedPath, entries, revision: managedHintsCache?.revision || 0 };
  return managedHintsCache;
}

export function validateManagedHint(hint) {
  const errors = [];
  const warnings = [];
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
    return { errors: [{ field: "", message: "hint must be an object" }], warnings };
  }
  if (typeof hint.id !== "string" || !MANAGED_HINT_ID_RE.test(hint.id)) {
    errors.push({ field: "id", message: "required, must match /^[a-z0-9][a-z0-9-]{0,79}$/" });
  }
  if (hint.enabled !== undefined && typeof hint.enabled !== "boolean") {
    errors.push({ field: "enabled", message: "must be a boolean" });
  }
  if (hint.priority !== undefined && (!Number.isInteger(hint.priority) || hint.priority < MANAGED_PRIORITY_MIN || hint.priority > MANAGED_PRIORITY_MAX)) {
    errors.push({ field: "priority", message: `must be an integer between ${MANAGED_PRIORITY_MIN} and ${MANAGED_PRIORITY_MAX}` });
  }
  if (hint.script === undefined) {
    errors.push({ field: "script", message: 'managed entries must carry "script" (this store holds script customizations only)' });
  } else if (hint.default !== undefined || hint.flow !== undefined) {
    errors.push({ field: "script", message: 'choose exactly one extraction method: managed entries support "script" only' });
  }
  const { errors: ruleErrors, warnings: ruleWarnings } = validateHintRule(hint, { scope: "static" });
  errors.push(...ruleErrors);
  warnings.push(...ruleWarnings);
  return { errors, warnings };
}

function managedPathSpecificity(pattern) {
  return String(pattern || "").replace(/\*/g, "").length;
}

export function sortManagedHints(entries) {
  return [...entries]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const pa = Number.isInteger(a.entry?.priority) ? a.entry.priority : MANAGED_PRIORITY_DEFAULT;
      const pb = Number.isInteger(b.entry?.priority) ? b.entry.priority : MANAGED_PRIORITY_DEFAULT;
      if (pb !== pa) return pb - pa;
      const sa = managedPathSpecificity(a.entry?.pathPattern);
      const sb = managedPathSpecificity(b.entry?.pathPattern);
      if (sb !== sa) return sb - sa;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

export function findMatchingManagedHints(urlStr, entries) {
  if (!urlStr || !Array.isArray(entries) || !entries.length) return [];
  const enabled = entries.filter((e) => e && e.enabled !== false && typeof e.script === "string");
  return sortManagedHints(findMatchingHints(urlStr, enabled));
}

export async function mutateManagedHints(hintsPath, mutator) {
  const resolvedPath = path.resolve(hintsPath);
  const run = async () => {
    const before = await loadManagedHints(resolvedPath);
    // JSON round-trip (not structuredClone): matching memoizes compiled
    // RegExp functions (_pathMatcher) onto cached entries, which clone rejects.
    const working = JSON.parse(JSON.stringify(before.entries));
    const result = mutator(working) || {};
    for (const entry of working) {
      const { errors } = validateManagedHint(entry);
      if (errors.length) {
        throw new Error(`Invalid managed hint "${entry?.id || "?"}": ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`);
      }
    }
    const dir = path.dirname(resolvedPath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, `.${path.basename(resolvedPath)}.tmp-${process.pid}-${Date.now()}`);
    try {
      await fs.writeFile(tmpPath, JSON.stringify(working, null, 2) + "\n", { mode: 0o600 });
      await fs.rename(tmpPath, resolvedPath);
    } catch (error) {
      try {
        await fs.unlink(tmpPath);
      } catch {}
      throw error;
    }
    managedHintsCache = { path: resolvedPath, entries: working, revision: (managedHintsCache?.revision || 0) + 1 };
    clearDomainHintCache();
    return { entries: working, revision: managedHintsCache.revision, ...result };
  };
  const queued = managedWriteQueue.then(run, run);
  managedWriteQueue = queued.catch(() => {});
  return queued;
}

export function compileScriptSource(script) {
  if (typeof script !== "string") {
    throw new TypeError("script must be a string");
  }
  try {
    return new vm.Script(`(async () => { ${script} })()`, { filename: "script" });
  } catch (e) {
    const err = new Error(e.message);
    err.cause = e;
    throw err;
  }
}
