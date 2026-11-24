import { SearchEngineDriver } from "./driver.js";
import { dedupeDirectAnswers } from "./util.js";

// Transient page-lifecycle errors: the search page fired a client-side
// navigation (Startpage ~1.4s after load, Bing on result hydration) while an
// evaluate was in flight. Retrying the step on the new document succeeds.
const RETRYABLE_NAVIGATION_ERROR =
  /Execution context was destroyed|Target closed|Cannot find context with specified id|Inspected target navigated or closed/i;
const NAVIGATION_RETRY_ATTEMPTS = 2;
const NAVIGATION_RETRY_DELAY_MS = 400;

// Generic bot-wall wording shared by every engine's challenge page. Engines add
// their own markers (URL shapes, wording) through `blockMarkers`.
const GENERIC_BLOCK_TEXT =
  /captcha|unusual traffic|verify you(?:'|’)?re (?:a )?human|verify you are (?:a )?human|are you (?:a )?human|not a robot/i;

/**
 * Base class for browser-backed search routes.
 *
 * The lifecycle is: `submit()` (navigate + wait for results) → `extract()`
 * (evaluate `extractPage` in the page). Both run under `withNavigationRetry()`
 * so a transient client-side navigation never trips the route breaker.
 *
 * Block detection is declarative: a driver sets `blockMarkers` and the base
 * class decides. A page is only judged for block markers when no result
 * selector matched or extraction found zero results — so a genuine results
 * page about "captcha" is never mistaken for a bot wall, and a bot wall is
 * never counted as a successful empty search.
 */
export class BrowserSearchDriver extends SearchEngineDriver {
  backend = "chromium";

  /** Human name used in block errors ("Google blocked this request …"). */
  label = "";

  /** `{ url?: RegExp, text?: RegExp }` — engine-specific block markers. */
  blockMarkers = {};

  /** In-page extraction function (plain function referencing `document`). */
  extractPage = null;

  async submit(page, query) {
    await this.withNavigationRetry(() => this.load(page, query));
  }

  /** Navigate to the results page and wait until results (or a block) show. */
  async load(page, query) {
    const { config } = this;
    await page.goto(this.searchUrl(query), {
      waitUntil: "domcontentloaded",
      timeout: config.browserOpTimeoutMs
    });

    await page.waitForSelector("body", { timeout: config.browserOpTimeoutMs }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await this.waitForAnySelector(page, this.resultSelectors, config.browserOpTimeoutMs);
  }

  async extract(page) {
    if (typeof this.extractPage !== "function") {
      throw new Error(`${this.id} does not define extractPage`);
    }
    return this.withNavigationRetry(() => this.extractViaEvaluate(page, this.extractPage));
  }

  async extractViaEvaluate(page, extractFn) {
    const payload = await page.evaluate(extractFn);
    const results = (payload?.results || []).map((item) => ({ ...item, engine: this.id }));
    // Zero results on a page that carries block markers is a bot wall, not an
    // empty search: throw so the route records a block and opens its breaker.
    if (!results.length) await this.assertNotBlocked(page);
    return {
      results,
      directAnswers: dedupeDirectAnswers(
        (payload?.directAnswers || []).map((item) => ({ ...item, engine: this.id, url: page.url() }))
      )
    };
  }

  /** Returns a block reason string when the page is a bot/CAPTCHA wall, else null. */
  async detectBlock(page) {
    const state = await page.evaluate(() => ({
      title: document.title || "",
      text: (document.body?.innerText || document.body?.textContent || "").slice(0, 20000),
      captchaWidget: Boolean(document.querySelector(
        "iframe[src*='captcha' i], [id*='captcha' i], [class*='captcha' i], form[action*='captcha' i]"
      ))
    }));
    const pageUrl = typeof page.url === "function" ? String(page.url() || "") : "";
    const haystack = `${state?.title || ""}\n${state?.text || ""}`;
    const { url: urlMarker, text: textMarker } = this.blockMarkers || {};
    const blocked =
      Boolean(state?.captchaWidget) ||
      /\/sorry\/|\/captcha/i.test(pageUrl) ||
      Boolean(urlMarker && urlMarker.test(pageUrl)) ||
      GENERIC_BLOCK_TEXT.test(haystack) ||
      Boolean(textMarker && textMarker.test(haystack));
    if (!blocked) return null;
    return `${this.label || this.id} blocked this request as automated traffic (CAPTCHA/verification page)`;
  }

  async assertNotBlocked(page) {
    const reason = await this.detectBlock(page);
    if (reason) throw new Error(reason);
  }

  async waitForAnySelector(page, selectors, timeout) {
    const deadline = Date.now() + timeout;
    const matched = await pollForSelector(page, selectors, deadline, () => this.assertNotBlocked(page));
    if (matched) return matched;
    await this.assertNotBlocked(page);
    throw new Error(`No result selector appeared on the page within ${Math.round(timeout / 1000)}s: ${selectors.join(", ")}`);
  }

  async withNavigationRetry(fn) {
    const deadline = Date.now() + (Number(this.config?.browserOpTimeoutMs) || 30000);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        const msg = String(error?.message || error);
        if (!RETRYABLE_NAVIGATION_ERROR.test(msg) || attempt >= NAVIGATION_RETRY_ATTEMPTS || Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, NAVIGATION_RETRY_DELAY_MS));
      }
    }
  }
}

/**
 * Poll until one of `selectors` exists. While nothing matches, `checkBlocked`
 * runs every ~1s so a bot wall fails fast instead of burning the whole timeout.
 */
async function pollForSelector(page, selectors, deadline, checkBlocked) {
  let lastError;
  let lastBlockCheck = 0;
  while (Date.now() < deadline) {
    try {
      const found = await page.evaluate((sels) => {
        for (const selector of sels) {
          if (document.querySelector(selector)) return selector;
        }
        return null;
      }, selectors);
      if (found) return found;
      if (Date.now() - lastBlockCheck >= 1000) {
        lastBlockCheck = Date.now();
        await checkBlocked();
      }
    } catch (error) {
      if (/blocked this request/.test(String(error?.message || ""))) throw error;
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (lastError) throw lastError;
  return null;
}
