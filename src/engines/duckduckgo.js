import { BrowserSearchDriver } from "./browser-driver.js";

const INPUT_SELECTOR = "textarea[name='q'], input[name='q'], textarea#searchbox_input, input#searchbox_input, input[data-testid='searchbox-input']";
const FORM_SUBMIT_SELECTOR = "textarea[name='q'], input[name='q'], textarea#searchbox_input, input#searchbox_input, input[data-testid='searchbox-input']";
const RESULT_SELECTORS = [
  "article[data-testid='result']",
  "#links .result",
  ".results .result",
  ".result",
  "#search_results"
];

const EXTRACT_PAGE = () => {
  const rows = Array.from(document.querySelectorAll("article[data-testid='result'], .result"));
  const results = rows.map((row) => {
    const anchor = row.querySelector("a[data-testid='result-title-a'], h2 a, a.result__a");
    const snippetEl = row.querySelector(
      "[data-result='snippet'], .result__snippet, .result-snippet"
    );
    return {
      title: anchor?.textContent || "",
      url: anchor?.href || "",
      snippet: snippetEl?.textContent || ""
    };
  }).filter(r => r.title && r.url);

  const answerNodes = [
    ...document.querySelectorAll("[data-testid='instant-answer']"),
    ...document.querySelectorAll(".zci__answer, .zci__result, .module__body")
  ];
  const directAnswers = answerNodes.map((node) => ({
    source: "instant_answer",
    text: node?.textContent || ""
  }));

  return { results, directAnswers };
};

export class DuckDuckGoEngine extends BrowserSearchDriver {
  id = "duckduckgo";
  pool = "engine";
  homeUrl = "https://duckduckgo.com/";
  inputSelectors = [INPUT_SELECTOR];
  resultSelectors = RESULT_SELECTORS;
  extractPage = EXTRACT_PAGE;
  label = "DuckDuckGo";
  blockMarkers = { text: /anomaly-modal|puzzl|isn(?:'|’)t quite right/i };

  searchUrl(_query) {
    return "https://duckduckgo.com/";
  }

  async load(page, query) {
    const { config } = this;
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;

    // Try form-based submission first (more natural, less likely bot-detected)
    try {
      await page.goto(this.searchUrl(query), {
        waitUntil: "domcontentloaded",
        timeout: config.browserOpTimeoutMs
      });

      await page.waitForSelector(FORM_SUBMIT_SELECTOR, {
        timeout: Math.min(config.browserOpTimeoutMs, 8000)
      });
      await page.evaluate((q, inputSelector) => {
        const input = document.querySelector(inputSelector);
        if (input) {
          input.value = q;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          const form = input.closest("form");
          if (form) form.submit();
        }
      }, query, FORM_SUBMIT_SELECTOR);
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: config.browserOpTimeoutMs }).catch(() => {});
    } catch {
      // Fallback: navigate directly to search URL
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.browserOpTimeoutMs
      });
    }

    await this.waitForAnySelector(page, this.resultSelectors, config.browserOpTimeoutMs);
  }
}
