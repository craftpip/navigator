import { BrowserSearchDriver } from "./browser-driver.js";

const RESULT_SELECTORS = ["#b_results", "#b_results li.b_algo"];

const EXTRACT_PAGE = () => {
  const rows = Array.from(document.querySelectorAll("#b_results li.b_algo, #b_results > li"));
  const results = rows.map((row) => {
    const anchor = row.querySelector("h2 a") || row.querySelector("a[href^='http']");
    const snippetEl =
      row.querySelector(".b_caption p") || row.querySelector(".b_snippet") || row.querySelector("p");

    return {
      title: anchor?.textContent || "",
      url: anchor?.href || "",
      snippet: snippetEl?.textContent || ""
    };
  }).filter(r => r.title && r.url);

  const answerNodes = [
    ...document.querySelectorAll(".b_ans .b_focusTextLarge, .b_ans .b_paractl, .b_ans .b_snippet"),
    ...document.querySelectorAll("#b_results .b_entityTP .b_snippet")
  ];
  const directAnswers = answerNodes.map((node) => ({
    source: "direct_answer",
    text: node?.textContent || ""
  }));

  return { results, directAnswers };
};

export class BingEngine extends BrowserSearchDriver {
  id = "bing";
  pool = "shared";
  homeUrl = "https://www.bing.com/";
  inputSelectors = ["textarea[name='q']", "input[name='q']", "input#sb_form_q"];
  resultSelectors = RESULT_SELECTORS;

  searchUrl(query) {
    return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  }

  async assertNotBlocked(page) {
    const text = await page.evaluate(() => document.body?.innerText || document.body?.textContent || "");
    const pageUrl = page.url();

    if (/captcha|unusual traffic|verify you(?:'|’)?re a human|are you( a)? human/i.test(text) || /\/sorry\//.test(pageUrl)) {
      throw new Error("Bing blocked this request with a CAPTCHA/verification page");
    }
  }

  async extract(page) {
    return this.extractViaEvaluate(page, EXTRACT_PAGE);
  }
}
