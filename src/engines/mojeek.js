import { BrowserSearchDriver } from "./browser-driver.js";

const RESULT_SELECTORS = [".results-standard", ".results-standard li", ".serp-results", ".serp-results li", ".results", ".results li"];

const EXTRACT_PAGE = () => {
  const rows = Array.from(document.querySelectorAll(".results-standard li, .serp-results li, .results li"));
  const results = rows.map((row) => {
    const anchor = row.querySelector("h2 a.title") || row.querySelector("h2 a") || row.querySelector("a.title") || row.querySelector("a[href^='http']");
    const snippetEl = row.querySelector("p.s") || row.querySelector("p");

    return {
      title: anchor?.textContent || "",
      url: anchor?.href || "",
      snippet: snippetEl?.textContent || ""
    };
  }).filter(r => r.title && r.url);

  const directAnswers = Array.from(document.querySelectorAll(".infobox p"))
    .map((node) => ({
      source: "infobox",
      text: node?.textContent || ""
    }));

  return { results, directAnswers };
};

export class MojeekEngine extends BrowserSearchDriver {
  id = "mojeek";
  pool = "shared";
  homeUrl = "https://www.mojeek.com/";
  inputSelectors = ["input[name='q']", "input.js-search-input"];
  resultSelectors = RESULT_SELECTORS;

  searchUrl(query) {
    return `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`;
  }

  async assertNotBlocked(page) {
    const { title, text } = await page.evaluate(() => ({
      title: document.title || "",
      text: document.body?.innerText || document.body?.textContent || ""
    }));
    if (/403\s*-?\s*forbidden|automated queries|captcha|complete this challenge/i.test(`${title}\n${text}`)) {
      throw new Error("Mojeek blocked this request as automated traffic (CAPTCHA)");
    }
  }

  async extract(page) {
    return this.extractViaEvaluate(page, EXTRACT_PAGE);
  }
}
