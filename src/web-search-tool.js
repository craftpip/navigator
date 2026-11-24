/**
 * The `web_search` MCP tool surface: request validation, the advertised input
 * schema, response rendering and the result-cache policy. The search itself
 * (engine routing, fallback, merging) lives in search.js; this module only
 * translates between MCP arguments / markdown and the search payload.
 *
 * Search payload contract (from browserSearch):
 *   single query → { query, results, directAnswers, errors, fallbackNotes, fallback? }
 *   multi query  → { queries, results (merged, with queryVariants), directAnswers,
 *                    queryResults: [single-query entries] }
 * `errors` are failures the caller has to deal with; `fallbackNotes` are
 * engines that failed before another engine answered (recovered).
 * Each error/note is { engine, route, kind: "error" | "no_results" | "skipped", error }.
 */
import { SUPPORTED_ENGINES } from "./engines/index.js";

export const SELECT_BEST_ENGINE = "select_best";
const MAX_QUERIES = 6;
const MAX_QUERY_LENGTH = 500;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export function parseSearchLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export class WebSearchRequest {
  /** Valid `engine` values: automatic selection plus every registered route. */
  static engineNames() {
    return [SELECT_BEST_ENGINE, ...SUPPORTED_ENGINES];
  }

  static inputSchema() {
    return {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: `One or more search queries to run (query variations; max ${MAX_QUERIES}, each capped at ${MAX_QUERY_LENGTH} chars). Queries are sent as written: operators (site:, filetype:, -term), "exact phrases" and case are kept.`
        },
        query: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Legacy alias for queries: a single query string or an array of query strings. A non-empty queries array takes precedence."
        },
        limit: { type: "number", default: DEFAULT_LIMIT, description: `Results per query (1-${MAX_LIMIT})` },
        bypassCache: {
          type: "boolean",
          default: false,
          description: "Skip cached data and refresh the cached response"
        },
        // No `enum` on purpose (tests/mcp-server.test.js "advertises only the
        // singular engine param"): an enum invites models to pick engines.
        // The valid names are listed in the description and enforced here.
        engine: {
          type: "string",
          default: SELECT_BEST_ENGINE,
          description: `Preferred default: \`select_best\`, which uses only SEARCH_ENABLED_ENGINES. A registered route may be named explicitly even when it is not enabled for \`select_best\`. Valid values: ${WebSearchRequest.engineNames().join(", ")}.`
        }
      },
      required: ["queries"],
      description: "Provide queries (string[]). Use several queries for different angles on the same question.",
      additionalProperties: false
    };
  }

  /**
   * Validate raw MCP arguments. Throws `Invalid input: …` for anything the
   * caller has to fix; recoverable adjustments (truncation) become `notices`
   * that the response shows instead of applying them silently.
   */
  static fromArgs(args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("Invalid input: web_search arguments must be an object");
    }
    const accepted = Object.keys(WebSearchRequest.inputSchema().properties);
    const unknown = Object.keys(args).filter((key) => !accepted.includes(key));
    if (unknown.length) {
      throw new Error(`Invalid input: unknown parameter${unknown.length > 1 ? "s" : ""} ${unknown.map((key) => `"${key}"`).join(", ")} for web_search (accepted: ${accepted.join(", ")})`);
    }

    const notices = [];
    let queries = WebSearchRequest.parseQueries(args.queries, "queries", notices);
    if (!queries.length) queries = WebSearchRequest.parseQueries(args.query, "query", notices);
    if (!queries.length) {
      throw new Error("Missing queries: provide at least one non-empty search query in queries");
    }
    if (queries.length > MAX_QUERIES) {
      const dropped = queries.slice(MAX_QUERIES);
      notices.push(`Only the first ${MAX_QUERIES} queries were run; ${dropped.length} more ignored: ${dropped.map((q) => `"${q}"`).join(", ")}`);
      queries = queries.slice(0, MAX_QUERIES);
    }

    let engine = SELECT_BEST_ENGINE;
    if (args.engine !== undefined && args.engine !== null && args.engine !== "") {
      if (typeof args.engine !== "string") {
        throw new Error(`Invalid input: engine must be a string (got ${typeName(args.engine)})`);
      }
      engine = args.engine.trim().toLowerCase() || SELECT_BEST_ENGINE;
      if (!WebSearchRequest.engineNames().includes(engine)) {
        throw new Error(`Invalid input: unknown engine "${args.engine}". Valid engines: ${WebSearchRequest.engineNames().join(", ")}`);
      }
    }

    return new WebSearchRequest({
      queries,
      limit: parseSearchLimit(args.limit, DEFAULT_LIMIT),
      engine,
      bypassCache: args.bypassCache === true,
      notices
    });
  }

  static parseQueries(value, field, notices) {
    if (value === undefined || value === null) return [];
    let raw;
    if (typeof value === "string") {
      raw = [value];
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item !== "string") {
          throw new Error(`Invalid input: ${field}[${index}] must be a string (got ${typeName(item)})`);
        }
      });
      raw = value;
    } else {
      throw new Error(`Invalid input: ${field} must be an array of strings (got ${typeName(value)})`);
    }
    return raw
      .map((item) => item.trim())
      .filter(Boolean)
      .map((query) => {
        if (query.length <= MAX_QUERY_LENGTH) return query;
        notices.push(`A query longer than ${MAX_QUERY_LENGTH} characters was truncated: "${query.slice(0, 60)}…"`);
        return query.slice(0, MAX_QUERY_LENGTH);
      });
  }

  constructor({ queries, limit, engine, bypassCache, notices }) {
    this.queries = queries;
    this.limit = limit;
    this.engine = engine;
    this.bypassCache = bypassCache;
    this.notices = notices;
  }

  /** Engines to pass to browserSearch: [] = automatic selection. */
  get engines() {
    return this.engine === SELECT_BEST_ENGINE ? [] : [this.engine];
  }
}

// ── outcome / cache policy ────────────────────────────────────────────────

function queryEntries(payload) {
  if (Array.isArray(payload?.queryResults) && payload.queryResults.length) return payload.queryResults;
  return payload ? [payload] : [];
}

function hasResults(entry) {
  return Array.isArray(entry?.results) && entry.results.length > 0;
}

function hardErrors(entry) {
  return Array.isArray(entry?.errors) ? entry.errors : [];
}

/**
 * True when no query got results and at least one engine actually failed
 * (blocked, errored, skipped). Every engine answering "no results" is a real,
 * empty search, not a failure.
 */
export function isFailedSearch(payload) {
  const entries = queryEntries(payload);
  if (!entries.length) return true;
  return entries.every((entry) => !hasResults(entry) && hardErrors(entry).some((error) => error?.kind !== "no_results"));
}

/**
 * Only a complete answer is cached: every query has results and none carries
 * a hard error. Recovered fallback notes do not block caching; empty or
 * partially failed payloads are never cached (a retry may succeed).
 */
export function isCacheableSearchPayload(payload) {
  const entries = queryEntries(payload);
  return entries.length > 0 && entries.every((entry) => hasResults(entry) && hardErrors(entry).length === 0);
}

// ── markdown rendering ────────────────────────────────────────────────────

function truncateForDisplay(value, maxChars = 400) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function cleanTitle(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const withoutUrl = text.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
  return withoutUrl || text;
}

function engineLabel(entry) {
  return entry?.engine || entry?.route || "search";
}

function renderOutcomeLine(outcome, queryPrefix = "") {
  if (!outcome?.error) return null;
  return `- ${queryPrefix}${engineLabel(outcome)}: ${outcome.error}`;
}

function resultKey(result) {
  return String(result?.ref_id ?? result?.url ?? "");
}

function renderResults(lines, results, { heading = `**Results (${results.length}):**`, variantsByKey = null } = {}) {
  lines.push("", heading);
  results.forEach((result, index) => {
    const refId = result?.ref_id;
    const titleText = cleanTitle(result?.title || "");
    const title = titleText ? `**${titleText}**` : "Untitled";
    const linkText = result?.domain || titleText || "link";
    const refLabel = refId ? `[${linkText}](${refId})` : `${index + 1}.`;
    const snippet = truncateForDisplay(result?.snippet || "", 450);
    const variants = variantsByKey?.get(resultKey(result)) || result?.queryVariants;
    const queryVariants = Array.isArray(variants) && variants.length
      ? ` _(queries: ${variants.join(", ")})_`
      : "";
    lines.push(`- ${title} ${refLabel}${queryVariants}`.trim());
    if (snippet) lines.push(`  - ${snippet}`);
  });
}

function renderDirectAnswers(lines, answers) {
  if (!answers.length) return;
  lines.push("", "**Instant Answer:**");
  for (const answer of answers) {
    const snippet = truncateForDisplay(answer?.text || "", 400);
    const link = answer?.url ? ` (${answer.url})` : "";
    lines.push(`- ${snippet}${link}`.trim());
  }
}

/**
 * Render a search payload. Order: query → notices → instant answer → results
 * → fallback notes → errors.
 *
 * Multiple queries render grouped by query (docs/api/tool-reference.md) and
 * deduplicated by URL (docs/guides/search/results.md): a result appears once,
 * in the first query section that found it, tagged with every query variant
 * that returned it — later sections list only what is new to them.
 */
export function formatSearchMarkdown(payload) {
  const lines = [];
  const entries = queryEntries(payload);
  const multiQuery = entries.length > 1;

  if (multiQuery) {
    lines.push(`**Queries:** ${entries.map((entry) => entry.query).filter(Boolean).join(" · ")}`);
  } else if (payload?.query) {
    lines.push(`**Query:** ${payload.query}`);
  } else if (Array.isArray(payload?.queries) && payload.queries.length) {
    lines.push(`**Queries:** ${payload.queries.join(", ")}`);
  }

  const notices = Array.isArray(payload?.notices) ? payload.notices.filter(Boolean) : [];
  if (notices.length) {
    lines.push("", "**Notes:**", ...notices.map((notice) => `- ${notice}`));
  }

  if (multiQuery) {
    const variantsByKey = new Map();
    for (const entry of entries) {
      for (const result of entry.results || []) {
        const key = resultKey(result);
        const variants = variantsByKey.get(key) || [];
        if (entry.query && !variants.includes(entry.query)) variants.push(entry.query);
        variantsByKey.set(key, variants);
      }
    }
    const shown = new Set();
    let anyResults = false;
    for (const entry of entries) {
      lines.push("", `**Query:** ${entry.query}`);
      renderDirectAnswers(lines, Array.isArray(entry.directAnswers) ? entry.directAnswers : []);
      const all = Array.isArray(entry.results) ? entry.results : [];
      const fresh = all.filter((result) => !shown.has(resultKey(result)));
      fresh.forEach((result) => shown.add(resultKey(result)));
      if (fresh.length) {
        anyResults = true;
        const repeated = all.length - fresh.length;
        const heading = `**Results (${fresh.length} new${repeated ? `, ${repeated} already listed above` : ""}):**`;
        renderResults(lines, fresh, { heading, variantsByKey });
      } else if (all.length) {
        anyResults = true;
        lines.push("", `All ${all.length} results for this query are already listed above.`);
      } else {
        lines.push("", "No results returned.");
      }
    }
    if (anyResults) lines.push("", "*Link destinations in parentheses are ref_ids.*");
  } else {
    renderDirectAnswers(lines, Array.isArray(payload?.directAnswers) ? payload.directAnswers : []);
    const results = Array.isArray(payload?.results) ? payload.results : [];
    if (results.length) {
      renderResults(lines, results);
      lines.push("", "*Link destinations in parentheses are ref_ids.*");
    } else {
      lines.push("", "No results returned.");
    }
  }

  const prefixFor = (entry) => (multiQuery && entry?.query ? `"${entry.query}" → ` : "");
  const notes = entries.flatMap((entry) => (entry?.fallbackNotes || []).map((note) => renderOutcomeLine(note, prefixFor(entry)))).filter(Boolean);
  if (notes.length) {
    lines.push("", "**Fallback notes** (these engines failed before another engine answered):", ...notes);
  }
  const errors = entries.flatMap((entry) => hardErrors(entry).map((error) => renderOutcomeLine(error, prefixFor(entry)))).filter(Boolean);
  if (errors.length) {
    lines.push("", "**Errors:**", ...errors);
  }

  return lines.filter(Boolean).join("\n");
}
