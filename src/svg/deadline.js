// src/svg/deadline.js — per-stage deadlines for SVG capture
// Owner: Capture (E)
//
// Every browser-side step in an SVG capture is an unbounded `page.evaluate`.
// `page.setDefaultTimeout()` does NOT cover evaluate, and `protocolTimeout` is
// never set, so puppeteer's 180s default applies. A page whose `document.fonts.ready`
// never settles — or a CDP evaluation wedged behind a busy renderer — would hang
// `web_page_svg` forever, skip the caller's `finally` page close, and leak the
// page plus its page-slot. Each stage therefore gets its own short deadline, and
// the rejection names the stage so the LLM knows which one gave up.

export class SvgStageTimeoutError extends Error {
  constructor(stage, timeoutMs) {
    super(`SVG capture timed out after ${timeoutMs}ms at stage "${stage}". The page is likely busy or a web font never finished loading. Retry, or capture a lighter page (smaller elementLimit, viewport instead of fullPage).`);
    this.name = "SvgStageTimeoutError";
    this.code = "SVG_STAGE_TIMEOUT";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
    this.retrySafe = true;
  }
}

// Stage budgets. Font loading is the flakiest (a stalled @font-face blocks
// `document.fonts.ready`), so it gets the smallest budget and is allowed to
// degrade: a timeout there still yields a usable rect render.
export const SVG_FONT_STAGE_TIMEOUT_MS = 5000;
export const SVG_EXTRACT_STAGE_TIMEOUT_MS = 20000;
export const SVG_DIMS_STAGE_TIMEOUT_MS = 10000;

/**
 * Race `task()` against a deadline. The task is NOT cancelled — puppeteer has no
 * per-evaluate abort — but the caller regains control immediately and can close
 * the page, which tears the pending evaluation down with it.
 */
export function withStageDeadline(stage, timeoutMs, task) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SvgStageTimeoutError(stage, timeoutMs)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([Promise.resolve().then(task), guard]).finally(() => clearTimeout(timer));
}
