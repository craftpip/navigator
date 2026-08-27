import { BrowserSearchDriver } from "./browser-driver.js";

const RESULT_SELECTORS = ["main .result", ".result", ".w-gl"];

const RETRYABLE_MSG =
  /Execution context was destroyed|Target closed|Cannot find context with specified id|Navigation timeout|timeout exceeded/i;

const EXTRACT_PAGE = () => {
  const rows = Array.from(document.querySelectorAll("main .result, .result, .w-gl")).filter((row) =>
    row.querySelector("a.result-link, a[href^='http']")
  );

  const results = rows.map((row) => {
    const anchor = row.querySelector("a.result-link") || row.querySelector("a[href^='http']");
    const heading = row.querySelector("h2.wgl-title") || row.querySelector("h2") || row.querySelector("h3");
    const snippetEl = row.querySelector("p.description") || row.querySelector("p");

    return {
      title: heading?.textContent || "",
      url: anchor?.href || "",
      snippet: snippetEl?.textContent || ""
    };
  }).filter(r => r.title && r.url);

  const directAnswers = Array.from(
    document.querySelectorAll('[data-testid="wiki qi see more container"]')
  ).map((node) => {
    const titleEl = node.querySelector(".headline a");
    const extractEl = node.querySelector(".extract");
    const text = [titleEl?.textContent, extractEl?.textContent].filter(Boolean).join("\n");
    return { source: "wiki_quick_info", text };
  });

  return { results, directAnswers };
};

export class StartpageEngine extends BrowserSearchDriver {
  id = "startpage";
  pool = "engine";
  homeUrl = "https://www.startpage.com/";
  inputSelectors = ["input#q", "input[name='query']"];
  resultSelectors = RESULT_SELECTORS;

  searchUrl(query) {
    return `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`;
  }

  async assertNotBlocked(page) {
    const { title, text } = await page.evaluate(() => ({
      title: document.title || "",
      text: document.body?.innerText || document.body?.textContent || ""
    }));
    if (/captcha|verify you are human|unusual traffic|access denied|blocked|robot challenge/i.test(`${title}\n${text}`)) {
      throw new Error("Startpage blocked this request as automated traffic (CAPTCHA)");
    }
  }

  async submit(page, query) {
    await this.withNavigationRetry(() => super.submit(page, query));
  }

  async extract(page) {
    return this.withNavigationRetry(() => this.extractViaEvaluate(page, EXTRACT_PAGE));
  }

  async withNavigationRetry(fn) {
    const deadline = Date.now() + this.config.browserOpTimeoutMs;
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (error) {
        const msg = String(error?.message || error);
        if (!RETRYABLE_MSG.test(msg) || attempt >= 2 || Date.now() > deadline) throw error;
        attempt += 1;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
}
