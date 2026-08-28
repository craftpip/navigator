/**
 * Extractor Registry & Orchestrator.
 *
 * Dispatches HTML → text extraction by format. The pipeline:
 *   1. Parse HTML → JSDOM
 *   2. Apply skip selectors
 *   3. If hint.content.blocks → blocks extraction (early return)
 *   4. Dispatch to format extractor
 *   5. Post-processor runs as final step (single point of application)
 *   6. Return
 *
 * Every extractor follows the same contract:
 *   (doc, context) → { title, url, text, textOriginalLength } | null
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
  elementTextWithBreaks
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

// ── Post-processor Pipeline Step ─────────────────────────────────────────────

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

    // ── Step 4: Dispatch to format extractor ──────────────────────────
    const extractorFn = FORMAT_EXTRACTORS.get(pageFormat);

    // Unknown format or AI model id → treat as readability fallback.
    const context = {
      url,
      maxChars,
      fallbackTitle: fallbackTitle || doc.title || "",
      browserText,
      screenshot,
      hint,
      config,
      signal,
      debug,
      format: pageFormat
    };

    let result;
    if (extractorFn) {
      result = await extractorFn(doc, context);
    } else {
      // Unknown format — fall back to readability.
      const fallback = FORMAT_EXTRACTORS.get(readability.FORMAT);
      result = await fallback(doc, context);
    }

    // Fill in title if extractor returned empty.
    if (result && !result.title) {
      result.title = cleanWhitespace(doc.title || fallbackTitle || "");
    }

    if (!result) {
      // Extractor returned null (no output) — fall through to readability fallback.
      // Re-parse HTML to get a fresh DOM (Readability mutates the doc in-place).
      const freshDom = parseHtmlToDom(html, url);
      try {
        const freshDoc = freshDom.window.document;
        resolveRelativeUrls(freshDoc, url);
        applySkipSelectors(freshDoc, defaultExtractSkipSelectors, hint?.default?.skipSelectors);
        const fallback = FORMAT_EXTRACTORS.get(readability.FORMAT);
        result = await fallback(freshDoc, context);
        if (result && !result.title) {
          result.title = cleanWhitespace(freshDoc.title || fallbackTitle || "");
        }
      } finally {
        freshDom?.window?.close();
      }
      if (!result) {
        // Last resort: empty result.
        result = { title: cleanWhitespace(doc.title || fallbackTitle || ""), url, text: "", textOriginalLength: 0 };
      }
    }

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
