/**
 * Extractor Registry & Orchestrator.
 *
 * Dispatches HTML → text extraction by format. The pipeline:
 *   1. Parse HTML → JSDOM
 *   2. Apply skip selectors
 *   3. If hint.content.blocks → blocks extraction (early return)
 *   4. Run the format's extractor chain (ExtractorChain): the hint's format
 *      first, then its fallbacks when it returns nothing or — for selective
 *      extractors — keeps too little of the page's rendered text
 *   5. Truncate once to maxChars (single point of truncation)
 *   6. Post-processor runs as final step (single point of application)
 *   7. Return
 *
 * Every extractor follows the same contract:
 *   (doc, context) → { title, url, text, textOriginalLength } | null
 * Extractors return their FULL output and must not mutate `doc` (later links
 * in the chain reuse it); truncation and the `truncated` flag belong here.
 */
import * as readability from "./readability.js";
import * as htmlToMarkdown from "./html-to-markdown.js";
import * as text from "./text.js";
import * as html from "./html.js";
import * as table from "./table.js";
import * as screenshot from "./screenshot.js";
import * as trafilatura from "./trafilatura.js";
import {
  parseHtmlToDom,
  resolveRelativeUrls,
  applySkipSelectors,
  safeTruncateText,
  cleanWhitespace,
  elementTextWithBreaks,
  markdownVisibleTextLength,
  domVisibleTextLength
} from "./helpers.js";
import { runPostProcessor } from "../post-processor.js";

// ── Registry ─────────────────────────────────────────────────────────────────

const FORMAT_EXTRACTORS = new Map([
  [trafilatura.FORMAT, trafilatura.extract],
  [readability.FORMAT, readability.extract],
  [htmlToMarkdown.FORMAT, htmlToMarkdown.extract],
  [text.FORMAT, text.extract],
  [html.FORMAT, html.extract],
  [screenshot.FORMAT, screenshot.extract],
]);

// Register all table variants under their own keys.
for (const fmt of table.FORMATS) {
  FORMAT_EXTRACTORS.set(fmt, table.extract);
}

/** All known extractor format IDs. */
export const EXTRACTOR_FORMATS = [...FORMAT_EXTRACTORS.keys()];

// ── Extractor Chain ──────────────────────────────────────────────────────────

// Selective extractors decide what "the main content" is and drop the rest.
// When one keeps almost nothing of a long page it has picked the wrong
// container (RFC 9110: 6.8K of 449K chars), so its output is checked against
// the page's rendered text and the next extractor in its chain is tried.
const SELECTIVE_FORMATS = new Set([trafilatura.FORMAT, readability.FORMAT]);
const FALLBACK_CHAINS = new Map([
  [trafilatura.FORMAT, [readability.FORMAT, htmlToMarkdown.FORMAT]],
  [readability.FORMAT, [htmlToMarkdown.FORMAT]]
]);
// Formats without their own chain fall back to Readability when they produce
// nothing (e.g. a tables-only extractor on a page without tables).
const DEFAULT_FALLBACKS = [readability.FORMAT, htmlToMarkdown.FORMAT];
const COVERAGE_MIN_RATIO = 0.2;
// Below this many missing characters a low ratio is just a short page with
// heavy chrome, not lost content.
const COVERAGE_MIN_MISSING_CHARS = 2000;

class ExtractorChain {
  constructor(requestedFormat, pageTextLength) {
    this.requestedFormat = requestedFormat;
    this.primaryFormat = FORMAT_EXTRACTORS.has(requestedFormat) ? requestedFormat : readability.FORMAT;
    this.pageTextLength = pageTextLength;
    this.formats = [...new Set([this.primaryFormat, ...(FALLBACK_CHAINS.get(this.primaryFormat) || DEFAULT_FALLBACKS)])];
    this.attempts = [];
  }

  coverageOf(text) {
    const kept = markdownVisibleTextLength(text);
    const page = this.pageTextLength;
    const ratio = page > 0 ? kept / page : 1;
    const adequate = page <= 0 || ratio >= COVERAGE_MIN_RATIO || page - kept < COVERAGE_MIN_MISSING_CHARS;
    return { kept, page, ratio, adequate };
  }

  async run(doc, context) {
    for (const format of this.formats) {
      const result = await FORMAT_EXTRACTORS.get(format)(doc, { ...context, format });
      if (!result?.text?.trim()) {
        this.attempts.push({ format, result: null });
        continue;
      }
      const coverage = SELECTIVE_FORMATS.has(format) ? this.coverageOf(result.text) : null;
      const attempt = { format, result, coverage };
      this.attempts.push(attempt);
      if (!coverage || coverage.adequate) return this.decorate(attempt);
    }
    // Every selective extractor under-covered and nothing else produced
    // output: keep the attempt that kept the most of the page.
    const best = this.attempts
      .filter((a) => a.result)
      .sort((a, b) => (b.coverage?.ratio ?? 0) - (a.coverage?.ratio ?? 0))[0];
    return best ? this.decorate(best) : null;
  }

  // Name the extractor that produced the text, and why it is not the one the
  // hint asked for, so a short or unusual result can be traced.
  decorate(chosen) {
    const result = { ...chosen.result, extractor: chosen.format };
    if (chosen.format === this.requestedFormat) return result;
    const reasons = this.attempts
      .filter((a) => a !== chosen && this.formats.indexOf(a.format) < this.formats.indexOf(chosen.format))
      .map((a) => (a.result
        ? `${a.format} kept only ${Math.round((a.coverage?.ratio ?? 0) * 100)}% of the page text (${a.coverage?.kept} of ${a.coverage?.page} chars)`
        : `${a.format} returned no usable output`));
    if (reasons.length) result.extractorNote = `fallback — ${reasons.join("; ")}`;
    return result;
  }
}

/** Truncate an extractor result to maxChars and record that it happened. */
function truncateResult(result, maxChars) {
  const full = String(result.text || "");
  const truncated = Number.isFinite(maxChars) && maxChars > 0 && full.length > maxChars;
  return {
    ...result,
    text: truncated ? full.slice(0, maxChars).trimEnd() : full,
    textOriginalLength: full.length,
    truncated
  };
}

// ── Post-processor Pipeline Step ─────────────────────────────────────────────

// Plan 60 S3: a post-processor failure (model removed/renamed, endpoint down)
// must not be silent — attach a warning the extraction result carries to the
// tool output (`- ⚠ …` lines), alongside the server-side console.warn.
function withPostProcessorWarning(result, model, err) {
  const existing = Array.isArray(result.warnings) ? result.warnings : [];
  return {
    ...result,
    warnings: [...existing, `post-processor "${model}" failed — kept the original extractor output: ${err.message}`]
  };
}

async function applyPostProcessor(result, { url, postProcessorModel, config, signal }) {
  if (!postProcessorModel || !result?.text) return result;

  // Screenshot input → image post-processor.
  if (result._screenshotInput) {
    try {
      const processed = await runPostProcessor({ screenshot: result._screenshotInput, model: postProcessorModel, config, signal });
      if (processed) {
        return { ...result, text: processed, textOriginalLength: processed.length };
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason || err;
      console.warn(`[web_fetch] [${url}] post-processor "${postProcessorModel}" failed for screenshot — falling back to raw: ${err.message}`);
      return withPostProcessorWarning(result, postProcessorModel, err);
    }
    return result;
  }

  // Text input → text post-processor.
  // If the extractor stored raw HTML (e.g. html format), pass it as `html`
  // so the post-processor receives clean HTML instead of code-fenced markdown.
  try {
    const ppInput = result._rawHtml ? { html: result._rawHtml } : { text: result.text };
    const ppResult = await runPostProcessor({ ...ppInput, model: postProcessorModel, config, signal });
    if (ppResult) return { ...result, text: ppResult, textOriginalLength: ppResult.length };
  } catch (err) {
    if (signal?.aborted) throw signal.reason || err;
    console.warn(`[web_fetch] [${url}] post-processor "${postProcessorModel}" failed — keeping original: ${err.message}`);
    return withPostProcessorWarning(result, postProcessorModel, err);
  }
  return result;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Extract readable text from raw HTML using the hint's format.
 *
 * @param {object} args
 * @param {string}  args.html                 - Raw HTML from the page.
 * @param {string}  args.url                  - Page URL.
 * @param {number}  args.maxChars             - Max output characters.
 * @param {string}  args.fallbackTitle        - Title if DOM has none.
 * @param {object}  [args.hint]               - Domain hint object.
 * @param {string}  [args.browserText]        - Live page innerText (if available).
 * @param {string}  [args.screenshot]         - Base64 JPEG screenshot (if available).
 * @param {boolean} [args.debug]              - Enable debug logging.
 * @param {boolean} [args.strict]             - Return empty on blocks failure.
 * @param {string[]} [args.defaultExtractSkipSelectors] - Global skip selectors.
 * @param {object}  args.config               - manager.config.
 * @param {AbortSignal} [args.signal]          - Cancels queued/network post-processing.
 * @returns {Promise<{title: string, url: string, text: string, textOriginalLength: number}>}
 */
export async function extractTextFromHtml({
  html,
  url,
  maxChars,
  fallbackTitle,
  hint,
  browserText,
  screenshot,
  debug = false,
  strict = false,
  defaultExtractSkipSelectors = [],
  config,
  signal,
  dom: externalDom
}) {
  if (debug) console.log(`[web_fetch] [${url}] extractTextFromHtml called`);

  const dom = externalDom || parseHtmlToDom(html, url);
  const ownedDom = !externalDom;

  try {
    const doc = dom.window.document;

    // ── Step 0: Resolve relative URLs to absolute ─────────────────────
    resolveRelativeUrls(doc, url);

    // ── Step 1: Apply skip selectors ──────────────────────────────────
    applySkipSelectors(doc, defaultExtractSkipSelectors, hint?.default?.skipSelectors);

    // ── Step 2: Blocks extraction (hint.content.blocks) ───────────────
    if (hint?.content?.blocks?.length) {
      // renderContentBlocks lives in search.js — we import it lazily to
      // avoid a circular dependency at module load time.
      const { renderContentBlocks } = await import("../search.js");
      if (debug) console.log(">>> entering blocks path, blocks:", hint.content.blocks.length, "first selector:", hint.content.blocks[0].selector);
      const blockResult = await renderContentBlocks(doc, hint, {
        url,
        maxChars,
        debug,
        fallbackTitle,
        config,
        signal,
        screenshot
      });
      if (blockResult) return blockResult;
      if (debug) console.log(">>> blocks produced no output");
    }

    if (strict && hint?.content?.blocks?.length) {
      if (debug) console.log(`[web_fetch] [${url}] extractTextFromHtml: strict content produced no output`);
      return { title: cleanWhitespace(doc.title || fallbackTitle || ""), url, text: "", textOriginalLength: 0 };
    }

    // ── Step 3: Resolve format ────────────────────────────────────────
    const defaultBlock = hint?.default || {};
    const pageFormat = defaultBlock.format || "readability_to_markdown";
    const postProcessorModel = defaultBlock.postProcessor;
    if (debug) console.log(`[web_fetch] [${url}] extractTextFromHtml: default extraction (format=${pageFormat})`);

    // ── Step 4: Run the extractor chain ─────────────────────────────
    // Page-text reference for the coverage check. The document's text (after
    // skip selectors) still counts hidden menus; the live innerText (when the
    // page was rendered) still counts what skip selectors removed. The smaller
    // of the two is the visible, wanted text.
    const domTextLength = domVisibleTextLength(doc.body);
    const pageTextLength = browserText
      ? Math.min(domTextLength, browserText.replace(/\s+/g, " ").trim().length)
      : domTextLength;
    const chain = new ExtractorChain(pageFormat, pageTextLength);
    const context = {
      url,
      maxChars: Infinity,
      fallbackTitle: fallbackTitle || doc.title || "",
      browserText,
      screenshot,
      hint,
      config,
      signal,
      debug
    };

    let result = await chain.run(doc, context);
    if (!result) {
      result = { title: "", url, text: "", textOriginalLength: 0, extractor: pageFormat };
    }
    if (!result.title) {
      result.title = cleanWhitespace(doc.title || fallbackTitle || "");
    }
    if (debug && result.extractorNote) console.log(`[web_fetch] [${url}] extractor=${result.extractor} (${result.extractorNote})`);
    result = truncateResult(result, maxChars);

    // ── Step 5: Post-processor (single pipeline step) ─────────────────
    // Screenshot format: pass screenshot as input to post-processor.
    if (pageFormat === "screenshot" && screenshot) {
      result._screenshotInput = screenshot;
    }
    result = await applyPostProcessor(result, { url, postProcessorModel, config, signal });

    return result;
  } catch (err) {
    if (signal?.aborted) throw signal.reason || err;
    if (debug) console.log(`[web_fetch] [${url}] extractTextFromHtml: catch_all error: ${err?.message}`);
    // Hard fallback: extract whatever text we can from the raw DOM.
    const fallback = elementTextWithBreaks(dom?.window?.document?.body).trim();
    return {
      title: cleanWhitespace(dom?.window?.document?.title || fallbackTitle || ""),
      url,
      text: safeTruncateText(fallback, maxChars),
      textOriginalLength: fallback.length,
    };
  } finally {
    // Only close a DOM we created — external DOMs are owned by the caller.
    if (ownedDom) dom?.window?.close();
  }
}
