import { SearchEngineDriver } from "./driver.js";
import { dedupeDirectAnswers } from "./util.js";

export class BrowserSearchDriver extends SearchEngineDriver {
  backend = "chromium";
  async extractViaEvaluate(page, extractFn) {
    const payload = await page.evaluate(extractFn);
    return {
      results: (payload?.results || []).map((item) => ({ ...item, engine: this.id })),
      directAnswers: dedupeDirectAnswers(
        (payload?.directAnswers || []).map((item) => ({ ...item, engine: this.id, url: page.url() }))
      )
    };
  }

  async submit(page, query) {
    const { config } = this;
    await page.goto(this.searchUrl(query), {
      waitUntil: "domcontentloaded",
      timeout: config.browserOpTimeoutMs
    });

    await page.waitForSelector("body", { timeout: config.browserOpTimeoutMs }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await this.waitForAnySelector(page, this.resultSelectors, config.browserOpTimeoutMs);
  }

  async waitForAnySelector(page, selectors, timeout) {
    await this.assertNotBlocked(page);
    const deadline = Date.now() + timeout;
    const matched = await pollForSelector(page, selectors, deadline);
    if (matched) return matched;
    await this.assertNotBlocked(page);
    throw new Error(`No result selector appeared on the page within ${Math.round(timeout / 1000)}s: ${selectors.join(", ")}`);
  }
}

async function pollForSelector(page, selectors, deadline) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const found = await page.evaluate((sels) => {
        for (const selector of sels) {
          if (document.querySelector(selector)) return selector;
        }
        return null;
      }, selectors);
      if (found) return found;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (lastError) throw lastError;
  return null;
}
