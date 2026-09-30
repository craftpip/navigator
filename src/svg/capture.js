import { capturePageAsPdf, getPageDimensions } from './capture-pdf.js';
import { captureDomSnapshot } from './dom-snapshot.js';
import { mergeLayers } from './merge-layers.js';
import { svgExtractor } from './extractor.js';
import { buildSvg } from './builder.js';
import {
  withStageDeadline,
  SvgStageTimeoutError,
  SVG_FONT_STAGE_TIMEOUT_MS,
  SVG_EXTRACT_STAGE_TIMEOUT_MS,
  SVG_DIMS_STAGE_TIMEOUT_MS,
} from './deadline.js';

export async function capturePageAsSvg(page, opts = {}) {
  const usePdfPath = opts.usePdfPath === true || opts.pdf === true;
  const fullPage = opts.fullPage === true;
  const limit = opts.elementLimit ? Math.max(1, Math.min(5000, Math.floor(Number(opts.elementLimit)))) : 5000;
  // Stage budgets are overridable so tests can drive the timeout path without
  // waiting out the real budgets, and so a caller can trade fidelity for speed.
  const fontBudget = Number(opts.fontTimeoutMs) > 0 ? Number(opts.fontTimeoutMs) : SVG_FONT_STAGE_TIMEOUT_MS;
  const extractBudget = Number(opts.extractTimeoutMs) > 0 ? Number(opts.extractTimeoutMs) : SVG_EXTRACT_STAGE_TIMEOUT_MS;
  const dimsBudget = Number(opts.dimsTimeoutMs) > 0 ? Number(opts.dimsTimeoutMs) : SVG_DIMS_STAGE_TIMEOUT_MS;

  if (usePdfPath) {
    try {
      const dims = await withStageDeadline('page_dimensions', dimsBudget, () => getPageDimensions(page));
      const clipW = fullPage ? dims.pageWidth : dims.viewportWidth;
      const clipH = fullPage ? dims.pageHeight : dims.viewportHeight;

      const [pdfResult, domSnapshot] = await Promise.all([
        withStageDeadline('pdf_capture', extractBudget, () =>
          capturePageAsPdf(page, { clipW, clipH, fullPage })),
        withStageDeadline('dom_snapshot', extractBudget, () => captureDomSnapshot(page)),
      ]);

      const mergedSvg = mergeLayers(pdfResult.svg, domSnapshot, {
        includeSelector: opts.includeSelector !== false,
        includeXpath: opts.includeXpath !== false,
        clipW,
        clipH,
        elementLimit: limit,
      });

      const elements = domSnapshot.elements || [];
      const margin = 50;
      const filtered = elements.filter((el) => {
        const r = el.rect;
        return r.x + r.width > -margin && r.x < clipW + margin && r.y + r.height > -margin && r.y < clipH + margin;
      }).slice(0, limit);

      const svgBytes = Buffer.byteLength(mergedSvg, 'utf-8');

      return {
        svg: mergedSvg,
        data: {
          title: domSnapshot.title,
          url: domSnapshot.url,
          viewportWidth: dims.viewportWidth,
          viewportHeight: dims.viewportHeight,
          pageWidth: dims.pageWidth,
          pageHeight: dims.pageHeight,
          bodyBg: domSnapshot.bodyBg,
          htmlBg: domSnapshot.htmlBg,
          scrollX: dims.scrollX,
          scrollY: dims.scrollY,
          elements,
        },
        clipW,
        clipH,
        filtered,
        built: { stats: { bytes: svgBytes } },
        method: 'pdf+dom-snapshot',
      };
    } catch (err) {
      console.warn('PDF path failed, falling back to rect synthesis:', err.message, err.stack?.slice(0, 500));
    }
  }

  // Font settling is best-effort: a stalled @font-face must not fail the whole
  // capture, but it must not hang it either. The rect render below is still
  // usable with fallback metrics, so a font timeout degrades to a warning.
  try {
    await withStageDeadline('fonts', fontBudget, () =>
      page.evaluate(async () => {
        if (!document.fonts) return;
        await document.fonts.ready;
        const loads = Array.from(document.fonts).map((f) => f.load().catch(() => {}));
        await Promise.all(loads);
        await document.fonts.ready;
      })
    );
  } catch (err) {
    if (err instanceof SvgStageTimeoutError) {
      console.warn(`SVG capture: ${err.message} — continuing with fallback font metrics`);
    } else {
      console.warn(`SVG capture: font settling failed: ${err.message}`);
    }
  }

  const data = await withStageDeadline('dom_extract', extractBudget, () =>
    page.evaluate(svgExtractor, limit, { viewportOnly: !fullPage })
  );
  const clipW = fullPage ? data.pageWidth : data.viewportWidth;
  const clipH = fullPage ? data.pageHeight : data.viewportHeight;
  const margin = 50;
  const filtered = data.elements.filter((el) => {
    const r = el.rect;
    return r.x + r.width > -margin && r.x < clipW + margin && r.y + r.height > -margin && r.y < clipH + margin;
  });
  const built = buildSvg(
    filtered.map((el) => ({
      ...el,
      ...(opts.includeSelector === false ? { selector: undefined } : {}),
      ...(opts.includeXpath === false ? { xpath: undefined } : {}),
    })),
    clipW,
    clipH,
    {
      title: data.title,
      url: data.url,
      viewportWidth: data.viewportWidth,
      viewportHeight: data.viewportHeight,
      pageWidth: data.pageWidth,
      pageHeight: data.pageHeight,
      bodyBg: data.bodyBg,
      htmlBg: data.htmlBg,
      fontLinks: data.fontLinks,
      scrollbar: data.scrollbar,
      html: opts.hybrid ? data.htmlInline || data.html : undefined,
      fullPage,
    },
    { includeSelector: opts.includeSelector !== false, includeXpath: opts.includeXpath !== false },
  );

  return { svg: built.svg, data, built, clipW, clipH, filtered, method: 'rect-synthesis' };
}
