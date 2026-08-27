/**
 * Shared DOM / text / table helpers used by extractors and search.js.
 *
 * These were local functions in search.js — extracted here so that
 * src/extractors/*.js and src/search.js can both import them without
 * circular dependencies.
 */
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { htmlToMarkdown } from "../markdown.js";
import { cleanWhitespace, cleanAndTruncateText } from "../engines/util.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const BLOCK_LEVEL_TAGS = new Set([
  "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);

export const SEMANTIC_CONTENT_SELECTORS = [
  "main",
  "article",
  "[role='main']",
  "section",
  ".content",
  "#content",
  ".main",
  "#main",
  "#__next",
  "#root",
  "#app-root",
  "[data-reactroot]",
  ".article-body",
  ".post-content",
  ".entry-content",
  "[itemprop='articleBody']"
];

// ── Text Helpers ─────────────────────────────────────────────────────────────

/**
 * Flat text of an element with newlines inserted at block-level boundaries.
 * textContent glues adjacent block elements; this walk splits them.
 */
export function elementTextWithBreaks(element) {
  if (!element) return "";
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") {
      if (parts.length && !/\n$/.test(parts[parts.length - 1])) parts.push("\n");
      return;
    }
    const block = BLOCK_LEVEL_TAGS.has(tag);
    if (block && parts.length && !/\n$/.test(parts[parts.length - 1])) parts.push("\n");
    for (const child of node.childNodes) walk(child);
    if (block && parts.length && !/\n$/.test(parts[parts.length - 1])) parts.push("\n");
  };
  walk(element);
  return parts.join("");
}

export function toLines(text) {
  return String(text || "")
    .split(/\r?\n+/)
    .map((line) => cleanWhitespace(line))
    .filter(Boolean);
}

function isLikelyJunkLine(line) {
  const lower = line.toLowerCase();
  if (line.length < 20) return false;
  if (/(read more|see all maps|privacy policy|all rights reserved)/i.test(lower)) return true;
  if (/^[a-z]{2,4}\d{2}/i.test(lower)) return true;
  return false;
}

function scoreTextBlock(text) {
  const cleaned = cleanWhitespace(text);
  if (!cleaned) return -Infinity;
  const words = cleaned.split(/\s+/).length;
  const links = (cleaned.match(/https?:\/\//g) || []).length;
  const punctuation = (cleaned.match(/[.!?]/g) || []).length;
  return words + punctuation * 2 - links * 5;
}

export function collectCandidateBlocks(doc) {
  const candidates = [];
  for (const selector of SEMANTIC_CONTENT_SELECTORS) {
    const nodes = doc.querySelectorAll(selector);
    for (const node of nodes) {
      const text = elementTextWithBreaks(node).trim();
      if (!text) continue;
      candidates.push({ element: node, text, score: scoreTextBlock(text) });
    }
  }
  if (!candidates.length && doc.body?.textContent) {
    const bodyText = elementTextWithBreaks(doc.body).trim();
    candidates.push({ element: doc.body, text: bodyText, score: scoreTextBlock(bodyText) });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

export function uniqueLines(lines) {
  const seen = new Set();
  const output = [];
  for (const line of lines) {
    const normalized = cleanWhitespace(line).toLowerCase();
    if (!normalized) continue;
    if (normalized.length < 3) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(cleanWhitespace(line));
  }
  return output;
}

export function buildCleanText(lines, maxChars) {
  const filtered = lines.filter((line) => !isLikelyJunkLine(line));
  const deduped = uniqueLines(filtered);
  return cleanAndTruncateText(deduped.join("\n"), maxChars);
}

export function safeTruncateText(input, maxChars) {
  const text = String(input || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}

// ── DOM Helpers ──────────────────────────────────────────────────────────────

export function parseHtmlToDom(html, url) {
  const rawHtml = typeof html === "string" ? html : "";
  const safeHtml = rawHtml.replace(/<style[\s\S]*?<\/style>/gi, "");
  try {
    return new JSDOM(safeHtml || "<body></body>", { url });
  } catch {
    return new JSDOM("<body></body>", { url });
  }
}

export function resolveRelativeUrls(doc, baseUrl) {
  if (!doc || !baseUrl) return;
  let base;
  try { base = new URL(baseUrl); } catch { return; }
  for (const el of doc.querySelectorAll("[href], [src]")) {
    for (const attr of ["href", "src"]) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      if (/^(https?:|data:|javascript:|#|mailto:)/.test(val)) continue;
      try {
        el.setAttribute(attr, new URL(val, base).href);
      } catch { /* malformed — leave as-is */ }
    }
  }
}

export function applySkipSelectors(doc, ...selectorArrays) {
  for (const selectors of selectorArrays) {
    if (!selectors?.length) continue;
    const joined = selectors.join(",");
    try {
      doc.querySelectorAll(joined).forEach((node) => node.remove());
    } catch {
      for (const sel of selectors) {
        try { doc.querySelectorAll(sel).forEach((node) => node.remove()); } catch { /* skip */ }
      }
    }
  }
}

// ── Table Helpers ────────────────────────────────────────────────────────────

function normalizeTableCellText(input, maxChars = 120) {
  return safeTruncateText(cleanWhitespace(input), maxChars);
}

function expandTableRows(rowNodes, maxCellChars) {
  const grid = [];
  for (let rowIndex = 0; rowIndex < rowNodes.length; rowIndex += 1) {
    const row = rowNodes[rowIndex];
    const cells = Array.from(row.children).filter((cell) => /^(TH|TD)$/i.test(cell.tagName));
    grid[rowIndex] = grid[rowIndex] || [];
    let columnIndex = 0;
    for (const cell of cells) {
      while (grid[rowIndex][columnIndex] !== undefined) {
        columnIndex += 1;
      }
      const rowspan = parseInt(cell.getAttribute("rowspan") || "1", 10) || 1;
      const colspan = parseInt(cell.getAttribute("colspan") || "1", 10) || 1;
      const text = normalizeTableCellText(cell.textContent || "", maxCellChars);
      for (let dr = 0; dr < rowspan; dr += 1) {
        for (let dc = 0; dc < colspan; dc += 1) {
          const r = rowIndex + dr;
          const c = columnIndex + dc;
          if (!grid[r]) grid[r] = [];
          grid[r][c] = dr === 0 && dc === 0 ? text : grid[r][c] || text;
        }
      }
      columnIndex += colspan;
    }
  }
  return grid;
}

export function extractTablesFromDocument(doc, { container, maxCellChars = 120 } = {}) {
  const root = container || doc;
  const tables = [];
  // A container that is itself a <table> must count — querySelectorAll only
  // sees descendants, so a block selector pointing at the table element
  // would otherwise match nothing.
  const tableNodes = root.matches?.("table")
    ? [root, ...root.querySelectorAll("table")]
    : root.querySelectorAll("table");
  for (const table of tableNodes) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length < 1) continue;
    const theadRows = Array.from(table.querySelectorAll("thead tr"));
    const tbodyRows = Array.from(table.querySelectorAll("tbody tr"));

    let headerRowNodes = theadRows.length ? theadRows : [];
    let bodyRowNodes = tbodyRows.length ? tbodyRows : [];

    // No explicit <thead>: treat the first row as the header when the table
    // has content rows below it. This must fire even when the DOM parser has
    // wrapped bare <tr> rows in an implicit <tbody> (jsdom/parse5 does this),
    // which otherwise hides the header row from the heuristic above.
    if (!headerRowNodes.length) {
      if (rows.length >= 2) {
        headerRowNodes = [rows[0]];
        bodyRowNodes = rows.slice(1);
      } else {
        bodyRowNodes = rows;
      }
    }

    const headerGrid = headerRowNodes.length ? expandTableRows(headerRowNodes, maxCellChars) : [];
    const bodyGrid = bodyRowNodes.length ? expandTableRows(bodyRowNodes, maxCellChars) : [];

    const headers = headerGrid.length
      ? headerGrid[0].map((cell) => cell || "")
      : [];

    const hasData = bodyGrid.some((row) => row.some((cell) => cell && cell.length > 2));
    if (!hasData && !headers.some((h) => h && h.length > 0)) continue;

    const rows_data = bodyGrid.map((row) =>
      headers.map((_, colIndex) => row[colIndex] || "")
    );

    let context = "";
    const caption = table.querySelector("caption");
    if (caption) {
      context = cleanWhitespace(caption.textContent || "");
    }
    if (!context) {
      const prev = table.previousElementSibling;
      if (prev && /^(H[1-6]|P|FIGCAPTION)$/i.test(prev.tagName)) {
        context = cleanWhitespace(prev.textContent || "");
      }
    }

    tables.push({ context, headers, rows: rows_data, node: table });
  }
  return tables;
}

export function renderTableAsMarkdown(table) {
  const lines = [];
  if (table.headers?.length) lines.push(table.headers.join(" | "));
  for (const row of table.rows || []) lines.push(row.join(" | "));
  return lines.join("\n");
}

function csvEscape(value) {
  const string = String(value ?? "");
  return /[",\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

export function renderTablesAsJson(tables) {
  const result = tables.map((table) => {
    const keys = (table.headers || []).map((header, index) => header || `col${index + 1}`);
    const rows = (table.rows || []).map((row) => {
      const entry = {};
      keys.forEach((key, index) => {
        entry[key] = row[index] !== undefined ? row[index] : "";
      });
      return entry;
    });
    const out = {};
    if (table.context) out.caption = table.context;
    out.rows = rows;
    return out;
  });
  return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

export function renderTablesAsCsv(tables) {
  const parts = [];
  for (const table of tables) {
    const lines = [];
    if (table.headers?.length) lines.push(table.headers.map(csvEscape).join(","));
    for (const row of table.rows || []) lines.push(row.map(csvEscape).join(","));
    const heading = table.context ? `### ${table.context}\n\n` : "";
    parts.push(`${heading}\`\`\`csv\n${lines.join("\n")}\n\`\`\``);
  }
  return parts.join("\n\n");
}

// ── Re-export external deps so extractors don't need to import them separately ──

export { Readability, htmlToMarkdown, cleanWhitespace, cleanAndTruncateText };
