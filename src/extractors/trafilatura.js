/**
 * TrafilaturaExtractor — rs-trafilatura Rule+ML extraction → markdown.
 *
 * Uses the `trafilatura` npm package (napi-rs bindings to the rs-trafilatura
 * Rust crate). Classifies page type (7 types) with XGBoost ML and applies
 * per-type extraction profiles. Returns markdown directly — no Turndown step.
 * Ranked #1 on the WCXB benchmark (F1 0.859 vs Readability 0.674).
 */
import { cleanWhitespace } from "./helpers.js";

export const FORMAT = "trafilatura_to_markdown";

// Lazy-load the native module so a missing binary degrades gracefully
// (returns null → orchestrator falls back to Readability) instead of
// crashing at import time.
let _extract = null;
async function getExtract() {
  if (!_extract) {
    const mod = await import("trafilatura");
    _extract = mod.extract;
  }
  return _extract;
}

// rs-trafilatura reports when its main-content pass found nothing usable and
// it fell back to a whole-page text dump. That dump glues block elements
// together ("HeadingParagraph"), drops links/code fences and escapes code, so
// it is not a result: return null and let the pipeline use the next extractor.
const LOW_FIDELITY_WARNING_RE = /fallback extraction|no main content found/i;

// Title precedence: the document's own <title>, then og:title, then whatever
// trafilatura derived. trafilatura prefers the JSON-LD headline, which on
// sites like Wikipedia is the article's short description, not its name.
function pageTitle(doc, metadataTitle, fallbackTitle) {
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
  return cleanWhitespace(doc.title || ogTitle || metadataTitle || fallbackTitle || "");
}

const TABLE_SEPARATOR_RE = /^\|[\s:|-]+\|?\s*$/;
const CELL_SPLIT_RE = /(?<!\\)\|/;
const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function isTableRow(line) {
  return /\|\s*$/.test(line) && line.includes("|");
}

// rs-trafilatura pads markdown table cells to a common column width; on
// infobox-heavy pages (Wikipedia: ~1M chars for a 450K-char page) the padding
// alone eats the caller's maxChars. Collapse it.
function compactTableRows(markdown) {
  return markdown
    .split("\n")
    .map((line) => (isTableRow(line) ? line.replace(/[ \t]{2,}/g, " ").replace(/-{4,}/g, "---") : line))
    .join("\n");
}

/**
 * rs-trafilatura renders table cells as plain text and drops their links (a
 * Wikipedia infobox, a listing table). TableLinkIndex puts them back: an
 * anchor text from the document's table cells becomes `[text](href)` again
 * when it is unambiguous — it maps to exactly one href, and every occurrence
 * of it in table cells IS that link (an infobox label "Born" next to a
 * "Born" link to Max Born elsewhere stays plain).
 */
class TableLinkIndex {
  constructor(doc) {
    const hrefsByText = new Map();
    const anchorCount = new Map();
    for (const a of doc.querySelectorAll("td a[href], th a[href]")) {
      const raw = a.getAttribute("href") || "";
      if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) continue;
      const text = cleanWhitespace(a.textContent || "");
      if (text.length < 2 || /[|[\]]/.test(text) || !WORD_CHAR_RE.test(text[0])) continue;
      if (!hrefsByText.has(text)) hrefsByText.set(text, new Set());
      hrefsByText.get(text).add(a.href || raw);
      anchorCount.set(text, (anchorCount.get(text) || 0) + 1);
    }
    this.hrefByText = new Map();
    for (const [text, hrefs] of hrefsByText) {
      if (hrefs.size === 1) this.hrefByText.set(text, [...hrefs][0]);
    }
    this.buildTokenIndex();
    if (!this.hrefByText.size) return;
    // Drop texts that also occur in table cells as plain text.
    const occurrences = new Map();
    for (const cell of doc.querySelectorAll("td, th")) {
      if (cell.querySelector("td, th")) continue;
      for (const { text } of this.matches(cleanWhitespace(cell.textContent || ""))) {
        occurrences.set(text, (occurrences.get(text) || 0) + 1);
      }
    }
    for (const [text, count] of occurrences) {
      if (count > (anchorCount.get(text) || 0)) this.hrefByText.delete(text);
    }
    this.buildTokenIndex();
  }

  buildTokenIndex() {
    this.byFirstToken = new Map();
    for (const text of this.hrefByText.keys()) {
      const token = text.match(TOKEN_RE)?.[0];
      if (!token) continue;
      if (!this.byFirstToken.has(token)) this.byFirstToken.set(token, []);
      this.byFirstToken.get(token).push(text);
    }
    for (const list of this.byFirstToken.values()) list.sort((a, b) => b.length - a.length);
  }

  get size() {
    return this.hrefByText.size;
  }

  /** Non-overlapping, word-bounded occurrences of indexed texts in `text`. */
  matches(text) {
    const found = [];
    let resumeAt = 0;
    for (const token of text.matchAll(TOKEN_RE)) {
      const start = token.index;
      if (start < resumeAt) continue;
      if (start > 0 && WORD_CHAR_RE.test(text[start - 1])) continue;
      const candidate = (this.byFirstToken.get(token[0]) || []).find((t) => text.startsWith(t, start) && !WORD_CHAR_RE.test(text[start + t.length] || ""));
      if (!candidate) continue;
      found.push({ start, text: candidate });
      resumeAt = start + candidate.length;
    }
    return found;
  }

  linkCell(cell) {
    if (!cell.trim() || cell.includes("](")) return cell;
    let out = "";
    let at = 0;
    for (const { start, text } of this.matches(cell)) {
      out += `${cell.slice(at, start)}[${text}](${this.hrefByText.get(text)})`;
      at = start + text.length;
    }
    return out + cell.slice(at);
  }

  restore(markdown) {
    if (!this.size) return markdown;
    return markdown
      .split("\n")
      .map((line) => (isTableRow(line) && !TABLE_SEPARATOR_RE.test(line)
        ? line.split(CELL_SPLIT_RE).map((cell) => this.linkCell(cell)).join("|")
        : line))
      .join("\n");
  }
}

export async function extract(doc, context) {
  const { url, fallbackTitle, debug } = context;

  let extractFn;
  try {
    extractFn = await getExtract();
  } catch (err) {
    console.warn(`[trafilatura] native module not available: ${err.message}`);
    return null;
  }

  const html = doc.documentElement.outerHTML;
  if (!html?.trim()) return null;

  let result;
  try {
    result = extractFn(html, {
      outputMarkdown: true,
      url,
      favorPrecision: false,
      includeImages: false,
      includeComments: false,
      includeLinks: true
    });
  } catch (err) {
    console.warn(`[trafilatura] extraction failed for ${url}: ${err.message}`);
    return null;
  }

  if (!result?.contentMarkdown?.trim()) return null;
  const lowFidelity = (result.warnings || []).find((w) => LOW_FIDELITY_WARNING_RE.test(String(w)));
  if (lowFidelity) {
    if (debug) console.log(`[trafilatura] [${url}] rejected low-fidelity output: ${lowFidelity}`);
    return null;
  }

  const compact = compactTableRows(result.contentMarkdown);
  const text = /\|\s*$/m.test(compact) ? new TableLinkIndex(doc).restore(compact) : compact;
  return {
    title: pageTitle(doc, result.metadata?.title, fallbackTitle),
    url,
    text,
    textOriginalLength: text.length,
    // Extra fields — flow through via ...extracted spread in search.js.
    confidence: result.extractionQuality,
    pageType: result.metadata?.pageType || null,
    metadata: result.metadata || null,
  };
}