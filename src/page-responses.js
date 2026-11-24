/**
 * Read-time formatters for page tool results (web_fetch, web_page_screenshot,
 * web_page_screenshot_crop).
 *
 * The tools return structured payloads (one entry, or { count, results }); the
 * cache stores those, and these formatters turn them into MCP content on the
 * way out. Images are MCP `image` content items — never base64 data URLs
 * inside text, which models receive as a huge token dump instead of a picture.
 * The HTTP /screenshot endpoint answers in markdown and asks for the legacy
 * inline data-URL rendering explicitly (`images: "markdown"`).
 */

const TRUNCATION_NOTE = (size) => `\n\n*(Response truncated — full page is ${size} chars, increase maxChars to see more)*`;

export function normalizeResultEntries(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.results)) return payload.results;
  if (typeof payload === "object" && ("ok" in payload || "text" in payload || "error" in payload)) {
    return [payload];
  }
  return [];
}

/** Per-request truncation of a (possibly cached) web_fetch payload. */
export function truncateResultsText(payload, maxChars) {
  if (!payload || !maxChars || !Number.isFinite(maxChars) || maxChars <= 0) return payload;

  const entries = normalizeResultEntries(payload);
  if (!entries.length) return payload;
  if (!entries.some((e) => e?.text && e.text.length > maxChars)) return payload;

  const truncate = (e) => {
    if (!e || !e.text || e.text.length <= maxChars) return e;
    const size = Math.max(e.textOriginalLength || 0, e.text.length);
    return { ...e, text: e.text.slice(0, maxChars).trimEnd() + TRUNCATION_NOTE(size) };
  };

  if (payload.results) {
    return { ...payload, results: payload.results.map(truncate) };
  }
  return truncate(payload);
}

function imageMimeType(entry) {
  return entry.contentType || (entry.format === "jpeg" ? "image/jpeg" : "image/png");
}

/** Builds one tool response: a markdown text item plus any image items. */
class PageResultReport {
  constructor(summary, { images = "mcp" } = {}) {
    this.lines = [summary];
    this.images = [];
    this.imageMode = images;
  }

  push(...lines) {
    this.lines.push(...lines);
  }

  /** Heading + the lines every page entry shares. */
  entryHeader(entry, index, { fallbackTitle, headingSuffix = "" }) {
    const title = entry?.title || entry?.url || `${fallbackTitle} ${index + 1}`;
    const refLabel = entry?.ref_id ? `[${title}](${entry.ref_id})` : `#${index + 1} ${title}`;
    this.push("", `### ${refLabel}${headingSuffix}`);
    this.push(`- Status: ${entry?.ok === false ? "Failed" : "Success"}`);
    if (entry?.url) this.push(`- URL: ${entry.url}`);
    if (entry?.browser) this.push(`- Browser: ${entry.browser}`);
    if (entry?.browserNote) this.push(`- Browser: ${entry.browserNote}`);
    return title;
  }

  attachImage(entry, title) {
    if (entry?.downloadUrl || !entry?.screenshotBase64) return;
    const mimeType = imageMimeType(entry);
    if (this.imageMode === "markdown") {
      this.push("", `![${title}](data:${mimeType};base64,${entry.screenshotBase64})`);
      return;
    }
    this.images.push({ type: "image", data: entry.screenshotBase64, mimeType });
    this.push(`- Image: attached (${this.images.length})`);
  }

  toContent() {
    return { content: [{ type: "text", text: this.lines.join("\n") }, ...this.images] };
  }
}

export function formatOpenPageResponse(payload) {
  const entries = normalizeResultEntries(payload);
  if (!entries.length) {
    return { content: [{ type: "text", text: "No page data available." }] };
  }

  const successCount = entries.filter((entry) => entry?.ok !== false).length;
  const total = payload?.count ?? entries.length;
  const report = new PageResultReport(`Processed ${total} page(s); ${successCount} succeeded.`);

  entries.forEach((entry, index) => {
    report.entryHeader(entry, index, { fallbackTitle: "Page" });
    if (entry?.extractor) {
      report.push(`- Extractor: ${entry.extractor}${entry.extractorNote ? ` (${entry.extractorNote})` : ""}`);
    }
    if (entry?.pageType) {
      const conf = entry.confidence != null ? ` | confidence: ${entry.confidence.toFixed(2)}` : "";
      report.push(`- Page type: ${entry.pageType}${conf}`);
    }
    for (const warning of entry?.warnings || []) {
      report.push(`- ⚠ ${warning}`);
    }
    if (entry?.partial) {
      report.push(`- ⚠ PARTIAL: the page did not reach the state this hint expected — treat the text below as incomplete`);
    }
    if (entry?.error) {
      report.push(`- Error: ${entry.error}`);
    }
    if (entry?.tables?.length) {
      report.push(`- Tables extracted: ${entry.tables.length}`);
    } else if (entry?.text) {
      const tableCount = (entry.text.match(/^### Table \d/gm) || []).length
        || (entry.text.match(/^# Table \d/gm) || []).length;
      if (tableCount) report.push(`- Tables extracted: ${tableCount}`);
    }
    // An HTTP error page (404 with a body) keeps its text: it tells the model
    // what the server said.
    if (entry?.text?.trim()) {
      report.push("", entry.text.trim());
    }
  });

  return report.toContent();
}

/**
 * @param {object} payload
 * @param {object} [options]
 * @param {"mcp"|"markdown"} [options.images] - MCP image items (default) or
 *   inline data-URL markdown (HTTP /screenshot).
 */
export function formatScreenshotResponse(payload, { images = "mcp" } = {}) {
  const entries = normalizeResultEntries(payload);
  if (!entries.length) {
    return { content: [{ type: "text", text: "No screenshot data available." }] };
  }

  const successCount = entries.filter((entry) => entry?.ok !== false).length;
  const total = payload?.count ?? entries.length;
  const report = new PageResultReport(`Captured ${total} screenshot(s); ${successCount} succeeded.`, { images });

  entries.forEach((entry, index) => {
    const title = report.entryHeader(entry, index, { fallbackTitle: "Screenshot" });
    if (entry?.error) {
      report.push(`- Error: ${entry.error}`);
      return;
    }
    if (entry?.contentType) report.push(`- Content-Type: ${entry.contentType}`);
    const bytes = entry?.bytes || entry?.sizeBytes;
    if (bytes) report.push(`- Size: ${bytes} bytes`);
    if (entry?.dimensions?.fullWidth) {
      report.push(`- Page: ${entry.dimensions.fullWidth}x${entry.dimensions.fullHeight} CSS px (viewport ${entry.dimensions.viewportWidth}x${entry.dimensions.viewportHeight})`);
    }
    if (entry?.note) report.push(`- Note: ${entry.note}`);
    if (entry?.filePath) report.push(`- File: ${entry.filePath}`);
    if (entry?.downloadUrl) report.push(`- Download: ${entry.downloadUrl}`);
    report.attachImage(entry, title);
  });

  return report.toContent();
}

export function formatCropResponse(payload) {
  const entries = normalizeResultEntries(payload);
  if (!entries.length) {
    return { content: [{ type: "text", text: "No screenshot data available." }] };
  }

  const successCount = entries.filter((entry) => entry?.ok !== false).length;
  const total = payload?.count ?? entries.length;
  const report = new PageResultReport(`Captured ${total} crop screenshot(s); ${successCount} succeeded.`);

  entries.forEach((entry, index) => {
    const title = report.entryHeader(entry, index, { fallbackTitle: "Crop", headingSuffix: " — cropped screenshot" });
    if (entry?.error) {
      report.push(`- Error: ${entry.error}`);
      return;
    }
    if (entry?.crop) {
      const crop = entry.crop;
      if (crop.form === "selector" || crop.form === "xpath") {
        const kind = crop.form === "selector" ? `selector "${crop.target}"` : `xpath "${crop.target}"`;
        report.push(`- Crop: ${kind} → matched ${crop.matched} of ${crop.total}${crop.matched !== crop.total ? " (first match)" : ""}`);
      } else {
        report.push(`- Crop: ${crop.target}`);
      }
      report.push(`- Rect: ${crop.rect.x},${crop.rect.y} ${crop.rect.width}x${crop.rect.height} (document CSS px)`);
      if (crop.padding) {
        report.push(`- Padding: ${crop.padding}px applied on all sides → final ${crop.rect.x},${crop.rect.y} ${crop.rect.width}x${crop.rect.height}`);
      }
      for (const clampNote of crop.clamped || []) {
        report.push(`- Clamped: ${clampNote}`);
      }
    }
    const kb = entry?.sizeBytes ? Math.max(1, Math.round(entry.sizeBytes / 1024)) : null;
    if (kb) {
      const preset = { 30: "low", 55: "medium", 75: "high" }[entry?.quality] || entry?.quality || "";
      const kv = typeof entry?.quality === "number" ? ` (quality ${preset}/${entry.quality})` : "";
      report.push(`- Output: ${kb} KB jpeg${kv}`);
    }
    if (entry?.filePath) report.push(`- File: ${entry.filePath}`);
    if (entry?.downloadUrl) report.push(`- Download: ${entry.downloadUrl}`);
    report.attachImage(entry, title);
  });

  return report.toContent();
}
